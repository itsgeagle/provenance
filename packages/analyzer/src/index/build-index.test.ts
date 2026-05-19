/**
 * Tests for build-index.ts (Phase 3).
 */

import { describe, it, expect } from 'vitest';
import { buildIndex, getFileFromPayload } from './build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { sha256Hex } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// getFileFromPayload
// ---------------------------------------------------------------------------

describe('getFileFromPayload', () => {
  it('extracts path from doc.open payload', () => {
    expect(getFileFromPayload('doc.open', { path: '/a.py', sha256: 'abc', line_count: 1 })).toBe(
      '/a.py',
    );
  });

  it('extracts path from doc.change payload', () => {
    expect(getFileFromPayload('doc.change', { path: '/b.py', deltas: [], source: 'typed' })).toBe(
      '/b.py',
    );
  });

  it('extracts path from doc.save payload', () => {
    expect(getFileFromPayload('doc.save', { path: '/c.py', sha256: 'xyz' })).toBe('/c.py');
  });

  it('extracts path from doc.close payload', () => {
    expect(getFileFromPayload('doc.close', { path: '/d.py' })).toBe('/d.py');
  });

  it('extracts path from paste payload', () => {
    expect(
      getFileFromPayload('paste', {
        path: '/e.py',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        length: 5,
        sha256: 'abc',
      }),
    ).toBe('/e.py');
  });

  it('extracts path from selection.change payload', () => {
    expect(
      getFileFromPayload('selection.change', {
        path: '/f.py',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        was_selection: false,
      }),
    ).toBe('/f.py');
  });

  it('extracts path from fs.external_change payload', () => {
    expect(
      getFileFromPayload('fs.external_change', {
        path: '/g.py',
        old_hash: 'aaa',
        new_hash: 'bbb',
        diff_size: 10,
      }),
    ).toBe('/g.py');
  });

  it('returns undefined for session.start', () => {
    expect(getFileFromPayload('session.start', { session_id: 'abc' })).toBeUndefined();
  });

  it('returns undefined for session.heartbeat', () => {
    expect(
      getFileFromPayload('session.heartbeat', {
        focused: true,
        active_file: null,
        idle_since_ms: 0,
      }),
    ).toBeUndefined();
  });

  it('returns undefined for terminal.open', () => {
    expect(
      getFileFromPayload('terminal.open', {
        terminal_id: 't1',
        shell: 'bash',
        shell_integration: false,
      }),
    ).toBeUndefined();
  });

  it('returns undefined for focus.change', () => {
    expect(getFileFromPayload('focus.change', { gained: true })).toBeUndefined();
  });

  it('returns undefined for git.event', () => {
    expect(getFileFromPayload('git.event', { operation: 'commit' })).toBeUndefined();
  });

  it('returns undefined if payload is null', () => {
    expect(getFileFromPayload('doc.change', null)).toBeUndefined();
  });

  it('returns undefined if path field is not a string', () => {
    expect(getFileFromPayload('doc.change', { path: 42 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildIndex — structural correctness
// ---------------------------------------------------------------------------

describe('buildIndex — structural correctness', () => {
  it('ordered[i].globalIdx === i for all events', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 3 }],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    for (let i = 0; i < index.ordered.length; i++) {
      expect(index.ordered[i]!.globalIdx).toBe(i);
    }
  });

  it('bySeq key is `${sessionId}:${seq}` and resolves to the correct event', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);
    const [session] = bundle.sessions;
    if (session === undefined) throw new Error('No sessions');

    for (const event of session.events) {
      const key = `${session.sessionId}:${event.seq}`;
      const indexed = index.bySeq.get(key);
      expect(indexed).toBeDefined();
      expect(indexed?.seq).toBe(event.seq);
      expect(indexed?.sessionId).toBe(session.sessionId);
    }
  });

  it('byKind accumulates events of the correct kind', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    // session.start appears once per session
    const starts = index.byKind.get('session.start') ?? [];
    expect(starts.length).toBe(1);
    expect(starts[0]?.kind).toBe('session.start');

    // doc.change appears 5 times
    const changes = index.byKind.get('doc.change') ?? [];
    expect(changes.length).toBe(5);
    for (const e of changes) {
      expect(e.kind).toBe('doc.change');
    }
  });

  it('byFile contains file-associated events and not session events', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    const fileEvents = index.byFile.get('/test/file.py') ?? [];
    // 3 doc.change events
    expect(fileEvents.length).toBe(3);

    // session.start should NOT be in byFile
    for (const e of fileEvents) {
      expect(e.kind).not.toBe('session.start');
    }
  });

  it('bySessionId groups events by session', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 2 }, { eventCount: 3 }],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    // Each session: session.start + N doc.changes
    const [s0, s1] = bundle.sessions;
    const events0 = index.bySessionId.get(s0!.sessionId) ?? [];
    const events1 = index.bySessionId.get(s1!.sessionId) ?? [];

    expect(events0.length).toBe(3); // 1 start + 2 changes
    expect(events1.length).toBe(4); // 1 start + 3 changes

    for (const e of events0) expect(e.sessionId).toBe(s0!.sessionId);
    for (const e of events1) expect(e.sessionId).toBe(s1!.sessionId);
  });

  it('events within a single session are in seq order in ordered[]', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);
    const [session] = bundle.sessions;
    const sessionEvents = index.bySessionId.get(session!.sessionId) ?? [];

    for (let i = 1; i < sessionEvents.length; i++) {
      expect(sessionEvents[i]!.seq).toBeGreaterThan(sessionEvents[i - 1]!.seq);
    }
  });

  it('cross-session ordering: earlier wall timestamps come first in ordered[]', async () => {
    // Session 0 starts at 2026-01-01T00:00:00Z, session 1 at 2026-01-01T01:00:00Z.
    // All session-0 events should precede all session-1 events in ordered[].
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 2 }, { eventCount: 2 }],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    for (let i = 1; i < index.ordered.length; i++) {
      const prev = index.ordered[i - 1]!;
      const curr = index.ordered[i]!;
      expect(curr.wall >= prev.wall).toBe(true);
    }
  });

  it('`file` field is populated for file events and absent for non-file events', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    const sessionStart = index.byKind.get('session.start')?.[0];
    expect(sessionStart).toBeDefined();
    expect(sessionStart?.file).toBeUndefined();

    const docChange = index.byKind.get('doc.change')?.[0];
    expect(docChange).toBeDefined();
    expect(docChange?.file).toBe('/test/file.py');
  });
});

