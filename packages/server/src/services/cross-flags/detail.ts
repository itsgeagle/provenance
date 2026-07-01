/**
 * Cross-flag detail service — PRD §8.10.
 *
 * GET /cross-flags/{crossFlagId}
 *
 * Returns the same CrossFlagSummary shape with full participants list.
 * The semester_id is derived from the cross_flags row, so the route
 * can check membership without the caller providing it.
 */

import { eq } from 'drizzle-orm';
import { cross_flags } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { CrossFlagSummary } from './list.js';
import { fetchParticipants } from './list.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';

export type CrossFlagDetailResult = {
  item: CrossFlagSummary;
  semesterId: string;
} | null;

export async function getCrossFlag(
  db: DrizzleDb,
  crossFlagId: string,
  protectedMode: boolean,
): Promise<CrossFlagDetailResult> {
  const rows = await db
    .select({
      id: cross_flags.id,
      semester_id: cross_flags.semester_id,
      heuristic_id: cross_flags.heuristic_id,
      severity: cross_flags.severity,
      confidence: cross_flags.confidence,
      detail: cross_flags.detail,
      created_at: cross_flags.created_at,
    })
    .from(cross_flags)
    .where(eq(cross_flags.id, crossFlagId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0]!;
  const participantsMap = await fetchParticipants(db, [row.id], protectedMode);

  return {
    item: {
      id: row.id,
      heuristic_id: row.heuristic_id,
      severity: row.severity as Severity,
      confidence: row.confidence,
      participants: participantsMap.get(row.id) ?? [],
      detail: row.detail,
      created_at: row.created_at.toISOString(),
    },
    semesterId: row.semester_id,
  };
}
