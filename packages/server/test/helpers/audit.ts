/**
 * Shared audit log assertion helper for integration tests.
 *
 * The audit middleware is fire-and-forget: the insert promise is detached from
 * the HTTP response. Tests must poll the DB to wait for the insert to settle
 * before asserting audit_log state.
 */

import { eq, and } from 'drizzle-orm';
import type { DrizzleDb } from '../../src/db/client.js';
import { audit_log } from '../../src/db/schema.js';

/**
 * Polls audit_log until a matching row appears or the retry limit is reached.
 *
 * @param db       - Drizzle DB instance.
 * @param action   - The action string to match (e.g. 'member.invite').
 * @param targetId - The target_id to match (e.g. a UUID).
 * @param retries  - Number of polling attempts (default 5, ~250ms max).
 *
 * Returns the first matching row, or undefined if none found after retries.
 */
export async function waitForAuditRow(
  db: DrizzleDb,
  action: string,
  targetId: string,
  retries = 5,
): Promise<typeof audit_log.$inferSelect | undefined> {
  for (let i = 0; i <= retries; i++) {
    const rows = await db
      .select()
      .from(audit_log)
      .where(and(eq(audit_log.action, action), eq(audit_log.target_id, targetId)));
    if (rows.length > 0) return rows[0];
    if (i < retries) await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}
