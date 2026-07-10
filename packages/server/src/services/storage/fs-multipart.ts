/**
 * Filesystem multipart upload — the `fs` backend counterpart to multipart.ts.
 *
 * Parts stage under `<rootDir>/.uploads/<uploadId>/<partNumber>.part`, with a
 * `meta.json` recording the key + createdAt. `resolveKeyPath` excludes `.uploads`,
 * so staging never collides with stored bundles. `complete` concatenates parts in
 * partNumber order into the final key (atomic rename). `reapStaleUploads` reclaims
 * staging dirs abandoned by a crashed upload.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import type { StorageClient } from './client.js';
import type { UploadedPart } from './multipart.js';
import { FS_STAGING_DIR, resolveKeyPath } from './fs-blobs.js';

type FsClient = Extract<StorageClient, { kind: 'fs' }>;

/** Absolute path of the reserved staging root under a storage root. */
export function stagingRootPath(rootDir: string): string {
  return join(resolve(rootDir), FS_STAGING_DIR);
}

/** uploadId is a server-generated UUID; reject anything else defensively. */
function stagingDir(rootDir: string, uploadId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    throw new Error(`fs multipart: invalid uploadId`);
  }
  return join(stagingRootPath(rootDir), uploadId);
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

export async function fsCreateMultipartUpload(client: FsClient, key: string): Promise<string> {
  const uploadId = randomUUID();
  const dir = stagingDir(client.rootDir, uploadId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({ key, createdAt: new Date().toISOString() }),
  );
  return uploadId;
}

export async function fsUploadPart(
  client: FsClient,
  _key: string,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer | Uint8Array,
): Promise<string> {
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    throw new Error(`fs multipart: invalid partNumber ${partNumber}`);
  }
  const dir = stagingDir(client.rootDir, uploadId);
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const dest = join(dir, `${partNumber}.part`);
  const tmp = `${dest}.tmp-${randomUUID()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, dest);
  return etagOf(bytes);
}

export async function fsListParts(
  client: FsClient,
  _key: string,
  uploadId: string,
): Promise<UploadedPart[]> {
  const dir = stagingDir(client.rootDir, uploadId);
  const entries = await readdir(dir);
  const parts: UploadedPart[] = [];
  for (const name of entries) {
    const m = /^(\d+)\.part$/.exec(name);
    if (!m) continue;
    const buf = await readFile(join(dir, name));
    parts.push({ partNumber: parseInt(m[1]!, 10), etag: etagOf(buf), size: buf.byteLength });
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

export async function fsCompleteMultipartUpload(
  client: FsClient,
  key: string,
  uploadId: string,
  parts: UploadedPart[],
): Promise<void> {
  const dir = stagingDir(client.rootDir, uploadId);
  const finalPath = resolveKeyPath(client.rootDir, key);
  await mkdir(dirname(finalPath), { recursive: true });

  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const tmp = `${finalPath}.tmp-${randomUUID()}`;
  const out = createWriteStream(tmp);
  try {
    for (const p of sorted) {
      await pipeline(createReadStream(join(dir, `${p.partNumber}.part`)), out, { end: false });
    }
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    await rm(tmp, { force: true });
    throw err;
  }
  await rename(tmp, finalPath);
  await rm(dir, { recursive: true, force: true });
}

export async function fsAbortMultipartUpload(
  client: FsClient,
  _key: string,
  uploadId: string,
): Promise<void> {
  const dir = stagingDir(client.rootDir, uploadId);
  await rm(dir, { recursive: true, force: true }); // idempotent
}

/**
 * Reclaim staging dirs older than `maxAgeMs`. No-op unless the client is fs.
 * Clock is injected (`now`, epoch ms) so it is deterministically testable.
 */
export async function reapStaleUploads(
  client: StorageClient,
  opts: { now: number; maxAgeMs: number },
): Promise<{ reaped: number; errors: number }> {
  if (client.kind !== 'fs') return { reaped: 0, errors: 0 };
  const base = stagingRootPath(client.rootDir);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { reaped: 0, errors: 0 };
    throw err;
  }

  let reaped = 0;
  let errors = 0;
  for (const name of entries) {
    const dir = join(base, name);
    try {
      let createdAtMs: number;
      try {
        const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as {
          createdAt?: string;
        };
        createdAtMs = meta.createdAt ? Date.parse(meta.createdAt) : NaN;
        if (Number.isNaN(createdAtMs)) throw new Error('bad createdAt');
      } catch {
        createdAtMs = (await stat(dir)).mtimeMs;
      }
      if (opts.now - createdAtMs > opts.maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        reaped += 1;
      }
    } catch {
      errors += 1;
    }
  }
  return { reaped, errors };
}
