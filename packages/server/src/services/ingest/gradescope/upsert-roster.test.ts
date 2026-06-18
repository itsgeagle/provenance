/**
 * Integration tests for upsertRosterFromSubmitters — uses withTestDb (Docker).
 */

import { vi, describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { courses, semesters, roster_entries } from '../../../db/schema.js';
import { upsertRosterFromSubmitters } from './upsert-roster.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function seedSemester(db: DrizzleDb): Promise<string> {
  const slug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
  const [course] = await db.insert(courses).values({ name: 'CS 61A', slug }).returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2026,
      slug: `fa2026-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Fall 2026',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();
  return semester!.id;
}

async function getEntry(db: DrizzleDb, semesterId: string, sid: string) {
  const [row] = await db
    .select()
    .from(roster_entries)
    .where(and(eq(roster_entries.semester_id, semesterId), eq(roster_entries.sid, sid)));
  return row;
}

describe('upsertRosterFromSubmitters', () => {
  it('inserts new entries and reports them as added', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      const result = await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'Alice', email: 'alice@berkeley.edu' },
        { sid: '200', name: 'Bob', email: 'bob@berkeley.edu' },
      ]);
      expect(result).toEqual({ added: 2, updated: 0 });

      const alice = await getEntry(db, semesterId, '100');
      expect(alice!.display_name).toBe('Alice');
      expect(alice!.email).toBe('alice@berkeley.edu');
    });
  });

  it('falls back to email then sid for display_name on new entries', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '300', email: 'noname@berkeley.edu' },
        { sid: '400' },
      ]);
      expect((await getEntry(db, semesterId, '300'))!.display_name).toBe('noname@berkeley.edu');
      expect((await getEntry(db, semesterId, '400'))!.display_name).toBe('400');
    });
  });

  it('updates existing entries; a missing name does not clobber the stored name', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'Alice Original', email: 'alice@berkeley.edu' },
      ]);

      // Re-upsert: new email present, name absent.
      const result = await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', email: 'alice.new@berkeley.edu' },
      ]);
      expect(result).toEqual({ added: 0, updated: 1 });

      const alice = await getEntry(db, semesterId, '100');
      // Name preserved, email updated.
      expect(alice!.display_name).toBe('Alice Original');
      expect(alice!.email).toBe('alice.new@berkeley.edu');
    });
  });

  it('never deletes roster entries not present in the submitters', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await upsertRosterFromSubmitters(db, semesterId, [{ sid: '100', name: 'Keep Me' }]);
      // A second export that does not include sid 100.
      await upsertRosterFromSubmitters(db, semesterId, [{ sid: '999', name: 'New One' }]);

      expect(await getEntry(db, semesterId, '100')).toBeDefined();
      expect(await getEntry(db, semesterId, '999')).toBeDefined();
    });
  });

  it('dedupes submitters passed with a repeated sid', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      const result = await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'First' },
        { sid: '100', name: 'Second' },
      ]);
      expect(result).toEqual({ added: 1, updated: 0 });
      expect((await getEntry(db, semesterId, '100'))!.display_name).toBe('First');
    });
  });
});
