/**
 * Denormalized cohort-list columns (P1-1a).
 *
 * `submissions.flag_counts`, `submissions.top_flags`, and
 * `submissions.severity_rank` are written by the heuristic-compute path so
 * the cohort list query can answer per-row stats from a single index scan
 * instead of running two correlated sub-queries per page.
 *
 * Both write call-sites (ingest's run-per-submission, recompute-submission)
 * call into the helpers below so the convention is in one place. If the
 * shape ever changes, update here and the migration's backfill in lockstep.
 */

import type { Severity } from '@provenance/analyzer/src/heuristics/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlagCounts = { info: number; low: number; medium: number; high: number };

export type TopFlagEntry = { heuristic_id: string; severity: Severity };

export type SeverityRank = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// severity_rank: numeric mirror of score_max_severity
// ---------------------------------------------------------------------------

export const SEVERITY_RANK: Record<Severity, SeverityRank> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

// ---------------------------------------------------------------------------
// Computation from a flat flag list
//
// Accepts either the in-memory flag rows from run-per-submission or the
// translated rows from recompute-submission — both expose { severity,
// confidence, heuristic_id }. We use `severity_weight * confidence` as the
// flag-level severity score for the top_flags ordering. Within a severity
// tier, higher confidence wins. This matches the ROW_NUMBER ordering the
// old cohort/list.ts query used.
// ---------------------------------------------------------------------------

const TOP_FLAGS_MAX = 3;

type FlagLike = {
  heuristic_id: string;
  severity: string;
  confidence: number;
};

export function computeFlagCounts(rows: FlagLike[]): FlagCounts {
  const counts: FlagCounts = { info: 0, low: 0, medium: 0, high: 0 };
  for (const r of rows) {
    const sev = r.severity as Severity;
    if (sev === 'info') counts.info += 1;
    else if (sev === 'low') counts.low += 1;
    else if (sev === 'medium') counts.medium += 1;
    else if (sev === 'high') counts.high += 1;
  }
  return counts;
}

export function computeTopFlags(rows: FlagLike[]): TopFlagEntry[] {
  const ranked = rows
    .filter((r) => (SEVERITY_RANK[r.severity as Severity] ?? 0) >= 0)
    .map((r) => ({
      heuristic_id: r.heuristic_id,
      severity: r.severity as Severity,
      rank: SEVERITY_RANK[r.severity as Severity] ?? 0,
      confidence: r.confidence,
    }))
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return b.confidence - a.confidence;
    });
  return ranked.slice(0, TOP_FLAGS_MAX).map((r) => ({
    heuristic_id: r.heuristic_id,
    severity: r.severity,
  }));
}
