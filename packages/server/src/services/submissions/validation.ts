/**
 * Per-submission validation service — PRD §8.9.
 *
 * GET /submissions/{submissionId}/validation
 *
 * Returns the validation_results row as-is: 8 check statuses, overall, detail.
 */

import { eq } from 'drizzle-orm';
import { validation_results } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type SubmissionValidation = {
  submission_id: string;
  check_1_status: string;
  check_2_status: string;
  check_3_status: string;
  check_4_status: string;
  check_5_status: string;
  check_6_status: string;
  check_7_status: string;
  check_8_status: string;
  overall: string;
  detail: unknown;
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
    .select()
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0]!;

  return {
    submission_id: r.submission_id,
    check_1_status: r.check_1_status,
    check_2_status: r.check_2_status,
    check_3_status: r.check_3_status,
    check_4_status: r.check_4_status,
    check_5_status: r.check_5_status,
    check_6_status: r.check_6_status,
    check_7_status: r.check_7_status,
    check_8_status: r.check_8_status,
    overall: r.overall,
    detail: r.detail,
    validated_at: r.validated_at.toISOString(),
  };
}
