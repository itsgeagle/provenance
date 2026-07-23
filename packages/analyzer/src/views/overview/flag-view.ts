/**
 * FlagView — the shape the flag panel and its detail drawer render.
 *
 * Both the /local route and the server-backed submission tab show the same
 * flags, but they hold them in different shapes and identify their supporting
 * events by different numbers:
 *
 *   /local   analysis-core `Flag`, whose supportingSeqs are
 *            `${sessionId}:${seq}` keys over SESSION-LOCAL seqs.
 *   server   `FlagRow`, whose supporting_seqs are GLOBAL indices — unique
 *            across the whole submission, which is what makes them correct for
 *            a flag whose evidence spans sessions.
 *
 * Rather than have the components know both, each route resolves its own
 * references into `SupportingRef`s here, and the components render one shape.
 * That is what lets a single panel serve both routes, and it is also what fixed
 * the multi-session bug: the server path used to fabricate seqKeys from
 * `session_id`, which is '' for precisely the cross-session flags.
 */

import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { FlagRow } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupportingRef = {
  /** Stable within a flag; used for React keys and test ids. */
  id: string;
  /**
   * How the destination view is told which event to land on.
   *
   * On the server path this is the global index and is always known, even
   * before the event index has loaded — which is why the drawer's jump buttons
   * work immediately. On /local the index is already in memory, so this is the
   * resolved event's own globalIdx.
   */
  globalIdx: number | null;
  /** Deep-link value for the raw timeline's `?seq=`. */
  timelineSeq: string;
  /**
   * The resolved event, or null when the index has not loaded yet or holds no
   * event with this reference. Null means "no metadata to show", never "this
   * evidence does not exist" — jump targets stay enabled.
   */
  event: IndexedEvent | null;
};

export type FlagView = {
  id: string;
  heuristic: string;
  title: string;
  description: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  confidence: number;
  detail?: Record<string, unknown> | undefined;
  supporting: SupportingRef[];
};

// ---------------------------------------------------------------------------
// /local — analysis-core Flag
// ---------------------------------------------------------------------------

/**
 * Project an in-memory `Flag` onto a `FlagView`.
 *
 * `supportingSeqs` are already `${sessionId}:${seq}` keys matching
 * `index.bySeq`, so they double as the timeline deep-link value.
 */
export function toFlagViewFromLocal(flag: Flag, index: EventIndex | null): FlagView {
  return {
    id: flag.id,
    heuristic: flag.heuristic,
    title: flag.title,
    description: flag.description,
    severity: flag.severity,
    confidence: flag.confidence,
    detail: flag.detail,
    supporting: flag.supportingSeqs.map((seqKey) => {
      const event = index?.bySeq.get(seqKey) ?? null;
      return {
        id: seqKey,
        globalIdx: event?.globalIdx ?? null,
        timelineSeq: seqKey,
        event,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Server — FlagRow
// ---------------------------------------------------------------------------

/**
 * Project a server `FlagRow` onto a `FlagView`.
 *
 * `bySeq` comes from `buildGlobalSeqLookup`. When it is empty (index not yet
 * loaded) the refs still carry their globalIdx, so the row renders as a bare
 * event number with working jump buttons rather than disappearing.
 *
 * `title` / `description` fall back to the heuristic id for flags stored before
 * the server persisted the prose (server migration 0020).
 */
export function toFlagViewFromRow(
  row: FlagRow,
  bySeq: ReadonlyMap<number, IndexedEvent>,
): FlagView {
  const title = row.title !== undefined && row.title !== '' ? row.title : row.heuristic_id;
  return {
    id: row.id,
    heuristic: row.heuristic_id,
    title,
    description: row.description ?? '',
    severity: row.severity,
    confidence: row.confidence,
    detail:
      row.detail !== null && typeof row.detail === 'object'
        ? (row.detail as Record<string, unknown>)
        : undefined,
    supporting: (row.supporting_seqs ?? []).map((globalIdx) => {
      const event = bySeq.get(globalIdx) ?? null;
      return {
        id: String(globalIdx),
        globalIdx,
        // Before the index resolves we can only offer the bare global seq —
        // which TimelineInner accepts precisely so this link works early.
        timelineSeq: event !== null ? `${event.sessionId}:${event.seq}` : String(globalIdx),
        event,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Picking a flag to auto-open from a dashboard deep-link
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<FlagView['severity'], number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * Resolve a dashboard `?flag=<heuristic>` deep-link to the id of the flag its
 * drawer should open.
 *
 * The cohort table only carries a flag's `heuristic_id`, so a submission may
 * hold several flags of that heuristic (e.g. one per file). We open the
 * highest-severity one; ties keep the first in the flags' existing order
 * (severity desc, confidence desc), so this lands on the most serious instance.
 * Returns null when no flag matches — the caller renders no drawer.
 */
export function pickFlagByHeuristic(flags: FlagView[], heuristic: string): string | null {
  let best: FlagView | null = null;
  for (const flag of flags) {
    if (flag.heuristic !== heuristic) continue;
    if (best === null || SEVERITY_RANK[flag.severity] > SEVERITY_RANK[best.severity]) {
      best = flag;
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Session grouping
// ---------------------------------------------------------------------------

export type SupportingGroup = {
  /** Null for refs whose event has not resolved — they group together at the end. */
  sessionId: string | null;
  refs: SupportingRef[];
};

/**
 * Group supporting refs by the session their event belongs to, preserving the
 * order the refs arrived in (which is the heuristic's own ordering).
 *
 * Unresolved refs collect into a single trailing `sessionId: null` group so a
 * partially-loaded drawer still renders every piece of evidence.
 */
export function groupSupportingBySession(refs: SupportingRef[]): SupportingGroup[] {
  const groups: SupportingGroup[] = [];
  const bySession = new Map<string | null, SupportingGroup>();

  for (const ref of refs) {
    const sessionId = ref.event?.sessionId ?? null;
    let group = bySession.get(sessionId);
    if (group === undefined) {
      group = { sessionId, refs: [] };
      bySession.set(sessionId, group);
      groups.push(group);
    }
    group.refs.push(ref);
  }

  // Unresolved refs sort last — they carry no timestamp to order them by.
  return groups.sort((a, b) => {
    if (a.sessionId === null) return 1;
    if (b.sessionId === null) return -1;
    return 0;
  });
}

/** How many distinct sessions this flag's resolved evidence touches. */
export function countSessionsSpanned(refs: SupportingRef[]): number {
  const sessions = new Set<string>();
  for (const ref of refs) {
    if (ref.event !== null) sessions.add(ref.event.sessionId);
  }
  return sessions.size;
}
