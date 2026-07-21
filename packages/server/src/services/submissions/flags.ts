/**
 * Per-submission flags service — PRD §8.9.
 *
 * GET /submissions/{submissionId}/flags
 *
 * Returns all flags for a submission ordered by severity desc, confidence desc.
 */

import { eq, sql } from 'drizzle-orm';
import { flags } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type FlagRow = {
  id: string;
  heuristic_id: string;
  severity: string;
  confidence: number;
  weight_at_compute: number;
  score_contribution: number;
  /**
   * Per-instance prose from analysis-core. Empty string on rows written before
   * migration 0020 — clients fall back to heuristic_id.
   */
  title: string;
  description: string;
  detail: unknown;
  supporting_seqs: number[];
  session_id: string;
  created_at: string;
  heuristic_config_version: number;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getSubmissionFlags(db: DrizzleDb, submissionId: string): Promise<FlagRow[]> {
  const rows = await db
    .select({
      id: flags.id,
      heuristic_id: flags.heuristic_id,
      severity: flags.severity,
      confidence: flags.confidence,
      weight_at_compute: flags.weight_at_compute,
      score_contribution: flags.score_contribution,
      title: flags.title,
      description: flags.description,
      detail: flags.detail,
      supporting_seqs: flags.supporting_seqs,
      session_id: flags.session_id,
      created_at: flags.created_at,
      heuristic_config_version: flags.heuristic_config_version,
    })
    .from(flags)
    .where(eq(flags.submission_id, submissionId))
    .orderBy(
      // Severity rank: high=3 > medium=2 > low=1 > info=0 (descending)
      // Alphabetical sort on severity text does NOT match severity rank.
      sql`CASE ${flags.severity} WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC`,
      sql`${flags.confidence} DESC`,
    );

  return rows.map((r) => ({
    id: r.id,
    heuristic_id: r.heuristic_id,
    severity: r.severity,
    confidence: r.confidence,
    weight_at_compute: r.weight_at_compute,
    score_contribution: r.score_contribution,
    title: r.title,
    description: r.description,
    detail: r.detail,
    supporting_seqs: r.supporting_seqs as number[],
    session_id: r.session_id,
    created_at: r.created_at.toISOString(),
    heuristic_config_version: r.heuristic_config_version,
  }));
}
