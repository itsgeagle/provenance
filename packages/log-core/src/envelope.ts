/**
 * Envelope and HashedEnvelope types.
 * PRD §4.2 — every log entry carries seq, t, wall, kind, data.
 * PRD §5.2 — HashedEnvelope adds prev_hash and hash for chain integrity.
 */

import type { EventKind, EventPayload } from './events.js';

export type Envelope<K extends EventKind = EventKind> = {
  seq: number;
  /** Milliseconds since session start (monotonic). */
  t: number;
  /** ISO 8601 UTC wall-clock time. */
  wall: string;
  kind: K;
  data: EventPayload<K>;
};

export type HashedEnvelope<K extends EventKind = EventKind> = Envelope<K> & {
  /** sha256 hex of the previous entry (or GENESIS_PREV_HASH for seq 0). */
  prev_hash: string;
  /** sha256 hex of (prev_hash + canonicalize(this entry without "hash")). */
  hash: string;
};
