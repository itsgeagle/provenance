/**
 * Tests for extractCrossFeaturesFromDb.
 *
 * The critical, easy-to-get-wrong property is that globalIdx is the position
 * after sorting events by (wall, sessionId, seq) — NOT the raw seq — so that
 * cross_flag_participants.supporting_seqs match the analyzer/replay's globalIdx.
 * We seed events whose wall order deliberately differs from their seq order and
 * assert the chronological assignment, plus the compact feature shape.
 */

import { vi, describe, it, expect } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { events } from '../../db/schema.js';
import { extractCrossFeaturesFromDb } from './extract-cross-features-from-db.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const SESSION = '11111111-1111-1111-1111-111111111111';

describe('extractCrossFeaturesFromDb', () => {
  it('assigns globalIdx in chronological (wall) order, not seq order', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const base = Date.now();
      const content = 'p'.repeat(120);

      // seq order: 0,1,2 — but wall order is 0,2,1, so chronological order is
      // session.start (seq0) → paste (seq2) → doc.change (seq1).
      await db.insert(events).values([
        {
          submission_id: submissionId,
          seq: 0,
          session_id: SESSION,
          t: 0,
          wall: new Date(base),
          kind: 'session.start',
          payload: { active_file: null } as unknown as Record<string, unknown>,
          prev_hash: 'GENESIS',
          hash: 'h-0',
        },
        {
          submission_id: submissionId,
          seq: 1,
          session_id: SESSION,
          t: 2000,
          wall: new Date(base + 2000),
          kind: 'doc.change',
          payload: { path: 'hw.py' } as unknown as Record<string, unknown>,
          prev_hash: 'h-0',
          hash: 'h-1',
        },
        {
          submission_id: submissionId,
          seq: 2,
          session_id: SESSION,
          t: 1000,
          wall: new Date(base + 1000),
          kind: 'paste',
          payload: { length: content.length, sha256: 'sha-xyz', content } as unknown as Record<
            string,
            unknown
          >,
          prev_hash: 'h-1',
          hash: 'h-2',
        },
      ]);

      const { features, globalIdxBySeqKey } = await extractCrossFeaturesFromDb(
        db,
        submissionId,
        'bundle-1',
      );

      expect(features.bundleId).toBe('bundle-1');
      expect(features.eventCount).toBe(3);

      // Chronological order: seq0 (idx0), seq2 (idx1), seq1 (idx2).
      expect(features.representativeSeqKeys).toEqual([
        `${SESSION}:0`,
        `${SESSION}:2`,
        `${SESSION}:1`,
      ]);
      expect(globalIdxBySeqKey.get(`${SESSION}:0`)).toBe(0);
      expect(globalIdxBySeqKey.get(`${SESSION}:2`)).toBe(1);
      expect(globalIdxBySeqKey.get(`${SESSION}:1`)).toBe(2);

      // n-gram fingerprint built from the chronological kind stream.
      expect([...features.kindNgrams]).toEqual(['session.start|paste|doc.change']);

      // Paste payload reduced to the fields the heuristic needs.
      expect(features.pastes).toHaveLength(1);
      expect(features.pastes[0]).toMatchObject({
        seqKey: `${SESSION}:2`,
        sha256: 'sha-xyz',
        content,
        length: 120,
      });
    });
  });

  it('produces an empty n-gram set and no pastes for a sub-3-event submission', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      await db.insert(events).values([
        {
          submission_id: submissionId,
          seq: 0,
          session_id: SESSION,
          t: 0,
          wall: new Date(),
          kind: 'session.start',
          payload: { active_file: null } as unknown as Record<string, unknown>,
          prev_hash: 'GENESIS',
          hash: 'h-0',
        },
      ]);

      const { features } = await extractCrossFeaturesFromDb(db, submissionId, 'bundle-1');

      expect(features.eventCount).toBe(1);
      expect(features.kindNgrams.size).toBe(0);
      expect(features.pastes).toHaveLength(0);
    });
  });
});
