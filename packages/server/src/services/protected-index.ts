/**
 * Assigns roster_entries.protected_index to any rows in a semester that lack one.
 *
 * Indices are per-semester, name-independent (randomized order), and continue
 * from the current max so previously-assigned students keep their label. Used
 * by the 0015 migration backfill and by roster import (commitRoster).
 */
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../db/client.js';

export async function assignMissingProtectedIndices(
  db: DrizzleDb,
  semesterId: string,
): Promise<void> {
  await db.execute(sql`
    WITH base AS (
      SELECT COALESCE(MAX(protected_index), 0) AS max_idx
      FROM roster_entries
      WHERE semester_id = ${semesterId}
    ),
    numbered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY random()) AS rn
      FROM roster_entries
      WHERE semester_id = ${semesterId} AND protected_index IS NULL
    )
    UPDATE roster_entries r
    SET protected_index = base.max_idx + numbered.rn
    FROM numbered, base
    WHERE r.id = numbered.id
  `);
}
