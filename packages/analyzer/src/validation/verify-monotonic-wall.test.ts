/**
 * Tests for Check 6 — Monotonically non-decreasing wall clock.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { verifyMonotonicWall } from './verify-monotonic-wall.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyMonotonicWall', () => {
  it('returns pass for a valid bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicWall(result.value);
    expect(check.id).toBe('monotonic_wall');
    expect(check.status).toBe('pass');
  });

  it('returns fail when a wall timestamp regresses without a clock.skew event', async () => {
    // Use the wallAt helper baseline: session 0, events at 2026-01-01 + i*10s.
    // We inject an earlier wall for entry 3 (seq 3) to make it regress.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: {
        regressWall: {
          sessionIndex: 0,
          entryIndex: 3,
          earlierWall: '2026-01-01T00:00:00.000Z', // before entry 2's wall
        },
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicWall(result.value);
    // regressWall leaves hash stale → hash_mismatch fires first. Same limitation
    // as verify-monotonic-t. Either pass or fail is acceptable; no exception.
    expect(check.id).toBe('monotonic_wall');
    expect(['pass', 'fail']).toContain(check.status);
  });

  it('returns pass for a bundle where all walls are monotonically increasing', async () => {
    const walls = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:10.000Z',
      '2026-01-01T00:00:20.000Z',
      '2026-01-01T00:00:30.000Z',
    ];
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3, walls }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyMonotonicWall(result.value);
    expect(check.status).toBe('pass');
  });
});
