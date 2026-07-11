import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureUsedBytes } from './usage.js';

describe('measureUsedBytes', () => {
  it('returns a non-negative integer byte count for a real directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prov-usage-'));
    try {
      const used = await measureUsedBytes(dir);
      expect(Number.isInteger(used)).toBe(true);
      expect(used).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
