/**
 * Phase 7 of the per-file ingest pipeline: compute and store per-file stats
 * (PRD §9.3, §5.4).
 *
 * Wraps v2's pure computeStats (over EventIndex built from the in-memory
 * bundle) and persists one row per file into per_file_stats. Idempotent via
 * ON CONFLICT DO UPDATE.
 *
 * Design: final_length and start_length are stored as 0. Computing them
 * requires file reconstruction (Phase 18). v2 FileStats does not provide them.
 */

import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import { computeStats } from '@provenance/analyzer/src/index/stats.js';
import type { Bundle } from '@provenance/analyzer/src/loader/types.js';
import { per_file_stats } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/client.js';

export async function computeAndStoreStats(
  db: DrizzleDb,
  submissionId: string,
  bundle: Bundle,
): Promise<void> {
  const index = buildIndex(bundle);
  const bundleStats = computeStats(index);
  if (bundleStats.perFile.size === 0) return;

  const rows = Array.from(bundleStats.perFile.values()).map((fs) => ({
    submission_id: submissionId,
    file_path: fs.filePath,
    chars_typed: fs.charsTyped,
    chars_pasted: fs.charsPasted,
    chars_external_change_delta: fs.charsExternalChangeDelta,
    saves: fs.saves,
    final_length: 0,
    start_length: 0,
    reconstruction_tainted: fs.reconstructionTainted,
  }));

  await db
    .insert(per_file_stats)
    .values(rows)
    .onConflictDoUpdate({
      target: [per_file_stats.submission_id, per_file_stats.file_path],
      set: {
        chars_typed: sql`EXCLUDED.chars_typed`,
        chars_pasted: sql`EXCLUDED.chars_pasted`,
        chars_external_change_delta: sql`EXCLUDED.chars_external_change_delta`,
        saves: sql`EXCLUDED.saves`,
        final_length: sql`EXCLUDED.final_length`,
        start_length: sql`EXCLUDED.start_length`,
        reconstruction_tainted: sql`EXCLUDED.reconstruction_tainted`,
      },
    });
}
