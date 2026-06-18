/**
 * Upsert roster entries from Gradescope submitters (analyzer PRD §8.4 / §5.2).
 *
 * The Gradescope ingest path populates the roster directly from the export's
 * `submission_metadata.yml` rather than from a separate CSV upload. Per the
 * agreed behaviour this is an *add/update only* upsert — it never deletes
 * existing roster entries (unlike the CSV preview/commit flow, which can delete).
 *
 * Matching is by exact `(semester_id, sid)`, the same key the ingest worker uses
 * to resolve a bundle's `match_sid` to a roster entry, so the sids written here
 * line up with the sids matched later.
 *
 * Update policy: a submitter's name/email overwrites the stored value only when
 * present in the metadata — a metadata row missing a name does not clobber an
 * existing display name. New entries fall back to email, then sid, for the
 * required display_name.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { roster_entries } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import type { GradescopeSubmitter } from './parse-metadata.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RosterUpsertResult {
  added: number;
  updated: number;
}

// ---------------------------------------------------------------------------
// upsertRosterFromSubmitters
// ---------------------------------------------------------------------------

/**
 * Insert new roster entries and update existing ones for the given submitters.
 * Never deletes. Returns how many rows were added vs. updated (an existing sid
 * always counts as "updated", even if no field actually changed).
 *
 * Runs inside a single transaction so the add/update counts are consistent.
 */
export async function upsertRosterFromSubmitters(
  db: DrizzleDb,
  semesterId: string,
  submitters: GradescopeSubmitter[],
): Promise<RosterUpsertResult> {
  // Dedupe by sid (the caller usually passes deduped submitters, but be safe).
  const bySid = new Map<string, GradescopeSubmitter>();
  for (const s of submitters) {
    if (!bySid.has(s.sid)) bySid.set(s.sid, s);
  }
  const unique = Array.from(bySid.values());
  if (unique.length === 0) return { added: 0, updated: 0 };

  return db.transaction(async (tx) => {
    // Which of these sids already exist? Determines added vs updated counts.
    const sids = unique.map((s) => s.sid);
    const existingRows = await tx
      .select({ sid: roster_entries.sid })
      .from(roster_entries)
      .where(and(eq(roster_entries.semester_id, semesterId), inArray(roster_entries.sid, sids)));
    const existing = new Set(existingRows.map((r) => r.sid));

    let added = 0;
    let updated = 0;

    for (const s of unique) {
      // On conflict, overwrite name/email only when the metadata supplies them.
      const set: Record<string, unknown> = { updated_at: sql`now()` };
      if (s.name !== undefined) set['display_name'] = s.name;
      if (s.email !== undefined) set['email'] = s.email;

      await tx
        .insert(roster_entries)
        .values({
          semester_id: semesterId,
          sid: s.sid,
          display_name: s.name ?? s.email ?? s.sid,
          email: s.email ?? null,
        })
        .onConflictDoUpdate({
          target: [roster_entries.semester_id, roster_entries.sid],
          set,
        });

      if (existing.has(s.sid)) updated += 1;
      else added += 1;
    }

    return { added, updated };
  });
}
