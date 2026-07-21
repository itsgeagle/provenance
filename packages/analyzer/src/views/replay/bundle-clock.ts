/**
 * bundle-clock — derives a whole-bundle playback clock from the cross-session
 * event stream.
 *
 * WHY THIS EXISTS
 * Each event's `t` is milliseconds since ITS OWN session's start, so `t` resets
 * to 0 at every session boundary. The replay engine advances a virtual clock and
 * applies events whose time falls in the window; feeding it raw `t` across a
 * concatenated multi-session stream would rewind time at each boundary and stall
 * playback for the rest of the bundle.
 *
 * `bundleT[globalIdx]` is a monotonically non-decreasing timeline for the whole
 * bundle:
 *   - within a session it accumulates `t` deltas, so within-session playback
 *     timing is identical to the pre-whole-bundle engine;
 *   - across a seam it inserts a CLAMPED gap, so an overnight break plays as a
 *     brief pause rather than an unwatchable dead stop. The real duration is not
 *     lost — it rides on the Seam and is what the UI displays.
 *
 * This lives in the analyzer, not analysis-core, on purpose: analysis-core is
 * consumed by the server and `IndexedEvent` is a shared shape. This is a
 * playback concern with no analysis meaning.
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

/** Longest pause an inter-session gap may render as, in ms. */
export const SEAM_MAX_GAP_MS = 5_000;

/**
 * Shortest pause an inter-session gap may render as, in ms. Also the fallback
 * for gaps that are negative, NaN, or unparseable — cross-machine clock skew is
 * a real condition here (see the clock_jumps heuristic), and `bundleT` must stay
 * non-decreasing regardless of what the wall clocks say.
 */
export const SEAM_FLOOR_MS = 1_000;

export type Seam = {
  /** globalIdx of the FIRST event of the next session. */
  atGlobalIdx: number;
  prevSessionId: string;
  nextSessionId: string;
  /** True wall-clock gap in ms. May be negative or NaN under clock skew. */
  realGapMs: number;
  /** Gap as rendered during playback. Always within [SEAM_FLOOR_MS, maxSeamGapMs]. */
  collapsedGapMs: number;
};

export type BundleClock = {
  /** Indexed by globalIdx. Guaranteed non-decreasing. */
  bundleT: Float64Array;
  seams: Seam[];
};

function parseWallMs(wall: string): number {
  const ms = Date.parse(wall);
  return Number.isFinite(ms) ? ms : NaN;
}

export function buildBundleClock(
  ordered: readonly IndexedEvent[],
  opts?: { maxSeamGapMs?: number },
): BundleClock {
  const maxSeamGapMs = opts?.maxSeamGapMs ?? SEAM_MAX_GAP_MS;
  const bundleT = new Float64Array(ordered.length);
  const seams: Seam[] = [];

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;

    if (cur.sessionId === prev.sessionId) {
      // Same session: `t` is monotonic and directly comparable. Floor the delta
      // at 0 so a malformed non-monotonic log cannot rewind the clock.
      const delta = Math.max(0, (cur.t ?? 0) - (prev.t ?? 0));
      bundleT[i] = bundleT[i - 1]! + delta;
      continue;
    }

    // Session seam: `t` restarts, so wall clock is the only comparable signal.
    const realGapMs = parseWallMs(cur.wall) - parseWallMs(prev.wall);
    const collapsedGapMs = Number.isFinite(realGapMs)
      ? Math.min(maxSeamGapMs, Math.max(SEAM_FLOOR_MS, realGapMs))
      : SEAM_FLOOR_MS;

    bundleT[i] = bundleT[i - 1]! + collapsedGapMs;
    seams.push({
      atGlobalIdx: i,
      prevSessionId: prev.sessionId,
      nextSessionId: cur.sessionId,
      realGapMs,
      collapsedGapMs,
    });
  }

  return { bundleT, seams };
}

/**
 * Human-readable duration for a seam label, e.g. "4h 12m offline".
 *
 * Deliberately coarse: two units maximum, and seconds are dropped once the gap
 * reaches an hour. Callers pass `Seam.realGapMs` (the true offline duration),
 * never `collapsedGapMs` — the collapsed value is a playback detail and would
 * be misleading in the UI.
 */
export function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
