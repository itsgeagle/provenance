/**
 * Tests for runAndStoreHeuristics (Phase 12).
 *
 * Strategy: boundary tests for the wrapper, not re-tests of every heuristic.
 * We verify:
 *   1. A bundle that fires large_paste → correct flag row (severity, confidence,
 *      supporting_seqs translated to globalIdx, session_id populated).
 *   2. Clean bundle with no triggering events → no flag rows, score_total=0,
 *      score_max_severity='info'.
 *   3. CASCADE: deleting the submission removes flag rows.
 *
 * For the large_paste trigger we use buildTestBundle (analyzer test helper)
 * with an explicit paste event of ≥200 chars — the minimum for large_paste
 * to fire per DEFAULT_HEURISTIC_CONFIG.largePaste.minChars.
 *
 * For the clean bundle we use a synthetic Bundle (no paste events). We also
 * override extensionHashMismatch.knownGoodHashes to include the test bundle's
 * hash so extension_hash_mismatch doesn't fire unexpectedly.
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { eq, count } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { runAndStoreHeuristics } from './run-per-submission.js';
import { flags, submissions } from '../../db/schema.js';
import { buildTestBundle } from '@provenance/analyzer/test/helpers/build-test-bundle.js';
import { loadBundle } from '@provenance/analyzer/src/loader/parse-bundle.js';
import { runValidation } from '@provenance/analyzer/src/validation/run-validation.js';
import type { Bundle, ParsedSession } from '@provenance/analyzer/src/loader/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Wire SHA-512 for @noble/ed25519 (required in non-browser environments).
// ---------------------------------------------------------------------------
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

// ---------------------------------------------------------------------------
// Helper: build Bundle from buildTestBundle options
// ---------------------------------------------------------------------------

async function makeBundle(opts?: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(zipBuffer, 'test.zip');
  if (!result.ok) {
    throw new Error(`loadBundle failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Helper: build a synthetic Bundle (no paste events, no real chain hashes)
// Reuses the pattern from materialize-events.test.ts.
// ---------------------------------------------------------------------------

function makeEnvelope(seq: number, sessionId: string, wallBaseMs: number) {
  return {
    seq,
    t: seq * 100,
    wall: new Date(wallBaseMs + seq * 1000).toISOString(),
    // Use session.heartbeat events: they do not carry file payloads and do not
    // trigger reconstructFile in low_typing_high_output. This avoids the
    // DocChangeDelta.range.start crash documented in V26.
    kind: 'session.heartbeat' as const,
    data: {
      active_file: null,
    } as unknown as ParsedSession['events'][number]['data'],
    prev_hash: seq === 0 ? 'GENESIS' : `h-${sessionId}-${seq - 1}`,
    hash: `h-${sessionId}-${seq}`,
  };
}

// A known-good extension hash from config/known-good-extension-hashes.json.
// Using this suppresses the extension_hash_mismatch heuristic so the clean
// bundle produces truly zero flags.
const KNOWN_GOOD_EXTENSION_HASH =
  'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';

function makeSyntheticBundle(totalEvents: number): Bundle {
  const sessionId = 'session-0';
  const wallBase = 1_700_000_000_000;
  const envs = Array.from({ length: totalEvents }, (_, i) => makeEnvelope(i, sessionId, wallBase));
  return {
    id: crypto.randomUUID(),
    // extension_hash must be in the known-good list to suppress
    // extension_hash_mismatch so the "clean" test produces zero flags.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test bundle
    manifest: { extension_hash: KNOWN_GOOD_EXTENSION_HASH } as any,
    manifestSigHex: '',
    sessions: [
      {
        sessionId,
        events: envs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
        meta: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
        firstEvent: envs[0] as any,
      },
    ],
    sourceFilename: 'test.zip',
    loadedAt: new Date().toISOString(),
  };
}

// Minimal pass-like ValidationReport for synthetic bundles.
function makePassReport() {
  return {
    overall: 'warn' as const,
    checks: [
      { id: 'manifest_sig' as const, label: 'Manifest signature', status: 'pass' as const },
      { id: 'session_binding' as const, label: 'Session binding', status: 'pass' as const },
      { id: 'chain_integrity' as const, label: 'Hash chain integrity', status: 'pass' as const },
      { id: 'seq_gaps' as const, label: 'Sequence gaps', status: 'pass' as const },
      { id: 'monotonic_t' as const, label: 'Monotonic t', status: 'pass' as const },
      { id: 'monotonic_wall' as const, label: 'Monotonic wall', status: 'pass' as const },
      { id: 'doc_save_hashes' as const, label: 'Doc save hashes', status: 'pass' as const },
      {
        id: 'submitted_code_match' as const,
        label: 'Submitted code match',
        status: 'skipped' as const,
        detail: 'v1 skip',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAndStoreHeuristics', () => {
  it('large_paste flag: persists correct row with supporting_seqs as globalIdx ints', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);

      // Retrieve semesterId for the flag FK.
      const subRows = await db
        .select({ semester_id: submissions.semester_id })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      const semesterId = subRows[0]!.semester_id;

      // Build a real bundle with a large paste (≥200 chars triggers large_paste).
      // Use extension_hash='a'.repeat(64) known-good so extension_hash_mismatch
      // doesn't interfere with our large_paste assertion.
      const pasteContent = 'x'.repeat(250);
      const bundle = await makeBundle({
        sessions: [
          {
            events: [
              {
                kind: 'paste',
                data: {
                  path: '/test/hw1.py',
                  content: pasteContent,
                  length: pasteContent.length,
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                },
              },
            ],
          },
        ],
      });

      // Run real validation so we have a proper ValidationReport.
      const validationReport = await runValidation(bundle);

      // Suppress extension_hash_mismatch by running with the bundle's hash known-good.
      // We do this via the fact that runAndStoreHeuristics uses DEFAULT_CONFIG_V0
      // which includes the default extensionHashMismatch list. The test bundle's
      // extension_hash='a'.repeat(64) is NOT in the default list, so
      // extension_hash_mismatch will fire. We assert only the large_paste flag
      // below by filtering by heuristic_id.
      await runAndStoreHeuristics(db, submissionId, semesterId, bundle, validationReport);

      // Query for large_paste flags specifically.
      const largePasteFlags = await db
        .select()
        .from(flags)
        .where(eq(flags.submission_id, submissionId));

      const lpFlag = largePasteFlags.find((f) => f.heuristic_id === 'large_paste');
      expect(lpFlag).toBeDefined();
      expect(lpFlag!.heuristic_id).toBe('large_paste');
      // 250 chars ≥ 200 but < 500 → medium severity.
      expect(lpFlag!.severity).toBe('medium');
      // confidence is 0.8 for non-anomaly pastes per config.ts rubric.
      expect(lpFlag!.confidence).toBeCloseTo(0.8);
      // score_contribution = severity_weights.medium (3) * 0.8 * weight (1.0) = 2.4
      expect(lpFlag!.score_contribution).toBeCloseTo(2.4);
      expect(lpFlag!.weight_at_compute).toBe(1.0);
      expect(lpFlag!.heuristic_config_version).toBe(0);

      // supporting_seqs must be int[] (globalIdx values), not strings.
      expect(Array.isArray(lpFlag!.supporting_seqs)).toBe(true);
      expect(lpFlag!.supporting_seqs.length).toBeGreaterThanOrEqual(1);
      for (const s of lpFlag!.supporting_seqs) {
        expect(typeof s).toBe('number');
      }

      // session_id should be set to the single session's ID (all seqs in same session).
      expect(lpFlag!.session_id).not.toBe('');
      expect(typeof lpFlag!.session_id).toBe('string');

      // semester_id FK must be populated.
      expect(lpFlag!.semester_id).toBe(semesterId);
    });
  });

  it('clean bundle → no flag rows, score_total=0, score_max_severity="info"', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);

      const subRows = await db
        .select({ semester_id: submissions.semester_id })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      const semesterId = subRows[0]!.semester_id;

      // Synthetic bundle: no paste events, no anomalies.
      // known-good hash 'a'.repeat(64) in manifest suppresses extension_hash_mismatch.
      const bundle = makeSyntheticBundle(5);
      const validationReport = makePassReport();

      await runAndStoreHeuristics(db, submissionId, semesterId, bundle, validationReport);

      const cntResult = await db
        .select({ cnt: count() })
        .from(flags)
        .where(eq(flags.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(0);

      // submissions.score_total and score_max_severity must be updated.
      const subResult = await db
        .select({
          score_total: submissions.score_total,
          score_max_severity: submissions.score_max_severity,
        })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      expect(subResult[0]!.score_total).toBe(0);
      expect(subResult[0]!.score_max_severity).toBe('info');
    });
  });

  it('CASCADE: deleting submission removes flag rows', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);

      const subRows = await db
        .select({ semester_id: submissions.semester_id })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      const semesterId = subRows[0]!.semester_id;

      // Build a bundle that fires at least one flag.
      const pasteContent = 'x'.repeat(250);
      const bundle = await makeBundle({
        sessions: [
          {
            events: [
              {
                kind: 'paste',
                data: {
                  path: '/test/hw1.py',
                  content: pasteContent,
                  length: pasteContent.length,
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                },
              },
            ],
          },
        ],
      });
      const validationReport = await runValidation(bundle);
      await runAndStoreHeuristics(db, submissionId, semesterId, bundle, validationReport);

      // Verify at least one flag was inserted.
      const before = await db
        .select({ cnt: count() })
        .from(flags)
        .where(eq(flags.submission_id, submissionId));
      expect(before[0]!.cnt).toBeGreaterThanOrEqual(1);

      // Delete submission — should cascade to flags.
      await db.delete(submissions).where(eq(submissions.id, submissionId));

      const after = await db
        .select({ cnt: count() })
        .from(flags)
        .where(eq(flags.submission_id, submissionId));
      expect(after[0]!.cnt).toBe(0);
    });
  });
});
