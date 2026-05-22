/**
 * Per-submission files list service — PRD §8.9.
 *
 * GET /submissions/{submissionId}/files
 *
 * Returns path + final_length + saves only (no content or reconstruction —
 * those are Phase 18).
 */

import { eq } from 'drizzle-orm';
import { per_file_stats } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type SubmissionFileEntry = {
  path: string;
  final_length: number;
  saves: number;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getSubmissionFiles(
  db: DrizzleDb,
  submissionId: string,
): Promise<SubmissionFileEntry[]> {
  const rows = await db
    .select({
      file_path: per_file_stats.file_path,
      final_length: per_file_stats.final_length,
      saves: per_file_stats.saves,
    })
    .from(per_file_stats)
    .where(eq(per_file_stats.submission_id, submissionId));

  return rows.map((r) => ({
    path: r.file_path,
    final_length: r.final_length,
    saves: r.saves,
  }));
}
