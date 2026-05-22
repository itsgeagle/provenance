/**
 * Submission summary service — PRD §8.9.
 *
 * Aggregates the GET /submissions/{id} response from already-stored rows:
 *   - submissions (core columns)
 *   - JOIN assignments (id, assignment_id_str, label)
 *   - JOIN roster_entries (id, sid, display_name)
 *   - flag_counts: {info,low,medium,high} via GROUP BY severity
 *   - session_ids: string[] via DISTINCT events.session_id
 *   - files: {path,final_length,saves}[] from per_file_stats
 *   - validation_overall_detail: string | null — synthesized from validation_results.detail
 *
 * validation_overall_detail synthesis:
 *   Reads the jsonb detail array (array of ValidationCheck objects stored by
 *   runAndStoreValidation). Extracts checks whose status is 'fail' or 'skipped'.
 *   Formats them as "id=status (cause: detail)" joined by ", ". Returns null if
 *   all checks pass.
 *
 * Implementation: 4 separate queries (submissions+joins, flags aggregate,
 * session_ids distinct, per_file_stats) rather than a single sprawling JOIN.
 * Readable and performant at the scale of a single submission.
 */

import { eq, sql } from 'drizzle-orm';
import {
  submissions,
  assignments,
  roster_entries,
  flags,
  events,
  per_file_stats,
  validation_results,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type SubmissionSummary = {
  id: string;
  semester_id: string;
  assignment: { id: string; assignment_id_str: string; label: string };
  student: { id: string; sid: string; display_name: string };
  ingested_at: string;
  source_filename: string;
  blob_sha256: string;
  recorder_version: string;
  format_version: string;
  validation_status: string;
  validation_overall_detail: string | null;
  score_total: number;
  score_max_severity: string;
  flag_counts: { info: number; low: number; medium: number; high: number };
  session_ids: string[];
  files: { path: string; final_length: number; saves: number }[];
  superseded: boolean;
  superseded_by_submission_id: string | null;
  heuristic_config_version: number;
  recompute_status: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize a human-readable validation detail string from the stored jsonb.
 *
 * The detail column stores the ValidationCheck array as-is (from runValidation).
 * We extract failed/skipped checks and format: "id=status (cause: detail)".
 * If all pass, return null.
 */
function synthesizeValidationDetail(detail: unknown, overall: string): string | null {
  if (overall === 'pass') return null;
  if (!Array.isArray(detail)) return null;

  const failing: string[] = [];
  for (const check of detail) {
    if (check !== null && typeof check === 'object' && 'id' in check && 'status' in check) {
      const c = check as { id: string; status: string; detail?: string };
      if (c.status === 'fail' || c.status === 'skipped') {
        const cause = c.detail ? ` (cause: ${c.detail})` : '';
        failing.push(`${c.id}=${c.status}${cause}`);
      }
    }
  }

  return failing.length > 0 ? failing.join(', ') : null;
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

export async function getSubmissionSummary(
  db: DrizzleDb,
  submissionId: string,
): Promise<SubmissionSummary | null> {
  // Query 1: core submission + assignment + student JOINs
  const rows = await db
    .select({
      id: submissions.id,
      semester_id: submissions.semester_id,
      ingested_at: submissions.ingested_at,
      source_filename: submissions.source_filename,
      blob_sha256: submissions.blob_sha256,
      recorder_version: submissions.recorder_version,
      format_version: submissions.format_version,
      validation_status: submissions.validation_status,
      score_total: submissions.score_total,
      score_max_severity: submissions.score_max_severity,
      heuristic_config_version: submissions.heuristic_config_version,
      recompute_status: submissions.recompute_status,
      superseded_by_submission_id: submissions.superseded_by_submission_id,
      assignment_id: assignments.id,
      assignment_id_str: assignments.assignment_id_str,
      assignment_label: assignments.label,
      student_id: roster_entries.id,
      student_sid: roster_entries.sid,
      student_display_name: roster_entries.display_name,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    .innerJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .where(eq(submissions.id, submissionId))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;

  // Query 2: flag_counts (GROUP BY severity)
  const flagRows = await db
    .select({
      severity: flags.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(flags)
    .where(eq(flags.submission_id, submissionId))
    .groupBy(flags.severity);

  const flag_counts = { info: 0, low: 0, medium: 0, high: 0 };
  for (const f of flagRows) {
    const sev = f.severity as 'info' | 'low' | 'medium' | 'high';
    if (sev in flag_counts) flag_counts[sev] = f.count;
  }

  // Query 3: DISTINCT session_ids from events
  const sessionRows = await db
    .selectDistinct({ session_id: events.session_id })
    .from(events)
    .where(eq(events.submission_id, submissionId));

  const session_ids = sessionRows.map((r) => r.session_id);

  // Query 4: per_file_stats for files list
  const fileRows = await db
    .select({
      path: per_file_stats.file_path,
      final_length: per_file_stats.final_length,
      saves: per_file_stats.saves,
    })
    .from(per_file_stats)
    .where(eq(per_file_stats.submission_id, submissionId));

  const files = fileRows.map((f) => ({
    path: f.path,
    final_length: f.final_length,
    saves: f.saves,
  }));

  // Query 5: validation detail (for synthesis)
  const valRows = await db
    .select({ overall: validation_results.overall, detail: validation_results.detail })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  const validation_overall_detail =
    valRows.length > 0 ? synthesizeValidationDetail(valRows[0]!.detail, valRows[0]!.overall) : null;

  return {
    id: row.id,
    semester_id: row.semester_id,
    assignment: {
      id: row.assignment_id,
      assignment_id_str: row.assignment_id_str,
      label: row.assignment_label,
    },
    student: {
      id: row.student_id,
      sid: row.student_sid,
      display_name: row.student_display_name,
    },
    ingested_at: row.ingested_at.toISOString(),
    source_filename: row.source_filename,
    blob_sha256: row.blob_sha256,
    recorder_version: row.recorder_version,
    format_version: row.format_version,
    validation_status: row.validation_status,
    validation_overall_detail,
    score_total: row.score_total,
    score_max_severity: row.score_max_severity,
    flag_counts,
    session_ids,
    files,
    superseded: row.superseded_by_submission_id !== null,
    superseded_by_submission_id: row.superseded_by_submission_id,
    heuristic_config_version: row.heuristic_config_version,
    recompute_status: row.recompute_status,
  };
}
