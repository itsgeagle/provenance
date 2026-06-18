import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db.js';
import { roster_entries, semesters, courses } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import { assignMissingProtectedIndices } from './protected-index.js';

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

describe('assignMissingProtectedIndices', () => {
  it('assigns unique 1..N indices to rows with NULL protected_index', async () => {
    await withTestDb(async (db) => {
      const semId = await seedSemester(db);
      for (let i = 0; i < 5; i++) {
        await db
          .insert(roster_entries)
          .values({ semester_id: semId, sid: `s${i}`, display_name: `Name ${i}` });
      }
      await assignMissingProtectedIndices(db, semId);
      const rows = await db
        .select({ pi: roster_entries.protected_index })
        .from(roster_entries)
        .where(sql`${roster_entries.semester_id} = ${semId}`);
      const indices = rows.map((r) => r.pi).sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(indices).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('continues numbering from the existing max for newly-added NULL rows', async () => {
    await withTestDb(async (db) => {
      const semId = await seedSemester(db);
      await db
        .insert(roster_entries)
        .values({ semester_id: semId, sid: 'a', display_name: 'A', protected_index: 1 });
      await db.insert(roster_entries).values({ semester_id: semId, sid: 'b', display_name: 'B' });
      await assignMissingProtectedIndices(db, semId);
      const rows = await db
        .select({ pi: roster_entries.protected_index })
        .from(roster_entries)
        .where(sql`${roster_entries.semester_id} = ${semId}`);
      const indices = rows.map((r) => r.pi).sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(indices).toEqual([1, 2]);
    });
  });
});
