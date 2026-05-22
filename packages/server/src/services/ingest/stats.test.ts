import { vi, describe, it, expect } from 'vitest';
import { eq, count } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { computeAndStoreStats } from './stats.js';
import { per_file_stats, submissions } from '../../db/schema.js';
import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import { computeStats } from '@provenance/analyzer/src/index/stats.js';
import type { Bundle, ParsedSession } from '@provenance/analyzer/src/loader/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic Bundle with doc.open + doc.change + doc.save events
 * for two distinct files. The events have real payload shapes that computeStats
 * and reconstructFile can process correctly.
 */
function makeTwoFileBundle(): Bundle {
  const wallBase = 1_700_000_000_000;
  const sessionId = 'session-0';

  // Each "file" gets: doc.open, doc.change (typed), doc.save
  const makeFile = (path: string, offset: number) => [
    {
      seq: offset,
      t: offset * 100,
      wall: new Date(wallBase + offset * 1000).toISOString(),
      kind: 'doc.open' as const,
      data: { path, content: '' } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: offset === 0 ? 'GENESIS' : `h-${offset - 1}`,
      hash: `h-${offset}`,
    },
    {
      seq: offset + 1,
      t: (offset + 1) * 100,
      wall: new Date(wallBase + (offset + 1) * 1000).toISOString(),
      kind: 'doc.change' as const,
      data: {
        path,
        source: 'typed',
        deltas: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: 'hello',
          },
        ],
      } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: `h-${offset}`,
      hash: `h-${offset + 1}`,
    },
    {
      seq: offset + 2,
      t: (offset + 2) * 100,
      wall: new Date(wallBase + (offset + 2) * 1000).toISOString(),
      kind: 'doc.save' as const,
      data: { path, sha256: 'abc123' } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: `h-${offset + 1}`,
      hash: `h-${offset + 2}`,
    },
  ];

  const fileAEvents = makeFile('hw1.py', 0);
  const fileBEvents = makeFile('hw2.py', 3);
  const allEvents = [...fileAEvents, ...fileBEvents];

  const sessions: ParsedSession[] = [
    {
      sessionId,
      events: allEvents,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      meta: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      firstEvent: allEvents[0] as any,
    },
  ];

  return {
    id: crypto.randomUUID(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
    manifest: {} as any,
    manifestSigHex: '',
    sessions,
    sourceFilename: 'test.zip',
    loadedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeAndStoreStats', () => {
  it('DB rows match direct computeStats output for a 2-file bundle', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeTwoFileBundle();
      await computeAndStoreStats(db, submissionId, bundle);

      // Compute the expected stats via v2 directly.
      const index = buildIndex(bundle);
      const expected = computeStats(index);
      expect(expected.perFile.size).toBe(2);

      const rows = await db
        .select()
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(rows.length).toBe(2);

      for (const row of rows) {
        const fs = expected.perFile.get(row.file_path);
        expect(fs).toBeDefined();
        expect(row.chars_typed).toBe(fs!.charsTyped);
        expect(row.chars_pasted).toBe(fs!.charsPasted);
        expect(row.chars_external_change_delta).toBe(fs!.charsExternalChangeDelta);
        expect(row.saves).toBe(fs!.saves);
        expect(row.reconstruction_tainted).toBe(fs!.reconstructionTainted);
        // final_length and start_length are deferred to Phase 18.
        expect(row.final_length).toBe(0);
        expect(row.start_length).toBe(0);
      }
    });
  });

  it('idempotent: re-running on same submissionId does not duplicate rows', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeTwoFileBundle();

      await computeAndStoreStats(db, submissionId, bundle);
      await computeAndStoreStats(db, submissionId, bundle);

      const cntResult = await db
        .select({ cnt: count() })
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(2);
    });
  });

  it('CASCADE: deleting submission removes per_file_stats rows', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeTwoFileBundle();
      await computeAndStoreStats(db, submissionId, bundle);

      await db.delete(submissions).where(eq(submissions.id, submissionId));

      const cntResult = await db
        .select({ cnt: count() })
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(0);
    });
  });
});
