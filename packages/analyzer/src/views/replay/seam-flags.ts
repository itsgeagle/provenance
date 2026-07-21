/**
 * seam-flags — maps `inter_session_external_change` flags onto the session
 * boundary they describe.
 *
 * The heuristic (analysis-core/src/heuristics/inter-session-external-change.ts)
 * detects file content that diverged between one session's END and the next
 * session's START — a change the student made with another tool while the
 * recorder was off. Its supporting event is the next session's first `doc.open`
 * for the diverged file, which is precisely a seam.
 *
 * Until replay spanned the whole bundle, that moment was unreachable: the
 * playhead could never sit at a session boundary. Now it can, so the boundary
 * is worth marking.
 *
 * Pure: no React, no DOM.
 */

import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { Seam } from './bundle-clock.js';

/** Heuristic id, as emitted by analysis-core. */
export const INTER_SESSION_EXTERNAL_CHANGE = 'inter_session_external_change';

/**
 * Returns the set of `seam.atGlobalIdx` values carrying an
 * inter_session_external_change flag.
 *
 * A seam is flagged when a supporting event of such a flag belongs to that
 * seam's `nextSessionId` at or after the boundary.
 *
 * @param bySeq `EventIndex.bySeq` — resolves `${sessionId}:${seq}` keys.
 */
export function buildFlaggedSeamIdxs(
  seams: readonly Seam[],
  flags: readonly Flag[],
  bySeq: EventIndex['bySeq'],
): Set<number> {
  const flagged = new Set<number>();
  if (seams.length === 0 || flags.length === 0) return flagged;

  // nextSessionId → seam boundary. A session is the "next" side of at most one
  // seam under normal (non-interleaved) recording.
  const seamByNextSession = new Map<string, Seam>();
  for (const seam of seams) seamByNextSession.set(seam.nextSessionId, seam);

  for (const flag of flags) {
    if (flag.heuristic !== INTER_SESSION_EXTERNAL_CHANGE) continue;

    for (const key of flag.supportingSeqs) {
      const event = bySeq.get(key);
      if (event === undefined) continue;

      const seam = seamByNextSession.get(event.sessionId);
      if (seam === undefined) continue;
      if (event.globalIdx < seam.atGlobalIdx) continue;

      flagged.add(seam.atGlobalIdx);
    }
  }

  return flagged;
}
