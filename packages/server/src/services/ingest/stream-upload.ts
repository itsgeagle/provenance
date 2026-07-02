/**
 * Stream a multipart upload's single file field straight to a temp file on disk,
 * without ever buffering the whole body in memory.
 *
 * The HTTP ingest route otherwise relies on `c.req.parseBody()` → Node's
 * FormData/undici parser, which concatenates the entire request body into one
 * contiguous in-memory buffer and trips a ~2 GiB allocation ceiling. Piping the
 * raw request through busboy and writing the file part to a temp file removes
 * that ceiling: the upload is bounded by disk, not heap, so multi-GB / 10 GB+
 * exports can be ingested via the same HTTP endpoint and then read by the
 * streaming (yauzl) reader.
 *
 * The caller is responsible for deleting the temp file (use the returned
 * `cleanup()` in a finally) once ingest is done.
 */

import busboy from 'busboy';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

export type StreamUploadResult =
  | { ok: true; path: string; bytes: number; cleanup: () => Promise<void> }
  | { ok: false; error: 'missing_file' | 'too_large' | 'malformed'; detail: string };

export interface StreamUploadOptions {
  /** Multipart field name to capture (e.g. 'archive'). */
  fieldName: string;
  /** Reject (and clean up) once the captured file exceeds this many bytes. */
  maxBytes: number;
  /** Web Headers of the request (for the multipart boundary). */
  headers: Headers;
  /** Web ReadableStream of the request body. */
  body: ReadableStream<Uint8Array>;
}

/**
 * Consume a multipart/form-data request, writing the first file in `fieldName`
 * to a temp file. Resolves with the temp path and byte count, or a discriminated
 * error (missing file, over size limit, or a malformed body).
 */
export async function streamUploadToTempFile(
  opts: StreamUploadOptions,
): Promise<StreamUploadResult> {
  const { fieldName, maxBytes, headers, body } = opts;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'prov-upload-'));
  const filePath = path.join(dir, 'upload.bin');
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  // busboy wants a plain header object; Headers iterates as lowercased entries.
  const headerObj: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerObj[key] = value;
  });

  const contentType = headerObj['content-type'] ?? '';
  if (!contentType.includes('multipart/form-data')) {
    await cleanup();
    return { ok: false, error: 'malformed', detail: 'expected multipart/form-data body' };
  }

  const nodeReq = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);

  return await new Promise<StreamUploadResult>((resolve) => {
    let settled = false;
    let bytes = 0;
    let sawFile = false;
    let tooLarge = false;
    // The file is piped to disk asynchronously; busboy 'close' can fire before
    // the write stream has flushed, so we must await this before resolving ok.
    let writeDone: Promise<void> | null = null;

    const finish = (result: StreamUploadResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: headerObj, limits: { files: 1, fileSize: maxBytes } });
    } catch (e) {
      void cleanup().then(() =>
        finish({
          ok: false,
          error: 'malformed',
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
      return;
    }

    bb.on('file', (name, fileStream, _info) => {
      if (name !== fieldName) {
        fileStream.resume(); // drain & ignore other file fields
        return;
      }
      sawFile = true;
      const out = createWriteStream(filePath);
      fileStream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      // busboy emits 'limit' on the file stream when fileSize is exceeded.
      fileStream.on('limit', () => {
        tooLarge = true;
      });
      writeDone = pipeline(fileStream, out);
    });

    bb.on('error', (e: unknown) => {
      void cleanup().then(() =>
        finish({
          ok: false,
          error: 'malformed',
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    });

    bb.on('close', () => {
      if (tooLarge) {
        void cleanup().then(() =>
          finish({ ok: false, error: 'too_large', detail: `upload exceeds ${maxBytes} bytes` }),
        );
        return;
      }
      if (!sawFile || writeDone === null) {
        void cleanup().then(() =>
          finish({ ok: false, error: 'missing_file', detail: `no '${fieldName}' file field` }),
        );
        return;
      }
      // Wait for the write stream to flush before reporting success.
      writeDone.then(
        () => finish({ ok: true, path: filePath, bytes, cleanup }),
        (e: unknown) =>
          void cleanup().then(() =>
            finish({
              ok: false,
              error: 'malformed',
              detail: e instanceof Error ? e.message : String(e),
            }),
          ),
      );
    });

    nodeReq.on('error', (e: unknown) => {
      void cleanup().then(() =>
        finish({
          ok: false,
          error: 'malformed',
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    });

    nodeReq.pipe(bb);
  });
}
