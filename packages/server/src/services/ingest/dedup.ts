/**
 * Phase 2 of the per-file ingest pipeline: deduplication (PRD §9.3).
 *
 * A file is a duplicate when an existing `submissions` row for the same
 * (semester_id, blob_sha256) already exists. If found the caller should
 * mark `ingest_files.status='duplicate'`, link `submission_id`, and skip
 * the remaining pipeline phases.
 *
 * This function is a pure DB read — no side effects, no blob I/O.
 */

import { eq, and } from 'drizzle-orm';
import { submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DedupResult =
  | {
      /** File is a duplicate of an existing submission. */
      isDuplicate: true;
      /** UUID of the existing submission row. */
      existingSubmissionId: string;
    }
  | {
      /** No match found — proceed with the pipeline. */
      isDuplicate: false;
    };

// ---------------------------------------------------------------------------
// dedupFile
// ---------------------------------------------------------------------------

/**
 * Check whether a blob with the given `sha256` has already been ingested into
 * the given semester.
 *
 * Looks up `submissions` by `(semester_id, blob_sha256)`.  If a match exists,
 * returns `{ isDuplicate: true, existingSubmissionId }`. Otherwise returns
 * `{ isDuplicate: false }`.
 *
 * The query uses `submissions_blob_sha_idx` (defined on `(semester_id, blob_sha256)`
 * in migration 0006) for O(log n) lookup — no sequential scan.
 *
 * Superseded submissions are still detected as duplicates: re-uploading an
 * exact same blob as a student's earlier version should not produce a new
 * submission — it is a true duplicate regardless of whether that prior version
 * was later superseded.
 */
export async function dedupFile(
  db: DrizzleDb,
  semesterId: string,
  blobSha256: string,
): Promise<DedupResult> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.semester_id, semesterId), eq(submissions.blob_sha256, blobSha256)))
    .limit(1);

  if (rows.length > 0) {
    return { isDuplicate: true, existingSubmissionId: rows[0]!.id };
  }

  return { isDuplicate: false };
}
