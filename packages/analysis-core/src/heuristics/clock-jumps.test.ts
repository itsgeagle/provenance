/**
 * Tests for the clock_jumps heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { clockJumpsHeuristic } from './clock-jumps.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { mergeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const defaultConfig = mergeConfig();
// Tight config for easier testing: flag if 1 skew event, or delta_ms > 60s
const testConfig = mergeConfig({
  clockJumps: { singleJumpThresholdMs: 60_000, multipleJumpsMin: 2 },
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('clock_jumps — negative', () => {
  it('produces no flags when no clock.skew events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = clockJumpsHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for a single small clock.skew event below threshold', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'clock.skew',
              data: { delta_ms: 1000 }, // 1 second — below 60s threshold
            },
          ],
        },
      ],
    });
    // testConfig: singleJumpThreshold=60s; multipleJumpsMin=2; only 1 event, 1s delta → no flag
    const flags = clockJumpsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: single large jump
// ---------------------------------------------------------------------------

describe('clock_jumps — positive (single large jump)', () => {
  it('flags a single clock.skew with delta_ms > singleJumpThresholdMs', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'clock.skew',
              data: { delta_ms: 600_000 }, // 10 minutes → above 5-minute default
            },
          ],
        },
      ],
    });
    const flags = clockJumpsHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('clock_jumps');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.confidence).toBe(0.8);
    expect(flags[0]!.detail!['triggeredBy']).toBe('single_large_jump');
    expect(flags[0]!.detail!['maxDeltaMs']).toBe(600_000);
  });

  it('flags negative delta_ms (backward jump) above threshold', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'clock.skew',
              data: { delta_ms: -400_000 }, // -400s → abs > 300s threshold
            },
          ],
        },
      ],
    });
    const flags = clockJumpsHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['maxDeltaMs']).toBe(-400_000);
  });
});

// ---------------------------------------------------------------------------
// Positive: multiple skew events
// ---------------------------------------------------------------------------

describe('clock_jumps — positive (multiple jumps)', () => {
  it('flags a session with >= multipleJumpsMin skew events even if each is small', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'clock.skew', data: { delta_ms: 500 }, t: 1000 },
            { kind: 'clock.skew', data: { delta_ms: 800 }, t: 2000 },
          ],
        },
      ],
    });
    // testConfig: multipleJumpsMin=2 → 2 events triggers
    const flags = clockJumpsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['triggeredBy']).toBe('multiple_jumps');
    expect(flags[0]!.detail!['skewEventCount']).toBe(2);
  });

  it('supportingSeqs contains all clock.skew event seqs', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'clock.skew', data: { delta_ms: 100 }, t: 1000 },
            { kind: 'clock.skew', data: { delta_ms: 200 }, t: 2000 },
          ],
        },
      ],
    });
    const flags = clockJumpsHeuristic.run(index, bundle, testConfig);
    expect(flags[0]!.supportingSeqs).toHaveLength(2);
  });

  it('emits one flag per session (not per skew event)', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'clock.skew', data: { delta_ms: 100 }, t: 1000 },
            { kind: 'clock.skew', data: { delta_ms: 200 }, t: 2000 },
            { kind: 'clock.skew', data: { delta_ms: 300 }, t: 3000 },
          ],
        },
      ],
    });
    const flags = clockJumpsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
  });
});
