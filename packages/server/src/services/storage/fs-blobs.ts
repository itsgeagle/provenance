/**
 * Filesystem blob operations — the `fs` backend counterpart to blobs.ts.
 *
 * Blobs are ordinary files under `rootDir`, addressed by the same keys keys.ts
 * produces. Writes are atomic (temp-then-rename). `resolveKeyPath` is the single
 * safety gate: it rejects any key that escapes `rootDir` or reaches into the
 * reserved multipart staging tree.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, resolve, sep } from 'node:path';
import type { StorageClient } from './client.js';
import type { PutBlobResult } from './blobs.js';

type FsClient = Extract<StorageClient, { kind: 'fs' }>;

/** Reserved subdirectory of rootDir used for multipart part staging (Task 4). */
export const FS_STAGING_DIR = '.uploads';

/**
 * Map a storage key to an absolute on-disk path, rejecting traversal.
 * Rejects keys that escape `rootDir` or target the reserved staging tree.
 */
export function resolveKeyPath(rootDir: string, key: string): string {
  const root = resolve(rootDir);
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`fs storage: key "${key}" escapes storage root`);
  }
  const rel = full.slice(root.length + 1);
  if (rel === FS_STAGING_DIR || rel.startsWith(FS_STAGING_DIR + sep)) {
    throw new Error(`fs storage: key "${key}" targets reserved staging area`);
  }
  return full;
}

export async function fsPutBlob(
  client: FsClient,
  key: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
): Promise<PutBlobResult> {
  const path = resolveKeyPath(client.rootDir, key);
  const hasher = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      size += value.byteLength;
      chunks.push(value);
    }
  } else {
    const b = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    hasher.update(b);
    size = b.byteLength;
    chunks.push(b);
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  const sha256 = hasher.digest('hex');

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, combined);
  await rename(tmp, path);
  return { sha256, size };
}

export async function fsGetBlob(
  client: FsClient,
  key: string,
): Promise<ReadableStream<Uint8Array>> {
  const path = resolveKeyPath(client.rootDir, key);
  // stat first so a missing file throws synchronously (matches S3 throw-on-404).
  await stat(path);
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
}

export async function fsDeleteBlob(client: FsClient, key: string): Promise<void> {
  const path = resolveKeyPath(client.rootDir, key);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

