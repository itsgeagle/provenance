/**
 * Integration tests for commitRoster (Phase 8: protected_index assignment).
 *
 * Verifies that after a roster commit that adds new rows, every roster_entries
 * row in that semester has a non-null, unique protected_index.
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { roster_entries, semesters, courses } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { commitRoster } from './index.js';
import type { CachedPreview } from './preview-cache.js';

async function seedSemester(db: DrizzleDb): Promise<string> {
  const uid = crypto.randomUUID().slice(0, 8);
  const [course] = await db
    .insert(courses)
    .values({ name: 'Test Course', slug: `c-${uid}` })
    .returning();
  const [sem] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `s-${uid}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();
  return sem!.id;
}

function makePreview(semesterId: string, sids: string[]): CachedPreview {
  return {
    semesterId,
    toAdd: sids.map((sid) => ({
      sid,
      display_name: `Student ${sid}`,
      email: null,
      extras: {},
    })),
    toUpdate: [],
    toDelete: [],
    createdAt: Date.now(),
  };
}

describe('commitRoster — protected_index assignment', () => {
  it('assigns a non-null unique protected_index to every row after a roster commit', async () => {
    await withTestDb(async (db) => {
      const semId = await seedSemester(db);
      const preview = makePreview(semId, ['s1', 's2', 's3', 's4', 's5']);

      await commitRoster(db, semId, preview, false);

      const rows = await db
        .select({ pi: roster_entries.protected_index })
        .from(roster_entries)
        .where(sql`${roster_entries.semester_id} = ${semId}`);

      // Every row must have a non-null protected_index.
      expect(rows.every((r) => r.pi !== null)).toBe(true);

      // Indices must be unique.
      const values = rows.map((r) => r.pi as number).sort((a, b) => a - b);
      const unique = [...new Set(values)];
      expect(unique).toHaveLength(values.length);

      // Indices must be exactly 1..N.
      expect(values).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('continues numbering from the existing max when new rows are added', async () => {
    await withTestDb(async (db) => {
      const semId = await seedSemester(db);

      // Seed an existing row that already has protected_index = 1.
      await db.insert(roster_entries).values({
        semester_id: semId,
        sid: 'existing',
        display_name: 'Existing Student',
        protected_index: 1,
      });

      // Now commit a preview that adds two new rows.
      const preview = makePreview(semId, ['new1', 'new2']);
      await commitRoster(db, semId, preview, false);

      const rows = await db
        .select({ pi: roster_entries.protected_index })
        .from(roster_entries)
        .where(sql`${roster_entries.semester_id} = ${semId}`);

      const values = rows.map((r) => r.pi as number).sort((a, b) => a - b);
      // Existing row keeps 1; new rows get 2 and 3.
      expect(values).toEqual([1, 2, 3]);
    });
  });
});
