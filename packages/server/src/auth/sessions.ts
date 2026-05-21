/**
 * Session storage primitives — backed by the `sessions` table.
 *
 * Session id: 256-bit (32 bytes) of cryptographically random data,
 * base64url-encoded without padding → 43 characters (PRD §4.2).
 *
 * We use Node's built-in `crypto.randomBytes` rather than oslo/crypto
 * because it avoids a sub-package import and produces identical output.
 */

import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { sessions } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import type { Session } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Session id generation
// ---------------------------------------------------------------------------

/**
 * Generates a 256-bit (32-byte) random session id, base64url-encoded.
 * Output is 43 characters (no padding), as per PRD §4.2.
 */
export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateSessionArgs {
  userId: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Creates a new session row and returns the new session id.
 */
export async function createSession(db: DrizzleDb, args: CreateSessionArgs): Promise<string> {
  const id = generateSessionId();
  await db.insert(sessions).values({
    id,
    user_id: args.userId,
    expires_at: args.expiresAt,
    ip: args.ip ?? null,
    user_agent: args.userAgent ?? null,
  });
  return id;
}

/**
 * Looks up a session by id.
 * Returns `null` if the session does not exist or is expired.
 */
export async function findSession(db: DrizzleDb, sessionId: string): Promise<Session | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.expires_at <= now) return null;
  return row;
}

/**
 * Deletes a session row by id.
 * No-ops if the session does not exist.
 */
export async function deleteSession(db: DrizzleDb, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Extends a session's expiry and bumps `last_seen_at`.
 *
 * Updates `last_seen_at = now()` and `expires_at = newExpiresAt` in one write.
 * The caller decides whether an extension is warranted (e.g. more than half
 * the TTL has elapsed since creation) and passes the new `expires_at`.
 */
export async function extendSession(
  db: DrizzleDb,
  sessionId: string,
  newExpiresAt: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({
      last_seen_at: sql`now()`,
      expires_at: newExpiresAt,
    })
    .where(eq(sessions.id, sessionId));
}

/**
 * Computes the session expiry Date given a TTL in days.
 */
export function sessionExpiresAt(ttlDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + ttlDays);
  return d;
}
