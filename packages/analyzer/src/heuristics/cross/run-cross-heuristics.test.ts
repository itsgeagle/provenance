/**
 * Tests for runCrossHeuristics orchestrator (Phase 18).
 */

import { describe, it, expect } from 'vitest';
import { runCrossHeuristics } from './run-cross-heuristics.js';
import type { Bundle } from '../../loader/types.js';
import type { EventIndex, IndexedEvent } from '../../index/event-index.js';
import type { EventKind } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBundle(id: string): Bundle {
  return {
    id,
    manifest: {
      assignment_id: 'hw1',
      semester: 'sp26',
      assignment_key_pubhex: 'a'.repeat(64),
      extension_hash: 'b'.repeat(64),
    },
    manifestSigHex: 'c'.repeat(128),
    sessions: [],
    sourceFilename: `${id}.zip`,
    loadedAt: new Date().toISOString(),
  } as unknown as Bundle;
}

function makeEmptyIndex(): EventIndex {
  return {
    bySeq: new Map(),
    byKind: new Map(),
    byFile: new Map(),
    bySessionId: new Map(),
    ordered: [],
  };
}

function makeIndexWithPaste(sessionId: string, seq: number, sha256: string): EventIndex {
  const e: IndexedEvent = {
    sessionId,
    seq,
    globalIdx: 0,
    wall: '2026-01-01T00:00:01.000Z',
    t: 1000,
    kind: 'paste' as const,
    payload: {
      path: 'hw.py',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      length: 250,
      sha256,
    },
  };
  const byKind = new Map<EventKind, IndexedEvent[]>();
  byKind.set('paste', [e]);
  return {
    bySeq: new Map([[`${sessionId}:${seq}`, e]]),
    byKind,
    byFile: new Map(),
    bySessionId: new Map(),
    ordered: [e],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCrossHeuristics', () => {
  it('returns [] when fewer than 2 bundles', () => {
    const bundleA = makeBundle('bundle-a');
    const indices = new Map([[bundleA.id, makeEmptyIndex()]]);

    const flags = runCrossHeuristics([bundleA], indices);
    expect(flags).toHaveLength(0);
  });

  it('returns [] when 0 bundles', () => {
    const flags = runCrossHeuristics([], new Map());
    expect(flags).toHaveLength(0);
  });

  it('runs paste_shared heuristic and returns flags when shared paste exists', () => {
    const bundleA = makeBundle('bundle-a');
    const bundleB = makeBundle('bundle-b');

    const sha = 'x'.repeat(64);
    const indexA = makeIndexWithPaste('sess-a', 1, sha);
    const indexB = makeIndexWithPaste('sess-b', 1, sha);

    const indices = new Map([
      [bundleA.id, indexA],
      [bundleB.id, indexB],
    ]);

    const flags = runCrossHeuristics([bundleA, bundleB], indices);
    const pasteSharedFlags = flags.filter((f) => f.heuristic === 'paste_shared_across_students');
    expect(pasteSharedFlags.length).toBeGreaterThan(0);
  });

  it('sorts flags: high severity before medium', () => {
    const bundleA = makeBundle('bundle-a');
    const bundleB = makeBundle('bundle-b');

    const sha = 'y'.repeat(64);
    // The shared paste triggers high-severity paste_shared flag.
    // The identical kind stream triggers medium-severity editing_pattern_clone.
    const e: IndexedEvent = {
      sessionId: 'sess-a',
      seq: 1,
      globalIdx: 0,
      wall: '2026-01-01T00:00:01.000Z',
      t: 1000,
      kind: 'paste' as const,
      payload: {
        path: 'hw.py',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        length: 250,
        sha256: sha,
      },
    };
    const byKind = new Map<EventKind, IndexedEvent[]>();
    byKind.set('paste', [e]);

    // Add extra events so the kind stream forms 3-grams.
    const extraKinds: EventKind[] = ['session.start', 'doc.open', 'doc.change', 'doc.save'];
    const extraEvents: IndexedEvent[] = extraKinds.map((kind, i) => ({
      sessionId: 'sess-a',
      seq: i + 2,
      globalIdx: i + 1,
      wall: `2026-01-01T00:01:${String(i).padStart(2, '0')}.000Z`,
      t: (i + 2) * 1000,
      kind,
      payload: null,
    }));

    const indexA: EventIndex = {
      bySeq: new Map(),
      byKind,
      byFile: new Map(),
      bySessionId: new Map(),
      ordered: [e, ...extraEvents],
    };
    const indexB: EventIndex = {
      bySeq: new Map(),
      byKind,
      byFile: new Map(),
      bySessionId: new Map(),
      ordered: [
        { ...e, sessionId: 'sess-b', payload: { ...((e.payload as object) ?? {}), sha256: sha } },
        ...extraEvents.map((ev) => ({ ...ev, sessionId: 'sess-b' })),
      ],
    };

    const indices = new Map([
      [bundleA.id, indexA],
      [bundleB.id, indexB],
    ]);

    const flags = runCrossHeuristics([bundleA, bundleB], indices);

    // First flag should have higher or equal severity to subsequent flags.
    for (let i = 1; i < flags.length; i++) {
      const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
      const prev = severityOrder[flags[i - 1]!.severity] ?? 99;
      const curr = severityOrder[flags[i]!.severity] ?? 99;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  it('configOverride changes thresholds', () => {
    const bundleA = makeBundle('bundle-a');
    const bundleB = makeBundle('bundle-b');

    const sha = 'z'.repeat(64);
    // Paste length is 80 chars — below the default 100-char minimum.
    const e: IndexedEvent = {
      sessionId: 'sess-a',
      seq: 1,
      globalIdx: 0,
      wall: '2026-01-01T00:00:01.000Z',
      t: 1000,
      kind: 'paste' as const,
      payload: {
        path: 'hw.py',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        length: 80,
        sha256: sha,
      },
    };
    const byKind = new Map<EventKind, IndexedEvent[]>();
    byKind.set('paste', [e]);

    const indexA: EventIndex = {
      bySeq: new Map(),
      byKind,
      byFile: new Map(),
      bySessionId: new Map(),
      ordered: [e],
    };
    const indexB: EventIndex = {
      bySeq: new Map(),
      byKind,
      byFile: new Map(),
      bySessionId: new Map(),
      ordered: [{ ...e, sessionId: 'sess-b' }],
    };

    const indices = new Map([
      [bundleA.id, indexA],
      [bundleB.id, indexB],
    ]);

    // Default config: no flag (80 < 100 minimum).
    const flagsDefault = runCrossHeuristics([bundleA, bundleB], indices);
    const pasteDefaultFlags = flagsDefault.filter(
      (f) => f.heuristic === 'paste_shared_across_students',
    );
    expect(pasteDefaultFlags).toHaveLength(0);

    // Lowered minimum: flag fires.
    const flagsOverride = runCrossHeuristics([bundleA, bundleB], indices, {
      pasteSharedMinLength: 50,
    });
    const pasteOverrideFlags = flagsOverride.filter(
      (f) => f.heuristic === 'paste_shared_across_students',
    );
    expect(pasteOverrideFlags.length).toBeGreaterThan(0);
  });
});