// ---------------------------------------------------------------------------
// buildIndex — 10k-event performance regression test
// ---------------------------------------------------------------------------

describe('buildIndex — performance', () => {
  it('indexes 10k events in <100ms', async () => {
    // Build a bundle with 2 sessions of ~5k events each.
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 5000 }, { eventCount: 5000 }],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const start = performance.now();
    const index = buildIndex(bundle);
    const elapsed = performance.now() - start;

    // Sanity: correct event count (2 sessions × (1 start + 5000 changes))
    expect(index.ordered.length).toBe(10002);

    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// buildIndex — tie-break rule
// ---------------------------------------------------------------------------

describe('buildIndex — tie-break on identical wall', () => {
  it('breaks wall ties by (sessionId asc, seq asc)', async () => {
    // Use explicit wall timestamps so both sessions share some timestamps.
    // Session 0 and session 1 both start at the same wall time.
    // Session IDs must be valid hex+dash UUIDs (matches SLOG_RE = /^session-([0-9a-f-]+)\.slog$/).
    const sharedWall = '2026-06-01T00:00:00.000Z';
    // 'aaaa-...' < 'ffff-...' lexicographically (both valid hex).
    const earlyId = 'aaaa0000-0000-4000-8000-000000000000';
    const lateId = 'ffff0000-0000-4000-8000-000000000000';
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        { sessionId: earlyId, eventCount: 2, walls: [sharedWall, sharedWall, sharedWall] },
        { sessionId: lateId, eventCount: 2, walls: [sharedWall, sharedWall, sharedWall] },
      ],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    // All events have the same wall. Order should be by sessionId asc then seq asc.
    // earlyId < lateId lexicographically → earlyId events all come first.
    const earlyEvents = index.ordered.filter((e) => e.sessionId === earlyId);
    const lateEvents = index.ordered.filter((e) => e.sessionId === lateId);

    // All early events come before all late events.
    const lastEarlyGlobalIdx = earlyEvents.at(-1)!.globalIdx;
    const firstLateGlobalIdx = lateEvents[0]!.globalIdx;
    expect(lastEarlyGlobalIdx).toBeLessThan(firstLateGlobalIdx);
  });
});

// ---------------------------------------------------------------------------
// buildIndex — with explicit event specs (Phase 3 helper extension)
// ---------------------------------------------------------------------------

describe('buildIndex — explicit event specs', () => {
  it('indexes doc.save events and includes them in byFile', async () => {
    const contentAfterChange = 'hello';
    const saveHash = sha256Hex(contentAfterChange);

    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/src/main.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.save',
              data: { path: '/src/main.py', sha256: saveHash },
            },
          ],
        },
      ],
    });

    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    const fileEvents = index.byFile.get('/src/main.py') ?? [];
    // doc.change + doc.save
    expect(fileEvents.length).toBe(2);
    expect(fileEvents.find((e) => e.kind === 'doc.save')).toBeDefined();

    const saves = index.byKind.get('doc.save') ?? [];
    expect(saves.length).toBe(1);
  });

  it('indexes fs.external_change events correctly', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/src/foo.py',
                old_hash: 'aaa',
                new_hash: 'bbb',
                diff_size: 20,
              },
            },
          ],
        },
      ],
    });

    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('Expected successful bundle load');
    const bundle: Bundle = result.value;

    const index = buildIndex(bundle);

    const extChanges = index.byKind.get('fs.external_change') ?? [];
    expect(extChanges.length).toBe(1);
    expect(extChanges[0]?.file).toBe('/src/foo.py');
  });
});
