/**
 * Per-submission stats service — PRD §8.9.
 *
 * GET /submissions/{submissionId}/stats
 *
 * Returns per_file stats from per_file_stats table plus a computed aggregate
 * (sum across all files).
 */

import { eq } from 'drizzle-orm';
import { per_file_stats } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type PerFileStat = {
  path: string;
  chars_typed: number;
  chars_pasted: number;
  chars_external_change_delta: number;
  saves: number;
  final_length: number;
  start_length: number;
  reconstruction_tainted: boolean;
};

export type SubmissionStats = {
  per_file: PerFileStat[];
  aggregate: {
    chars_typed: number;
    chars_pasted: number;
    chars_external_change_delta: number;
    saves: number;
    files: number;
  };
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getSubmissionStats(
  db: DrizzleDb,
  submissionId: string,
): Promise<SubmissionStats> {
  const rows = await db
    .select({
      file_path: per_file_stats.file_path,
      chars_typed: per_file_stats.chars_typed,
      chars_pasted: per_file_stats.chars_pasted,
      chars_external_change_delta: per_file_stats.chars_external_change_delta,
      saves: per_file_stats.saves,
      final_length: per_file_stats.final_length,
      start_length: per_file_stats.start_length,
      reconstruction_tainted: per_file_stats.reconstruction_tainted,
    })
    .from(per_file_stats)
    .where(eq(per_file_stats.submission_id, submissionId));

  const per_file: PerFileStat[] = rows.map((r) => ({
    path: r.file_path,
    chars_typed: r.chars_typed,
    chars_pasted: r.chars_pasted,
    chars_external_change_delta: r.chars_external_change_delta,
    saves: r.saves,
    final_length: r.final_length,
    start_length: r.start_length,
    reconstruction_tainted: r.reconstruction_tainted,
  }));

  // Compute aggregate (sum across files)
  let chars_typed = 0;
  let chars_pasted = 0;
  let chars_external_change_delta = 0;
  let saves = 0;
  for (const f of per_file) {
    chars_typed += f.chars_typed;
    chars_pasted += f.chars_pasted;
    chars_external_change_delta += f.chars_external_change_delta;
    saves += f.saves;
  }

  return {
    per_file,
    aggregate: {
      chars_typed,
      chars_pasted,
      chars_external_change_delta,
      saves,
      files: per_file.length,
    },
  };
}
