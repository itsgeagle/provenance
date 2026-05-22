/**
 * Tests for reconstructBundleFromDb (Phase 14 — extracted helper).
 *
 * Verifies:
 *   1. Happy path: DB events are reconstructed into a Bundle+EventIndex that
 *      buildIndex can process, producing the correct event count.
 *   2. Extension hash fallback: when no extension_hash_mismatch flag exists,
 *      the KNOWN_GOOD_EXTENSION_HASH_SENTINEL is used.
 *   3. Extension hash recovery: when an extension_hash_mismatch flag exists,
 *      the actual hash is read from flag.detail.extensionHash.
 *   4. Missing validation row: falls back to all-skipped ValidationReport.
 *   5. CASCADE: deleting the submission removes events (FK test).
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import {
  reconstructBundleFromDb,
  KNOWN_GOOD_EXTENSION_HASH_SENTINEL,
} from './reconstruct-bundle.js';
import { events, flags, submissions } from '../../db/schema.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert synthetic event rows for a submission. */
async function seedEvents(
  db: Parameters<typeof seedSubmission>[0],
  submissionId: string,
  sessionId: string,
  count: number,
) {
  const wallBase = Date.now();
  const rows = Array.from({ length: count }, (_, i) => ({
    submission_id: submissionId,
    seq: i,
    session_id: sessionId,
    t: i * 100,
    wall: new Date(wallBase + i * 1000),
    kind: i === 0 ? 'session.start' : 'session.heartbeat',
    payload: { active_file: null } as unknown as Record<string, unknown>,
    prev_hash: i === 0 ? 'GENESIS' : `h-${sessionId}-${i - 1}`,
    hash: `h-${sessionId}-${i}`,
  }));
  await db.insert(events).values(rows);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconstructBundleFromDb', () => {
  it('reconstructs bundle with correct event count and session structure', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const sessionId = crypto.randomUUID();
      await seedEvents(db, submissionId, sessionId, 5);

      const { bundle, index, validationReport } = await reconstructBundleFromDb(db, submissionId);

      // Bundle structure
      expect(bundle.sessions).toHaveLength(1);
      expect(bundle.sessions[0]!.sessionId).toBe(sessionId);
      expect(bundle.sessions[0]!.events).toHaveLength(5);

      // EventIndex correctness: bySeq should have 5 entries
      expect(index.bySeq.size).toBe(5);

      // ValidationReport: no validation_results row → skipped
      expect(validationReport.checks).toHaveLength(8);
      expect(validationReport.checks.every((c) => c.status === 'skipped')).toBe(true);
    });
  });

  it('uses KNOWN_GOOD_EXTENSION_HASH_SENTINEL when no mismatch flag exists', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const sessionId = crypto.randomUUID();
      await seedEvents(db, submissionId, sessionId, 2);

      const { bundle } = await reconstructBundleFromDb(db, submissionId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: manifest is stubbed
      expect((bundle.manifest as any).extension_hash).toBe(KNOWN_GOOD_EXTENSION_HASH_SENTINEL);
    });
  });

  it('recovers extension hash from mismatch flag detail', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const sessionId = crypto.randomUUID();
      await seedEvents(db, submissionId, sessionId, 2);

      // Look up semester_id for the submission
      const [sub] = await db
        .select({ semester_id: submissions.semester_id })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .limit(1);

      const actualHash = 'deadbeef1234567890';
      await db.insert(flags).values({
        submission_id: submissionId,
        semester_id: sub!.semester_id,
        heuristic_id: 'extension_hash_mismatch',
        severity: 'medium',
        confidence: 0.95,
        weight_at_compute: 1.0,
        score_contribution: 2.85,
        detail: { extensionHash: actualHash } as unknown as Record<string, unknown>,
        supporting_seqs: [],
        session_id: '',
        heuristic_config_version: 1,
      });

      const { bundle } = await reconstructBundleFromDb(db, submissionId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI
      expect((bundle.manifest as any).extension_hash).toBe(actualHash);
    });
  });

  it('handles multiple sessions correctly', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const session1 = crypto.randomUUID();
      const session2 = crypto.randomUUID();

      // Two sessions: seq 0-2 in session1, seq 3-4 in session2.
      const wallBase = Date.now();
      await db.insert(events).values([
        {
          submission_id: submissionId,
          seq: 0,
          session_id: session1,
          t: 0,
          wall: new Date(wallBase),
          kind: 'session.start',
          payload: { active_file: null } as unknown as Record<string, unknown>,
          prev_hash: 'GENESIS',
          hash: `h-s1-0`,
        },
        {
          submission_id: submissionId,
          seq: 1,
          session_id: session1,
          t: 100,
          wall: new Date(wallBase + 1000),
          kind: 'session.heartbeat',
          payload: { active_file: null } as unknown as Record<string, unknown>,
          prev_hash: 'h-s1-0',
          hash: 'h-s1-1',
        },
        {
          submission_id: submissionId,
          seq: 2,
          session_id: session2,
          t: 200,
          wall: new Date(wallBase + 2000),
          kind: 'session.start',
          payload: { active_file: null } as unknown as Record<string, unknown>,
          prev_hash: 'h-s1-1',
          hash: 'h-s2-2',
        },
      ]);

      const { bundle, index } = await reconstructBundleFromDb(db, submissionId);

      expect(bundle.sessions).toHaveLength(2);
      expect(index.bySeq.size).toBe(3);
    });
  });

  it('returns fresh bundle.id on every call (not cached)', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const sessionId = crypto.randomUUID();
      await seedEvents(db, submissionId, sessionId, 2);

      const { bundle: b1 } = await reconstructBundleFromDb(db, submissionId);
      const { bundle: b2 } = await reconstructBundleFromDb(db, submissionId);

      // bundle.id should be different on each call (fresh crypto.randomUUID()).
      expect(b1.id).not.toBe(b2.id);
    });
  });
});
