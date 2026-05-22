/**
 * Phase 3 of the per-file ingest pipeline: parse bundle (PRD §9.3).
 *
 * Reads the staged blob from object storage and parses it via the analyzer's
 * `loadBundle` function (which delegates to log-core). Returns the parsed
 * Bundle on success or a structured error on failure.
 *
 * This is the server-side wrapper around the loader. It does NOT materialize
 * events (Phase 10) — it only parses enough to extract the manifest and
 * session metadata needed by later pipeline phases (matchStudent,
 * createSubmission).
 *
 * Design: the function returns a discriminated result rather than throwing.
 * The worker catches the error and marks `ingest_files.status='failed'` with
 * `error: { phase: 'parse_bundle', cause, detail? }`.
 */

import { getBlob } from '../storage/blobs.js';
import type { StorageClient } from '../storage/client.js';
import { loadBundle } from '@provenance/analyzer/src/loader/parse-bundle.js';
import type { Bundle } from '@provenance/analyzer/src/loader/types.js';
import type { LoaderError, SessionParseError } from '@provenance/analyzer/src/loader/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParseBundlePhaseSuccess = {
  ok: true;
  bundle: Bundle;
};

export type ParseBundlePhaseError = {
  ok: false;
  phase: 'parse_bundle';
  cause: string;
  detail?: string | undefined;
};

export type ParseBundlePhaseResult = ParseBundlePhaseSuccess | ParseBundlePhaseError;

// ---------------------------------------------------------------------------
// parseBundlePhase
// ---------------------------------------------------------------------------

/**
 * Read a staged blob from object storage and parse it as a bundle ZIP.
 *
 * Returns `{ ok: true, bundle }` on success.
 * Returns `{ ok: false, phase, cause, detail? }` on any failure — the worker
 * maps this to `ingest_files.status='failed'` with the structured error.
 *
 * Errors caught here:
 *   - Object-storage retrieval failures (network / auth / missing key).
 *   - Any loader error (not_a_zip, missing_manifest, invalid_manifest,
 *     ndjson_parse_failed, etc.).
 *
 * The function does NOT propagate throws — all failures surface as the error
 * variant of the discriminated result.
 */
export async function parseBundlePhase(
  storageClient: StorageClient,
  blobKey: string,
  originalFilename: string,
): Promise<ParseBundlePhaseResult> {
  // -------------------------------------------------------------------------
  // Step 1: Read blob from object storage.
  // -------------------------------------------------------------------------
  let blobStream: ReadableStream<Uint8Array>;
  try {
    blobStream = await getBlob(storageClient, blobKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, phase: 'parse_bundle', cause: 'blob_read_failed', detail };
  }

  // Buffer the stream into an ArrayBuffer so we can pass it to loadBundle.
  let blobBuffer: ArrayBuffer;
  try {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = blobStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    blobBuffer = combined.buffer as ArrayBuffer;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, phase: 'parse_bundle', cause: 'blob_read_failed', detail };
  }

  // -------------------------------------------------------------------------
  // Step 2: Parse via analyzer loader.
  // -------------------------------------------------------------------------
  let parseResult: Awaited<ReturnType<typeof loadBundle>>;
  try {
    parseResult = await loadBundle(blobBuffer, originalFilename);
  } catch (err) {
    // loadBundle should not throw for valid inputs; if it does it's a bug.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, phase: 'parse_bundle', cause: 'loader_threw', detail };
  }

  if (!parseResult.ok) {
    const detail = errorDetail(parseResult.error);
    const errResult: ParseBundlePhaseError = {
      ok: false,
      phase: 'parse_bundle',
      cause: parseResult.error.kind,
      ...(detail !== undefined && { detail }),
    };
    return errResult;
  }

  return { ok: true, bundle: parseResult.value };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function errorDetail(error: LoaderError | SessionParseError): string | undefined {
  // Surface any human-readable detail stored on the error variants.
  const e = error as Record<string, unknown>;

  // Loader errors.
  if (typeof e['detail'] === 'string') return e['detail'];

  // SessionParseError variants.
  if (typeof e['line'] === 'number') {
    return `line ${String(e['line'])}${typeof e['detail'] === 'string' ? `: ${e['detail']}` : ''}`;
  }
  if (typeof e['actualKind'] === 'string') return `actualKind: ${e['actualKind']}`;
  if (typeof e['slogSessionId'] === 'string' && typeof e['metaSessionId'] === 'string') {
    return `slog=${e['slogSessionId']} meta=${e['metaSessionId']}`;
  }
  if (typeof e['sessionId'] === 'string') return `sessionId: ${e['sessionId']}`;

  return undefined;
}
