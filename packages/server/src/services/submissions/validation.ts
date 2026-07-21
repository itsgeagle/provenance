/**
 * Per-submission validation service — PRD §8.9.
 *
 * GET /submissions/{submissionId}/validation
 *
 * Returns { overall, checks, validated_at }. The per-check rows come from the
 * `detail` jsonb column, which stores the full ValidationCheck[] produced by
 * runValidation at ingest. The flat check_N_status columns in the DB are a
 * storage artifact (used by cohort-list filtering) and are not surfaced here.
 */

import { eq } from 'drizzle-orm';
import { validation_results } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type ValidationCheckRow = {
  id: string;
  /**
   * Human-readable check name ("Monotonic wall clock"). runAndStoreValidation
   * writes the full ValidationCheck[] verbatim, so this has always been present
   * in the stored jsonb — it was simply narrowed away here, leaving the
   * analyzer to print raw ids. Optional because rows are read back untyped.
   */
  label?: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  detail?: string;
};

export type SubmissionValidation = {
  overall: 'pass' | 'warn' | 'fail';
  checks: ValidationCheckRow[];
  validated_at: string;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getSubmissionValidation(
  db: DrizzleDb,
  submissionId: string,
): Promise<SubmissionValidation | null> {
  const rows = await db
    .select({
      overall: validation_results.overall,
      detail: validation_results.detail,
      validated_at: validation_results.validated_at,
    })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0]!;

  const checks = Array.isArray(r.detail) ? (r.detail as ValidationCheckRow[]) : [];

  return {
    overall: r.overall as 'pass' | 'warn' | 'fail',
    checks,
    validated_at: r.validated_at.toISOString(),
  };
}
