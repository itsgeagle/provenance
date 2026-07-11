import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureUsedBytes } from './usage.js';

describe('measureUsedBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prov-usage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 0 for an empty directory', async () => {
    expect(await measureUsedBytes(dir)).toBe(0);
  });

  it('sums the sizes of files directly under the root', async () => {
    await writeFile(join(dir, 'a.blob'), Buffer.alloc(100));
    await writeFile(join(dir, 'b.blob'), Buffer.alloc(200));
    expect(await measureUsedBytes(dir)).toBe(300);
  });

  it('recurses into nested subdirectories', async () => {
    await mkdir(join(dir, 'sub', 'deep'), { recursive: true });
    await writeFile(join(dir, 'top.blob'), Buffer.alloc(10));
    await writeFile(join(dir, 'sub', 'mid.blob'), Buffer.alloc(20));
    await writeFile(join(dir, 'sub', 'deep', 'leaf.blob'), Buffer.alloc(30));
    expect(await measureUsedBytes(dir)).toBe(60);
  });

  // The whole point of the fix: on a shared NFS mount, measurement must count
  // only Provenance's own subtree, not the entire filesystem. A sibling file
  // outside `root` (another tenant's data) must not be counted.
  it('excludes files outside the root', async () => {
    const sibling = await mkdtemp(join(tmpdir(), 'prov-other-tenant-'));
    try {
      await writeFile(join(sibling, 'huge.dat'), Buffer.alloc(5000));
      await writeFile(join(dir, 'mine.blob'), Buffer.alloc(42));
      expect(await measureUsedBytes(dir)).toBe(42);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('counts sibling Provenance dirs under the root (backups, .uploads)', async () => {
    // backups/ (pg-dump) and .uploads/ (multipart staging) live under the blob
    // root and are genuine Provenance footprint on the mount, so they count.
    await mkdir(join(dir, 'backups'), { recursive: true });
    await mkdir(join(dir, '.uploads'), { recursive: true });
    await writeFile(join(dir, 'blob'), Buffer.alloc(1));
    await writeFile(join(dir, 'backups', 'dump.sql'), Buffer.alloc(2));
    await writeFile(join(dir, '.uploads', 'part'), Buffer.alloc(4));
    expect(await measureUsedBytes(dir)).toBe(7);
  });
});
