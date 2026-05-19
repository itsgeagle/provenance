/**
 * SessionHost — owns the running session's chain state.
 * Tracks seq, prevHash, and tStart; emits chained log entries synchronously.
 * CLAUDE.md: "No `Promise.all` over operations that must be ordered. Log writes are ordered."
 */

import {
  Clock,
  EventKind,
  EventPayload,
  HashedEnvelope,
  GENESIS_PREV_HASH,
  chainEntry,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionHost {
  /** Emit a new log entry, chain it, and call the onEntry sink. Returns the chained entry. */
  emit<K extends EventKind>(kind: K, data: EventPayload<K>): HashedEnvelope<K>;
  /** The session UUID for this session. */
  readonly sessionId: string;
  /** The current sequence number (increments after each emit). */
  readonly seq: number;
  /** The monotonic clock value at session start (performance.now() units). */
  readonly tStartMs: number;
}

export type SessionHostDeps = {
  sessionId: string;
  clock: Clock;
  /** Sink for emitted entries. Phase 4 wires this to the writer; Phase 3 may use a simple appender. */
  onEntry: (entry: HashedEnvelope) => void;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a SessionHost.
 *
 * The host is synchronous: emit() builds the envelope, chains it (computing the hash),
 * calls onEntry, and returns the HashedEnvelope. No awaits.
 *
 * seq starts at 0. prevHash starts at GENESIS_PREV_HASH.
 * tStart is captured from clock.now() at creation time.
 */
export function createSessionHost(deps: SessionHostDeps): SessionHost {
  const { sessionId, clock, onEntry } = deps;

  let currentSeq = 0;
  let prevHash = GENESIS_PREV_HASH;
  const tStart = clock.now();

  const host: SessionHost = {
    get sessionId(): string {
      return sessionId;
    },

    get seq(): number {
      return currentSeq;
    },

    get tStartMs(): number {
      return tStart;
    },

    emit<K extends EventKind>(kind: K, data: EventPayload<K>): HashedEnvelope<K> {
      const seq = currentSeq;
      // t: ms elapsed since session start (monotonic). Non-negative; floor at 0.
      const t = Math.max(0, Math.round(clock.now() - tStart));
      const wall = clock.wall();

      // Build the Envelope (no prev_hash / hash yet), then chain it.
      const entry = chainEntry(prevHash, { seq, t, wall, kind, data });

      // Advance state before calling onEntry to maintain consistency even if onEntry throws.
      currentSeq = seq + 1;
      prevHash = entry.hash;

      onEntry(entry);
      return entry;
    },
  };

  return host;
}
