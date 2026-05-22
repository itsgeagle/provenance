/**
 * Resolves semester_id from a submission_id.
 *
 * Used by per-submission route handlers that need inline auth (cannot use
 * requireAuth middleware because semesterId is unknown until after the DB fetch).
 *
 * Returns null if the submission does not exist.
 */

import { eq } from 'drizzle-orm';
import { submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

export async function resolveSemesterFromSubmission(
  db: DrizzleDb,
  submissionId: string,
): Promise<string | null> {
  const rows = await db
    .select({ semester_id: submissions.semester_id })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);

  return rows.length > 0 ? rows[0]!.semester_id : null;
}
