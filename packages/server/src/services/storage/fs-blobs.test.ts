import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveKeyPath, fsPutBlob, fsGetBlob, fsDeleteBlob, FS_STAGING_DIR } from './fs-blobs.js';
import { signBlobUrl, verifyBlobUrl, fsPresignGetUrl } from './fs-blobs.js';
import type { StorageClient } from './client.js';

async function tmpClient(): Promise<Extract<StorageClient, { kind: 'fs' }>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-fs-'));
  return { kind: 'fs', rootDir, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' };
}
function bytes(n: number, fill = 0x42): Uint8Array {
  const b = new Uint8Array(n);
  b.fill(fill);
  return b;
}
function sha(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

describe('resolveKeyPath', () => {
  it('rejects .. traversal', () => {
    expect(() => resolveKeyPath('/root', '../etc/passwd')).toThrow(/escapes/);
  });
  it('rejects absolute keys that escape', () => {
    expect(() => resolveKeyPath('/root', '/etc/passwd')).toThrow(/escapes/);
  });
  it('rejects reach into reserved staging dir', () => {
    expect(() => resolveKeyPath('/root', `${FS_STAGING_DIR}/x`)).toThrow(/staging/);
  });
  it('accepts a normal bundle key', () => {
    expect(resolveKeyPath('/root', 'semesters/a/submissions/b/bundle.zip')).toBe(
      '/root/semesters/a/submissions/b/bundle.zip',
    );
  });
});

describe('fsPutBlob / fsGetBlob', () => {
  it('round-trips a Uint8Array and reports sha256 + size', async () => {
    const c = await tmpClient();
    try {
      const data = bytes(1000);
      const res = await fsPutBlob(c, 'semesters/a/submissions/b/bundle.zip', data);
      expect(res.size).toBe(1000);
      expect(res.sha256).toBe(sha(data));
      const got = await collect(await fsGetBlob(c, 'semesters/a/submissions/b/bundle.zip'));
      expect(got).toEqual(data);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('hashes a ReadableStream body correctly', async () => {
    const c = await tmpClient();
    try {
      const data = bytes(2048, 0x7);
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(data);
          ctrl.close();
        },
      });
      const res = await fsPutBlob(c, 'k/x.zip', stream);
      expect(res.sha256).toBe(sha(data));
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('leaves no .tmp- file behind after a successful put', async () => {
    const c = await tmpClient();
    try {
      await fsPutBlob(c, 'flat.zip', bytes(10));
      const names = await readdir(c.rootDir);
      expect(names.some((n) => n.includes('.tmp-'))).toBe(false);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('throws when getting a missing key', async () => {
    const c = await tmpClient();
    try {
      await expect(fsGetBlob(c, 'nope.zip')).rejects.toThrow();
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });
});

describe('fsDeleteBlob', () => {
  it('deletes an existing blob', async () => {
    const c = await tmpClient();
    try {
      await fsPutBlob(c, 'del.zip', bytes(4));
      await fsDeleteBlob(c, 'del.zip');
      await expect(fsGetBlob(c, 'del.zip')).rejects.toThrow();
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });
  it('is idempotent on a missing blob', async () => {
    const c = await tmpClient();
    try {
      await expect(fsDeleteBlob(c, 'ghost.zip')).resolves.toBeUndefined();
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });
});

describe('signBlobUrl / verifyBlobUrl', () => {
  const secret = 'k'.repeat(32);
  it('verifies a freshly signed token', () => {
    const { d, s } = signBlobUrl(secret, 'a/b.zip', 2000);
    const res = verifyBlobUrl(secret, d, s, 1000);
    expect(res).toEqual({ ok: true, key: 'a/b.zip' });
  });
  it('rejects an expired token', () => {
    const { d, s } = signBlobUrl(secret, 'a/b.zip', 1000);
    expect(verifyBlobUrl(secret, d, s, 1000)).toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects a tampered payload', () => {
    const { s } = signBlobUrl(secret, 'a/b.zip', 2000);
    const forged = Buffer.from(JSON.stringify({ k: 'other.zip', e: 2000 })).toString('base64url');
    expect(verifyBlobUrl(secret, forged, s, 1000)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('rejects a wrong secret', () => {
    const { d, s } = signBlobUrl(secret, 'a/b.zip', 2000);
    expect(verifyBlobUrl('w'.repeat(32), d, s, 1000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
  it('rejects garbage signature without throwing', () => {
    const { d } = signBlobUrl(secret, 'a/b.zip', 2000);
    expect(verifyBlobUrl(secret, d, '!!!not-base64!!!', 1000).ok).toBe(false);
  });
});

describe('fsPresignGetUrl', () => {
  it('builds a PUBLIC_BASE_URL-rooted /api/v1/blob URL', async () => {
    const c: Extract<StorageClient, { kind: 'fs' }> = {
      kind: 'fs',
      rootDir: '/x',
      signingSecret: 'k'.repeat(32),
      publicBaseUrl: 'http://host:3000',
    };
    const url = await fsPresignGetUrl(c, 'a/b.zip', 300);
    expect(url.startsWith('http://host:3000/api/v1/blob?d=')).toBe(true);
    expect(url).toContain('&s=');
  });
});
