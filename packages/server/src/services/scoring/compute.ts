/**
 * computeScore — apply PRD §10.3 scoring formula to a list of flags.
 *
 * Pure function; no I/O, no side effects.
 *
 * PRD §10.3:
 *   score_total       = Σ score_contribution  (over all flags)
 *   score_max_severity = highest severity among any flag
 *                       (defaults to 'info' when flag list is empty)
 *
 * The score_contribution values are pre-computed per flag and stored in the
 * `flags` table. This function just aggregates them.
 *
 * Severity ordering: high > medium > low > info.
 */

import type { Severity } from '@provenance/analyzer/src/heuristics/types.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Compute the aggregate score from a list of flag score contributions and
 * severities.
 *
 * @param flags - Array of flag data from the flags table (or in-memory rows).
 * @returns `{ score_total, score_max_severity }` ready to be written into the
 *   submissions row.
 */
export function computeScore(flags: Array<{ severity: string; score_contribution: number }>): {
  score_total: number;
  score_max_severity: Severity;
} {
  if (flags.length === 0) {
    return { score_total: 0, score_max_severity: 'info' };
  }

  let scoreTotal = 0;
  let maxSeverity: Severity = 'info';

  for (const f of flags) {
    scoreTotal += f.score_contribution;
    const sev = f.severity as Severity;
    if ((SEVERITY_ORDER[sev] ?? 0) > (SEVERITY_ORDER[maxSeverity] ?? 0)) {
      maxSeverity = sev;
    }
  }

  return { score_total: scoreTotal, score_max_severity: maxSeverity };
}
