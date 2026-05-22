/**
 * Roster service — commit and list operations (PRD §8.4).
 *
 * commitRoster: Applies a cached preview to the database transactionally.
 * listRoster:   Paginated list of roster_entries with optional text search.
 */

import { eq, and, sql, or, gt } from 'drizzle-orm';
import { roster_entries } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import type { CachedPreview } from './preview-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RosterListOptions {
  semesterId: string;
  cursor?: string; // ISO timestamp or ID for cursor pagination
  limit?: number;
  q?: string; // free text on display_name or email (case-insensitive)
}

export interface RosterListResult {
  entries: (typeof roster_entries.$inferSelect)[];
  next_cursor: string | null;
  total_count: number;
}

// ---------------------------------------------------------------------------
// commitRoster
// ---------------------------------------------------------------------------

/**
 * Apply a cached preview to the database.
 *
 * Transactional — all inserts, updates, and deletes apply atomically.
 *
 * @param db               - Drizzle DB instance.
 * @param semesterId       - The semester to commit into (used for inserts).
 * @param preview          - The cached preview containing toAdd/toUpdate/toDelete.
 * @param acceptDeletions  - If true, delete rows in toDelete. If false, skip them.
 * @returns Applied counts: { added, updated, deleted }.
 */
export async function commitRoster(
  db: DrizzleDb,
  semesterId: string,
  preview: CachedPreview,
  acceptDeletions: boolean,
): Promise<{ added: number; updated: number; deleted: number }> {
  let added = 0;
  let updated = 0;
  let deleted = 0;

  await withTransaction(db, async (tx) => {
    // Inserts.
    if (preview.toAdd.length > 0) {
      await tx.insert(roster_entries).values(
        preview.toAdd.map((row) => ({
          semester_id: semesterId,
          sid: row.sid,
          display_name: row.display_name,
          email: row.email ?? undefined,
          extras: row.extras,
        })),
      );
      added = preview.toAdd.length;
    }

    // Updates.
    for (const { existingId, row } of preview.toUpdate) {
      await tx
        .update(roster_entries)
        .set({
          sid: row.sid,
          display_name: row.display_name,
          email: row.email ?? undefined,
          extras: row.extras,
          updated_at: new Date(),
        })
        .where(eq(roster_entries.id, existingId));
      updated++;
    }

    // Deletes (only if acceptDeletions).
    if (acceptDeletions && preview.toDelete.length > 0) {
      for (const { existingId } of preview.toDelete) {
        await tx.delete(roster_entries).where(eq(roster_entries.id, existingId));
        deleted++;
      }
    }
  });

  return { added, updated, deleted };
}

// ---------------------------------------------------------------------------
// listRoster
// ---------------------------------------------------------------------------

/**
 * Paginated list of roster_entries for a semester.
 *
 * @param db       - Drizzle DB instance.
 * @param options  - Pagination + search options.
 * @returns Entries, next_cursor, and total_count.
 */
export async function listRoster(
  db: DrizzleDb,
  options: RosterListOptions,
): Promise<RosterListResult> {
  const { semesterId, limit = 50, q } = options;

  const clampedLimit = Math.min(limit, 500);

  // Build the base WHERE condition.
  const baseConditions = [eq(roster_entries.semester_id, semesterId)];

  // Text search on display_name or email (case-insensitive via ILIKE).
  // Escape user-supplied wildcards so that a literal '%' or '_' searches for
  // those characters rather than acting as LIKE wildcards. The ESCAPE '\' clause
  // is required because PostgreSQL's ILIKE does not treat backslash as an escape
  // character by default — drizzle's ilike() helper doesn't expose ESCAPE, so we
  // use sql`` directly.
  const searchConditions =
    q !== undefined && q !== ''
      ? (() => {
          const escaped = q.replace(/[%_\\]/g, '\\$&');
          const pattern = `%${escaped}%`;
          return [
            or(
              sql`${roster_entries.display_name} ILIKE ${pattern} ESCAPE '\\'`,
              sql`${roster_entries.email} ILIKE ${pattern} ESCAPE '\\'`,
            ),
          ];
        })()
      : [];

  // Cursor-based pagination: cursor is an ISO timestamp from the previous
  // page's last entry's created_at. We select entries where created_at > cursor.
  const cursorCondition =
    options.cursor !== undefined && options.cursor !== ''
      ? [gt(roster_entries.created_at, new Date(options.cursor))]
      : [];

  const allConditions = [...baseConditions, ...searchConditions, ...cursorCondition];

  const [entries, countResult] = await Promise.all([
    db
      .select()
      .from(roster_entries)
      .where(and(...allConditions))
      .orderBy(roster_entries.created_at)
      .limit(clampedLimit + 1), // fetch one extra to detect next page
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(roster_entries)
      .where(
        and(
          eq(roster_entries.semester_id, semesterId),
          // Total count includes search filter but not cursor (represents total matching rows).
          ...(searchConditions.length > 0 ? searchConditions : []),
        ),
      ),
  ]);

  const total_count = countResult[0]?.count ?? 0;

  let next_cursor: string | null = null;
  let resultEntries = entries;

  if (entries.length > clampedLimit) {
    resultEntries = entries.slice(0, clampedLimit);
    const lastEntry = resultEntries[resultEntries.length - 1];
    next_cursor = lastEntry !== undefined ? lastEntry.created_at.toISOString() : null;
  }

  return { entries: resultEntries, next_cursor, total_count };
}

// ---------------------------------------------------------------------------
// updateRosterEntry
// ---------------------------------------------------------------------------

/**
 * Update display_name, email, or extras for a roster entry.
 *
 * Returns null if the entry doesn't exist or belongs to a different semester.
 *
 * @param db       - Drizzle DB instance.
 * @param entryId  - UUID of the roster_entry row.
 * @param semesterId - Must match the entry's semester_id.
 * @param updates  - Fields to update (sid is not allowed).
 */
export async function updateRosterEntry(
  db: DrizzleDb,
  entryId: string,
  semesterId: string,
  updates: {
    display_name?: string;
    email?: string | null;
    extras?: Record<string, string>;
  },
): Promise<typeof roster_entries.$inferSelect | null> {
  const setValues: Partial<typeof roster_entries.$inferInsert> & { updated_at?: Date } = {
    updated_at: new Date(),
  };

  if (updates.display_name !== undefined) {
    setValues.display_name = updates.display_name;
  }
  if ('email' in updates) {
    // null is preserved so Drizzle writes NULL (clears the column).
    // undefined means the caller did not provide this field → omit from SET.
    // The ?? undefined pattern was wrong: null ?? undefined === undefined, which
    // causes Drizzle to omit the column rather than clearing it.
    setValues.email = updates.email;
  }
  if (updates.extras !== undefined) {
    setValues.extras = updates.extras;
  }

  const rows = await db
    .update(roster_entries)
    .set(setValues)
    .where(and(eq(roster_entries.id, entryId), eq(roster_entries.semester_id, semesterId)))
    .returning();

  return rows[0] ?? null;
}
