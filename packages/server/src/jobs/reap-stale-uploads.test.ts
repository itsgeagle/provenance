import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapStaleUploads } from '../services/storage/fs-multipart.js';
import { stagingRootPath } from '../services/storage/fs-multipart.js';
import type { StorageClient } from '../services/storage/client.js';

async function fsClientWithStaging(
  dirs: { id: string; createdAt: string }[],
): Promise<Extract<StorageClient, { kind: 'fs' }>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-reap-'));
  for (const d of dirs) {
    const dir = join(stagingRootPath(rootDir), d.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ key: 'k', createdAt: d.createdAt }));
  }
  return { kind: 'fs', rootDir, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' };
}

const NOW = Date.parse('2026-07-10T12:00:00Z');
const DAY = 86400 * 1000;

describe('reapStaleUploads', () => {
  it('reaps dirs older than maxAge and keeps fresh ones', async () => {
    const c = await fsClientWithStaging([
      { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-07-08T12:00:00Z' }, // 2d old
      { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-07-10T11:59:00Z' }, // 1m old
    ]);
    try {
      const res = await reapStaleUploads(c, { now: NOW, maxAgeMs: DAY });
      expect(res).toEqual({ reaped: 1, errors: 0 });
      const remaining = await readdir(stagingRootPath(c.rootDir));
      expect(remaining).toEqual(['22222222-2222-4222-8222-222222222222']);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('is a no-op for the s3 backend', async () => {
    const s3: StorageClient = { kind: 's3', aws: {} as never, bucketUrl: 'http://b' };
    expect(await reapStaleUploads(s3, { now: NOW, maxAgeMs: DAY })).toEqual({
      reaped: 0,
      errors: 0,
    });
  });

  it('returns zero when no staging root exists', async () => {
    const c = await mkdtemp(join(tmpdir(), 'prov-reap-empty-'));
    const client: StorageClient = {
      kind: 'fs',
      rootDir: c,
      signingSecret: 's'.repeat(32),
      publicBaseUrl: 'http://x',
    };
    try {
      expect(await reapStaleUploads(client, { now: NOW, maxAgeMs: DAY })).toEqual({
        reaped: 0,
        errors: 0,
      });
    } finally {
      await rm(c, { recursive: true, force: true });
    }
  });
});
