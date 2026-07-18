/**
 * Tests for the multiple_sessions_overlap heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { multipleSessionsOverlapHeuristic } from './multiple-sessions-overlap.js';
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

// Wall-time helpers using a fixed base epoch so tests are deterministic.
// Base: 2026-02-01T08:00:00.000Z
const BASE_MS = new Date('2026-02-01T08:00:00.000Z').getTime();
function wallAt(offsetMinutes: number): string {
  return new Date(BASE_MS + offsetMinutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — negative', () => {
  it('produces no flags for a single-session bundle', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for two non-overlapping sessions (A ends before B starts)', async () => {
    // Session A: wall 0..10min; Session B: wall 15..25min → no overlap
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(10), t: 600_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(25), t: 600_000 },
          ],
          walls: [wallAt(15)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for two adjacent sessions (A.end === B.start)', async () => {
    // Strict overlap: a.start < b.end AND b.start < a.end
    // Adjacent: B.start = A.end → b.start < a.end is false → no overlap
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(10), t: 600_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 600_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — positive', () => {
  it('flags two sessions with overlapping wall-time ranges (different hosts)', async () => {
    // Session A: [0, 20min]; Session B: [10, 30min] → overlap at [10, 20]
    // Distinct machine_ids → a real cross-host "stitched together" signal.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('multiple_sessions_overlap');
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.confidence).toBe(0.95);
    expect(flags[0]!.supportingSeqs).toHaveLength(2);
  });

  it('flags an open session (no session.end) that overlaps with a later session', async () => {
    // Session A: starts at 0, no session.end → range [0, Infinity)
    // Session B: starts at 10 → B.start < A.end (Inf) AND A.start < B.end → overlap
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          // No session.end → open-ended
          machineId: 'machine-a',
          events: [],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 600_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('flags two open sessions (both no session.end) that overlap in wall-time', async () => {
    // Session A: starts at 0, no session.end → range [0, Infinity)
    // Session B: starts at 10, no session.end → range [10, Infinity)
    // Both open → A.start < B.end (Inf) AND B.start < A.end (Inf) → always overlap
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('multiple_sessions_overlap');
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail).toMatchObject({
      sessionA: expect.any(String),
      sessionB: expect.any(String),
      sessionAEndWall: 'open',
      sessionBEndWall: 'open',
    });
  });

  it('flag ID is stable across runs', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags1 = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    const flags2 = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags1[0]!.id).toBe(flags2[0]!.id);
  });

  it('emits N*(N-1)/2 flags for N mutually overlapping sessions', async () => {
    // Three sessions that all overlap, each on a distinct host → all pairs flagged.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_800_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
        {
          machineId: 'machine-c',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 600_000 },
          ],
          walls: [wallAt(20)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    // 3 choose 2 = 3 pairs, all overlapping → 3 flags
    expect(flags).toHaveLength(3);
    // All IDs should be unique
    const ids = flags.map((f) => f.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Concurrent same-host / same-recorder narrowing
//
// Multiple editor instances on one machine with one recorder (e.g. two Neovim
// instances on the same workspace in two terminals/tmux panes) genuinely
// overlap in wall-time but are honest concurrent editing, not forgery. Such
// overlaps are suppressed. Overlaps across different hosts OR different
// recorders remain flagged as a real two-machine / forgery signal.
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — concurrent same-host same-recorder', () => {
  it('does NOT flag overlapping sessions from the same host and same recorder', async () => {
    // Both sessions overlap [10, 20], same machine_id + same extension_id.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag two overlapping OPEN sessions from the same host and recorder', async () => {
    // Two concurrent Neovim instances still alive → both open-ended, same identity.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('still flags overlapping sessions from the same host but DIFFERENT recorders', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.vscode',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('still flags overlapping sessions from DIFFERENT hosts but the same recorder', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-2',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('mixed hosts: suppresses the same-host pair but flags cross-host pairs', async () => {
    // Sessions A and B are the same host+recorder (concurrent Neovim); C is a
    // different host. All three overlap. Expect only the A–C and B–C pairs to
    // flag (2 flags), and the A–B pair to be suppressed.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_800_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
        {
          machineId: 'laptop-2',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 600_000 },
          ],
          walls: [wallAt(20)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(2);
  });

  it('flags a same-host overlap when one session is missing recorder identity', async () => {
    // Defensive: if identity can't be confirmed on both sides, we do NOT
    // suppress — the anti-cheat-preserving default. Here both use the default
    // machine_id but session B carries a blank extension_id.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: '',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });
});
