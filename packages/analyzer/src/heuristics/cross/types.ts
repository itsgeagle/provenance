/**
 * CrossFlag — a heuristic finding that spans multiple bundles.
 *
 * Phase 18 introduces cross-bundle heuristics (paste_shared_across_students,
 * editing_pattern_clone). Unlike a per-bundle Flag (which references events in
 * one bundle), a CrossFlag names the involved bundles and, per bundle, the
 * supporting event seq keys.
 *
 * Shape choices (A59):
 *   - Separate type from Flag to keep Flag clean (no optional bundle fields
 *     that are always null for per-bundle heuristics).
 *   - `eventsPerBundle` is a plain object (Record<bundleId, seqKey[]>) rather
 *     than a Map so it round-trips through JSON and React state without issues.
 *   - Severity + confidence reuse the same Severity union from Flag so UI
 *     rendering components need no changes.
 */

import type { Severity } from '../types.js';

/**
 * A single cross-bundle heuristic finding.
 *
 * `id` — deterministic: `${heuristic}-${bundleIds.sort().join('|')}-${index}`
 *
 * `heuristic` — matches the registered cross-heuristic id
 *   (e.g. `paste_shared_across_students`, `editing_pattern_clone`).
 *
 * `bundleIds` — the Bundle.id values involved. Always length >= 2.
 *
 * `eventsPerBundle` — for each bundleId, an array of `${sessionId}:${seq}`
 *   keys (same format as Flag.supportingSeqs) for the supporting events in
 *   that bundle. Use to deep-link into each bundle's timeline.
 */
export type CrossFlag = {
  id: string;
  heuristic: string;
  title: string;
  severity: Severity;
  confidence: number; // 0..1
  bundleIds: string[]; // always >= 2
  eventsPerBundle: Record<string, string[]>; // bundleId → seqKey[]
  description: string;
  detail?: Record<string, unknown>;
};

/**
 * Interface for cross-bundle heuristics.
 *
 * `run` is a pure synchronous function: no async, no I/O, no side effects.
 * It receives all loaded bundles, per-bundle EventIndex map, and config.
 * Returns CrossFlag[] (empty if no pattern found).
 *
 * Called by runCrossHeuristics only when bundles.length >= 2.
 */
export type CrossHeuristicConfig = {
  /** paste_shared_across_students: minimum paste length (chars) to consider. */
  pasteSharedMinLength: number;
  /** paste_shared_across_students: minimum diffLines ratio for fuzzy grouping. */
  pasteSharedFuzzyThreshold: number;
  /** editing_pattern_clone: 3-gram Jaccard threshold above which to flag. */
  editingPatternCloneThreshold: number;
};

export const DEFAULT_CROSS_HEURISTIC_CONFIG: CrossHeuristicConfig = {
  pasteSharedMinLength: 100,
  pasteSharedFuzzyThreshold: 0.9,
  editingPatternCloneThreshold: 0.3,
};

export type CrossHeuristic = {
  id: string;
  label: string;
  run(
    bundles: import('../../loader/types.js').Bundle[],
    indices: Map<string, import('../../index/event-index.js').EventIndex>,
    config: CrossHeuristicConfig,
  ): CrossFlag[];
};
