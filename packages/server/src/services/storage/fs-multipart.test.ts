import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fsCreateMultipartUpload, fsUploadPart, fsListParts,
  fsCompleteMultipartUpload, fsAbortMultipartUpload, stagingRootPath,
} from './fs-multipart.js';
import { fsGetBlob } from './fs-blobs.js';
import type { StorageClient } from './client.js';

async function tmpClient(): Promise<Extract<StorageClient, { kind: 'fs' }>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-mp-'));
  return { kind: 'fs', rootDir, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' };
}
function bytes(n: number, fill: number): Uint8Array { const b = new Uint8Array(n); b.fill(fill); return b; }
async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; const r = s.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('fs multipart round-trip', () => {
  it('assembles parts in partNumber order regardless of upload order', async () => {
    const c = await tmpClient();
    try {
      const key = 'ingest-uploads/sem/u.zip';
      const uploadId = await fsCreateMultipartUpload(c, key);
      // Upload out of order: part 2 then part 1.
      const p2 = bytes(8, 0x22);
      const p1 = bytes(8, 0x11);
      const e2 = await fsUploadPart(c, key, uploadId, 2, p2);
      const e1 = await fsUploadPart(c, key, uploadId, 1, p1);
      const parts = await fsListParts(c, key, uploadId);
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(parts[0]!.size).toBe(8);
      await fsCompleteMultipartUpload(c, key, uploadId, [
        { partNumber: 1, etag: e1, size: 8 },
        { partNumber: 2, etag: e2, size: 8 },
      ]);
      const got = await collect(await fsGetBlob(c, key));
      const expected = new Uint8Array(16); expected.set(p1, 0); expected.set(p2, 8);
      expect(got).toEqual(expected);
      // Staging removed after complete.
      expect(await exists(join(stagingRootPath(c.rootDir), uploadId))).toBe(false);
    } finally { await rm(c.rootDir, { recursive: true, force: true }); }
  });

  it('listParts drives resume (only missing parts remain to send)', async () => {
    const c = await tmpClient();
    try {
      const key = 'k.zip';
      const uploadId = await fsCreateMultipartUpload(c, key);
      await fsUploadPart(c, key, uploadId, 1, bytes(4, 1));
      await fsUploadPart(c, key, uploadId, 3, bytes(4, 3));
      const have = new Set((await fsListParts(c, key, uploadId)).map((p) => p.partNumber));
      const missing = [1, 2, 3].filter((n) => !have.has(n));
      expect(missing).toEqual([2]);
    } finally { await rm(c.rootDir, { recursive: true, force: true }); }
  });

  it('sorts a COPY of the parts arg: descending arg still assembles ascending, arg unmutated', async () => {
    const c = await tmpClient();
    try {
      const key = 'out.zip';
      const uploadId = await fsCreateMultipartUpload(c, key);
      const p1 = bytes(8, 0x11);
      const p2 = bytes(8, 0x22);
      const e1 = await fsUploadPart(c, key, uploadId, 1, p1);
      const e2 = await fsUploadPart(c, key, uploadId, 2, p2);
      // Hand the parts array in DESCENDING order — exercises the internal
      // `[...parts].sort(...)`, which must sort a copy and assemble ascending.
      const parts = [
        { partNumber: 2, etag: e2, size: 8 },
        { partNumber: 1, etag: e1, size: 8 },
      ];
      await fsCompleteMultipartUpload(c, key, uploadId, parts);
      const got = await collect(await fsGetBlob(c, key));
      const expected = new Uint8Array(16); expected.set(p1, 0); expected.set(p2, 8);
      expect(got).toEqual(expected);
      // The caller's array must be untouched (proves the sort copied first).
      expect(parts.map((p) => p.partNumber)).toEqual([2, 1]);
    } finally { await rm(c.rootDir, { recursive: true, force: true }); }
  });

  it('mid-assembly error leaves no final blob and no leftover .tmp- file', async () => {
    const c = await tmpClient();
    try {
      const key = 'out.zip';
      const uploadId = await fsCreateMultipartUpload(c, key);
      const e1 = await fsUploadPart(c, key, uploadId, 1, bytes(8, 0x11));
      // Reference a part whose `.part` file does not exist → read stream errors
      // mid-assembly, triggering the destroy-stream + rm-tmp cleanup path.
      await expect(
        fsCompleteMultipartUpload(c, key, uploadId, [
          { partNumber: 1, etag: e1, size: 8 },
          { partNumber: 99, etag: '"x"', size: 1 },
        ]),
      ).rejects.toThrow();
      // (b) No final blob at the destination key.
      await expect(fsGetBlob(c, key)).rejects.toThrow();
      // (c) No leftover `.tmp-` file in the destination's parent dir (rootDir).
      const siblings = await readdir(c.rootDir);
      expect(siblings.filter((n) => n.includes('.tmp-'))).toEqual([]);
    } finally { await rm(c.rootDir, { recursive: true, force: true }); }
  });

  it('abort removes the staging dir and is idempotent', async () => {
    const c = await tmpClient();
    try {
      const uploadId = await fsCreateMultipartUpload(c, 'k.zip');
      await fsUploadPart(c, 'k.zip', uploadId, 1, bytes(4, 1));
      await fsAbortMultipartUpload(c, 'k.zip', uploadId);
      expect(await exists(join(stagingRootPath(c.rootDir), uploadId))).toBe(false);
      await expect(fsAbortMultipartUpload(c, 'k.zip', uploadId)).resolves.toBeUndefined();
    } finally { await rm(c.rootDir, { recursive: true, force: true }); }
  });
});
