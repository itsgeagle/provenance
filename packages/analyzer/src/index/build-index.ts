/**
 * buildIndex — construct an EventIndex from a Bundle (Phase 3).
 *
 * PRD §7.3.
 *
 * Pure function, O(N) in the total number of events across all sessions.
 * Target: <100ms on a 10k-event bundle (see build-index.test.ts perf test).
 */

import type { EventKind } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { EventIndex, IndexedEvent } from './event-index.js';

// ---------------------------------------------------------------------------
// File-path extraction
// ---------------------------------------------------------------------------

/**
 * Extract the file path from an event payload, if the event kind carries one.
 *
 * This is the single place in the codebase that knows which event kinds have
 * a `path` field. All other code routes through this helper so that payload
 * shape changes only need to be updated here.
 *
 * Returns `undefined` for event kinds that don't carry a file path (e.g.
 * session.start, session.heartbeat, terminal.open, git.event, etc.).
 */
export function getFileFromPayload(kind: EventKind, payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;

  switch (kind) {
    case 'doc.open':
    case 'doc.change':
    case 'doc.save':
    case 'doc.close':
    case 'paste':
    case 'selection.change':
    case 'fs.external_change':
      // All of these carry a top-level `path` string.
      return typeof p['path'] === 'string' ? p['path'] : undefined;

    // focus.change carries gained/reason but no file path.
    // terminal.open, terminal.command, ext.snapshot, ext.activate,
    // session.start, session.heartbeat, session.end,
    // git.event, clock.skew, paste.anomaly, chain.broken,
    // recorder.degraded, recorder.recovered_from_corruption
    // — none of these carry a file-level path.
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

/**
 * Build an EventIndex from a fully-loaded Bundle.
 *
 * Algorithm:
 *  1. Flatten all events from all sessions into a single array, tagging each
 *     with its sessionId.
 *  2. Sort by (wall, sessionId, seq) — wall is the primary key; ties are
 *     broken deterministically by sessionId then seq.
 *  3. Walk the sorted array once, assigning globalIdx and populating all
 *     index maps in a single pass.
 */
export function buildIndex(bundle: Bundle): EventIndex {
  // ---------------------------------------------------------------------------
  // Step 1: flatten
  // ---------------------------------------------------------------------------
  type FlatEvent = {
    sessionId: string;
    seq: number;
    wall: string;
    t: number;
    kind: EventKind;
    payload: unknown;
    // Optional, omitted entirely when there is no path (exactOptionalPropertyTypes).
    file?: string;
  };

  const flat: FlatEvent[] = [];
  for (const session of bundle.sessions) {
    for (const envelope of session.events) {
      const file = getFileFromPayload(envelope.kind, envelope.data);
      const event: FlatEvent = {
        sessionId: session.sessionId,
        seq: envelope.seq,
        wall: envelope.wall,
        t: envelope.t,
        kind: envelope.kind,
        payload: envelope.data,
      };
      if (file !== undefined) {
        event.file = file;
      }
      flat.push(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: sort
  //
  // Tie-break rule (documented in IndexedEvent.globalIdx JSDoc):
  //   primary: wall (lexicographic ISO string compare = chronological)
  //   secondary: sessionId (deterministic across identical walls)
  //   tertiary: seq (natural ordering within session)
  // ---------------------------------------------------------------------------
  flat.sort((a, b) => {
    if (a.wall < b.wall) return -1;
    if (a.wall > b.wall) return 1;
    if (a.sessionId < b.sessionId) return -1;
    if (a.sessionId > b.sessionId) return 1;
    return a.seq - b.seq;
  });

  // ---------------------------------------------------------------------------
  // Step 3: single-pass index construction
  // ---------------------------------------------------------------------------
  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered: IndexedEvent[] = [];

  for (let i = 0; i < flat.length; i++) {
    const f = flat[i]!;

    const event: IndexedEvent = {
      sessionId: f.sessionId,
      seq: f.seq,
      globalIdx: i, // ordered[i].globalIdx === i
      wall: f.wall,
      t: f.t,
      kind: f.kind,
      payload: f.payload,
      ...(f.file !== undefined ? { file: f.file } : {}),
    };

    ordered.push(event);

    // bySeq
    bySeq.set(`${f.sessionId}:${f.seq}`, event);

    // byKind
    let kindArr = byKind.get(f.kind);
    if (kindArr === undefined) {
      kindArr = [];
      byKind.set(f.kind, kindArr);
    }
    kindArr.push(event);

    // byFile
    if (f.file !== undefined) {
      let fileArr = byFile.get(f.file);
      if (fileArr === undefined) {
        fileArr = [];
        byFile.set(f.file, fileArr);
      }
      fileArr.push(event);
    }

    // bySessionId
    let sessionArr = bySessionId.get(f.sessionId);
    if (sessionArr === undefined) {
      sessionArr = [];
      bySessionId.set(f.sessionId, sessionArr);
    }
    sessionArr.push(event);
  }

  return { bySeq, byKind, byFile, bySessionId, ordered };
}
