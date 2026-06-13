import { vi, describe, it, expect } from 'vitest';
import { eq, count, asc } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { materializeEvents, EVENTS_INSERT_CHUNK_SIZE } from './materialize-events.js';
import { events, submissions } from '../../db/schema.js';
import type { Bundle, ParsedSession } from '@provenance/analyzer/src/loader/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function makeEnvelope(seq: number, sessionId: string, wallBaseMs: number) {
  return {
    seq,
    t: seq * 100,
    wall: new Date(wallBaseMs + seq * 1000).toISOString(),
    kind: 'doc.change' as const,
    data: {
      path: 'hw1.py',
      deltas: [{ text: 'x' }],
    } as unknown as ParsedSession['events'][number]['data'],
    prev_hash: seq === 0 ? 'GENESIS' : `h-${sessionId}-${seq - 1}`,
    hash: `h-${sessionId}-${seq}`,
  };
}

function makeSyntheticBundle(totalEvents: number, sessionCount = 1): Bundle {
  const perSession = Math.ceil(totalEvents / sessionCount);
  const sessions: ParsedSession[] = [];
  for (let s = 0; s < sessionCount; s++) {
    const sessionId = `session-${s}`;
    const wallBase = 1_700_000_000_000 + s * 1_000_000;
    const c = Math.min(perSession, totalEvents - s * perSession);
    if (c <= 0) break;
    const envs = Array.from({ length: c }, (_, i) => makeEnvelope(i, sessionId, wallBase));
    sessions.push({
      sessionId,
      events: envs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      meta: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      firstEvent: envs[0] as any,
    });
  }
  return {
    id: crypto.randomUUID(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
    manifest: {} as any,
    manifestSigHex: '',
    sessions,
    sourceFilename: 'test.zip',
    loadedAt: new Date().toISOString(),
    submissionFiles: new Map(),
  };
}

describe('materializeEvents', () => {
  it('10k events: row count matches, seq values 0..9999 contiguous', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeSyntheticBundle(10_000);
      await materializeEvents(db, submissionId, bundle);

      const cntResult = await db
        .select({ cnt: count() })
        .from(events)
        .where(eq(events.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(10_000);

      const rows = await db
        .select({ seq: events.seq })
        .from(events)
        .where(eq(events.submission_id, submissionId))
        .orderBy(asc(events.seq));
      expect(rows[0]!.seq).toBe(0);
      expect(rows[rows.length - 1]!.seq).toBe(9999);
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.seq).toBe(i);
    });
  });

  it('prev_hash and hash round-trip from envelope', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeSyntheticBundle(3);
      await materializeEvents(db, submissionId, bundle);

      const rows = await db
        .select()
        .from(events)
        .where(eq(events.submission_id, submissionId))
        .orderBy(asc(events.seq));
      expect(rows[0]!.prev_hash).toBe('GENESIS');
      expect(rows[0]!.hash).toBe('h-session-0-0');
      expect(rows[1]!.prev_hash).toBe('h-session-0-0');
      expect(rows[2]!.prev_hash).toBe('h-session-0-1');
    });
  });

  it('chunk boundary: CHUNK_SIZE+1 events → 2 chunks, ordering preserved', async () => {
    await withTestDb(async (db) => {
      const n = EVENTS_INSERT_CHUNK_SIZE + 1;
      const submissionId = await seedSubmission(db);
      const bundle = makeSyntheticBundle(n);
      await materializeEvents(db, submissionId, bundle);

      const cntResult = await db
        .select({ cnt: count() })
        .from(events)
        .where(eq(events.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(n);

      const rows = await db
        .select({ seq: events.seq })
        .from(events)
        .where(eq(events.submission_id, submissionId))
        .orderBy(asc(events.seq));
      expect(rows[EVENTS_INSERT_CHUNK_SIZE]!.seq).toBe(EVENTS_INSERT_CHUNK_SIZE);
    });
  });

  it('concurrent materialization of two submissions: no interleaving', async () => {
    await withTestDb(async (db) => {
      const subA = await seedSubmission(db);
      const subB = await seedSubmission(db);
      const bundleA = makeSyntheticBundle(100);
      const bundleB = makeSyntheticBundle(50);
      await Promise.all([
        materializeEvents(db, subA, bundleA),
        materializeEvents(db, subB, bundleB),
      ]);
      const aRows = await db
        .select({ seq: events.seq })
        .from(events)
        .where(eq(events.submission_id, subA))
        .orderBy(asc(events.seq));
      const bRows = await db
        .select({ seq: events.seq })
        .from(events)
        .where(eq(events.submission_id, subB))
        .orderBy(asc(events.seq));
      expect(aRows.length).toBe(100);
      expect(bRows.length).toBe(50);
      expect(aRows[99]!.seq).toBe(99);
      expect(bRows[49]!.seq).toBe(49);
    });
  });

  it('idempotent: re-running on same submissionId is no-op', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeSyntheticBundle(10);
      await materializeEvents(db, submissionId, bundle);
      await materializeEvents(db, submissionId, bundle);
      const cntResult = await db
        .select({ cnt: count() })
        .from(events)
        .where(eq(events.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(10);
    });
  });

  it('CASCADE: deleting submission wipes events', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeSyntheticBundle(5);
      await materializeEvents(db, submissionId, bundle);
      await db.delete(submissions).where(eq(submissions.id, submissionId));
      const cntResult = await db
        .select({ cnt: count() })
        .from(events)
        .where(eq(events.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(0);
    });
  });
});
