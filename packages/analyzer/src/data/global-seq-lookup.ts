/**
 * Resolve a server-side global event seq back to the event it names.
 *
 * ## Why this exists
 *
 * The server stores every reference to an event — `flags.supporting_seqs`,
 * `cross_flag_participants.supporting_seqs` — as a **globalIdx**: the position
 * of that event in the submission's whole chronological stream, across all
 * sessions. It is the one identifier that stays unambiguous when a submission
 * has more than one session, which is precisely why ingest translates
 * analysis-core's session-scoped `${sessionId}:${seq}` keys into it.
 *
 * `GET /submissions/:id/events` echoes that number back as each row's `seq`, so
 * an index built by `buildIndexFromEventRows` carries it on `event.seq`. Note
 * that this makes the API-backed index's `bySeq` map keyed by
 * `${sessionId}:${globalIdx}` — a hybrid that matches neither the server's
 * numbering nor /local's session-local one. Anything holding a bare server
 * globalIdx therefore cannot use `bySeq`, and must come through here.
 *
 * ## Why not just index into `ordered`
 *
 * `ordered[i].globalIdx` is the client's own positional index, which *should*
 * equal the server's globalIdx but is derived independently (the client re-sorts
 * the rows it fetched). Looking up by `event.seq` — the value the server
 * actually sent — keeps resolution correct even if the two ever diverge, and
 * callers then navigate using the resolved event's own `sessionId` / `globalIdx`
 * so the destination view agrees with them.
 */

import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

/**
 * Build a globalIdx → event lookup over an API-backed index.
 *
 * O(n) in the event count, so callers should memoize on `index` identity rather
 * than rebuild per render. Returns an empty map for a null index (not yet
 * loaded), which callers treat as "unresolved", not "absent".
 */
export function buildGlobalSeqLookup(index: EventIndex | null): ReadonlyMap<number, IndexedEvent> {
  const map = new Map<number, IndexedEvent>();
  if (index === null) return map;
  for (const event of index.ordered) {
    map.set(event.seq, event);
  }
  return map;
}
