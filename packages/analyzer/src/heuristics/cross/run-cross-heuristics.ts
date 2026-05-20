/**
 * runCrossHeuristics — orchestrator for Phase 18 cross-bundle heuristics.
 *
 * Called by BundleContext after all bundles are loaded when bundles.length >= 2.
 * Pure synchronous function — no async, no I/O.
 *
 * Returns CrossFlag[] sorted:
 *   1. Severity descending (high → medium → low → info).
 *   2. Confidence descending.
 *   3. bundleIds[0] lexicographic ascending (stable tie-break).
 *   4. id lexicographic ascending.
 *
 * When bundles.length < 2, returns [] immediately (no cross-bundle work possible).
 */

import type { Bundle } from '../../loader/types.js';
import type { EventIndex } from '../../index/event-index.js';
import type { CrossFlag, CrossHeuristic, CrossHeuristicConfig } from './types.js';
import { DEFAULT_CROSS_HEURISTIC_CONFIG } from './types.js';
import { pasteSharedAcrossStudentsHeuristic } from './paste-shared-across-students.js';
import { editingPatternCloneHeuristic } from './editing-pattern-clone.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const CROSS_HEURISTIC_REGISTRY: CrossHeuristic[] = [
  pasteSharedAcrossStudentsHeuristic,
  editingPatternCloneHeuristic,
];

// ---------------------------------------------------------------------------
// Severity sort order (mirrors per-bundle run-heuristics.ts)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function severityRank(flag: CrossFlag): number {
  return SEVERITY_ORDER[flag.severity] ?? 99;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all cross-bundle heuristics and return a sorted CrossFlag list.
 *
 * @param bundles        - All loaded bundles (must be >= 2 to produce any flags).
 * @param indices        - Map from Bundle.id to EventIndex (same shape as BundleContext).
 * @param configOverride - Optional partial config override.
 */
export function runCrossHeuristics(
  bundles: Bundle[],
  indices: Map<string, EventIndex>,
  configOverride?: Partial<CrossHeuristicConfig>,
): CrossFlag[] {
  if (bundles.length < 2) return [];

  const config: CrossHeuristicConfig = {
    ...DEFAULT_CROSS_HEURISTIC_CONFIG,
    ...configOverride,
  };

  const allFlags: CrossFlag[] = [];

  for (const heuristic of CROSS_HEURISTIC_REGISTRY) {
    const flags = heuristic.run(bundles, indices, config);
    allFlags.push(...flags);
  }

  // Sort: severity desc → confidence desc → bundleIds[0] lex asc → id lex asc.
  allFlags.sort((a, b) => {
    const sevDiff = severityRank(a) - severityRank(b);
    if (sevDiff !== 0) return sevDiff;

    const confDiff = b.confidence - a.confidence;
    if (confDiff !== 0) return confDiff;

    const bIdA = a.bundleIds[0] ?? '';
    const bIdB = b.bundleIds[0] ?? '';
    if (bIdA < bIdB) return -1;
    if (bIdA > bIdB) return 1;

    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return allFlags;
}
