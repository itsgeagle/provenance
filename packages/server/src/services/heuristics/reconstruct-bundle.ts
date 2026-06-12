/**
 * reconstructBundleFromDb — shared helper for bundle stub reconstruction.
 *
 * Phase 13b inlined Strategy A bundle reconstruction inside recompute-submission.ts.
 * Phase 14 needs the same logic for batch reconstruction (all submissions in a
 * semester at once for cross-heuristics). This module extracts it as a shared
 * helper so both callers use exactly the same reconstruction path.
 *
 * ## Strategy A (V31)
 *
 * Build a minimal Bundle stub from DB `events` + `flags` tables:
 *   1. events rows → Bundle.sessions[].events (HashedEnvelope[]).
 *   2. extension_hash_mismatch flag.detail.extensionHash → manifest.extension_hash.
 *      If no such flag: use KNOWN_GOOD_EXTENSION_HASH_SENTINEL to prevent spurious
 *      re-firing of extension_hash_mismatch.
 *
 * ValidationReport is reconstructed separately via reconstructValidationReport
 * (also in this module) from validation_results rows.
 *
 * Both functions are used by:
 *   - recompute-submission.ts (per-submission recompute, Phase 13b)
 *   - run-cross.ts (batch reconstruction for cross-heuristics, Phase 14)
 */

import { eq, and } from 'drizzle-orm';
import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import type { Bundle, ParsedSession } from '@provenance/analyzer/src/loader/types.js';
import type {
  ValidationReport,
  ValidationCheck,
} from '@provenance/analyzer/src/validation/check-types.js';
import type { EventIndex } from '@provenance/analyzer/src/index/event-index.js';
import type { HashedEnvelope } from '@provenance/log-core';
import { events, flags, validation_results } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A known-good extension hash (from known-good-extension-hashes.json).
 * Used as the bundle.manifest.extension_hash stub when the original submission
 * had NO extension_hash_mismatch flag (meaning the original hash was known-good).
 * This prevents extension_hash_mismatch from spuriously firing during recompute
 * or cross-heuristic runs.
 *
 * Same sentinel as in recompute-submission.ts (V31 design decision).
 */
export const KNOWN_GOOD_EXTENSION_HASH_SENTINEL =
  'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type ReconstructedBundle = {
  bundle: Bundle;
  index: EventIndex;
  validationReport: ValidationReport;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconstruct a minimal Bundle stub + EventIndex + ValidationReport from the DB
 * for a given submission.
 *
 * The `bundle.id` in the returned Bundle is a fresh crypto.randomUUID(), NOT the
 * original bundle id (which is not stored server-side). Callers that need to
 * maintain a bundleId→submissionId mapping should record this UUID at call time.
 *
 * This is a read-only operation; it makes no writes to any table.
 *
 * @param db - Drizzle DB handle.
 * @param submissionId - UUID of the submission to reconstruct.
 */
export async function reconstructBundleFromDb(
  db: DrizzleDb,
  submissionId: string,
): Promise<ReconstructedBundle> {
  // -------------------------------------------------------------------------
  // Step 1: Read events ordered by seq (= globalIdx from original buildIndex).
  // Group by session_id to reconstruct Bundle.sessions[].
  // -------------------------------------------------------------------------
  const eventRows = await db
    .select({
      seq: events.seq,
      session_id: events.session_id,
      t: events.t,
      wall: events.wall,
      kind: events.kind,
      payload: events.payload,
      prev_hash: events.prev_hash,
      hash: events.hash,
    })
    .from(events)
    .where(eq(events.submission_id, submissionId))
    .orderBy(events.seq);

  // Group events by session_id preserving insertion order (events are sorted by seq = globalIdx).
  const sessionMap = new Map<string, Array<(typeof eventRows)[0]>>();
  for (const ev of eventRows) {
    let bucket = sessionMap.get(ev.session_id);
    if (!bucket) {
      bucket = [];
      sessionMap.set(ev.session_id, bucket);
    }
    bucket.push(ev);
  }

  // -------------------------------------------------------------------------
  // Step 2: Recover extension_hash.
  //
  // If the original ingest flagged extension_hash_mismatch, the heuristic stored
  // the actual extension_hash in flag.detail.extensionHash. Recover it here so
  // recompute / cross-heuristics produce the same flag behavior.
  //
  // If no such flag exists, the original hash was known-good; use the
  // KNOWN_GOOD_EXTENSION_HASH_SENTINEL so the heuristic does NOT fire.
  // -------------------------------------------------------------------------
  const existingMismatchFlags = await db
    .select({ detail: flags.detail })
    .from(flags)
    .where(
      and(eq(flags.submission_id, submissionId), eq(flags.heuristic_id, 'extension_hash_mismatch')),
    )
    .limit(1);

  let extensionHash = KNOWN_GOOD_EXTENSION_HASH_SENTINEL;
  if (existingMismatchFlags.length > 0) {
    const detail = existingMismatchFlags[0]!.detail;
    if (
      detail !== null &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      'extensionHash' in detail &&
      typeof (detail as Record<string, unknown>)['extensionHash'] === 'string'
    ) {
      extensionHash = (detail as Record<string, unknown>)['extensionHash'] as string;
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Build Bundle.sessions[].
  //
  // Each DB event row is converted to a HashedEnvelope. The seq values are global
  // indices (assigned by the original buildIndex) — so buildIndex on this
  // reconstructed bundle will produce the same EventIndex as the original ingest.
  // -------------------------------------------------------------------------
  const sessions: ParsedSession[] = [];

  for (const [sessionId, evRows] of sessionMap.entries()) {
    const envelopes: HashedEnvelope[] = evRows.map((ev) => ({
      seq: ev.seq,
      t: ev.t,
      // wall is stored as a Date by Drizzle; convert back to ISO string.
      wall: ev.wall instanceof Date ? ev.wall.toISOString() : String(ev.wall),
      kind: ev.kind as HashedEnvelope['kind'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: payload is jsonb → any
      data: ev.payload as any,
      prev_hash: ev.prev_hash,
      hash: ev.hash,
    }));

    const firstEnvelope = envelopes.find((e) => e.kind === 'session.start') ?? envelopes[0]!;

    sessions.push({
      sessionId,
      events: envelopes,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic stub (V31)
      meta: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic stub (V31)
      firstEvent: firstEnvelope as any,
    });
  }

  const bundle: Bundle = {
    id: crypto.randomUUID(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: only extension_hash is read by heuristics (V31)
    manifest: { extension_hash: extensionHash } as any,
    manifestSigHex: '',
    sessions,
    sourceFilename: `reconstruct-stub-${submissionId}`,
    loadedAt: new Date().toISOString(),
    submissionFiles: new Map(),
  };

  // -------------------------------------------------------------------------
  // Step 4: Build EventIndex.
  // -------------------------------------------------------------------------
  const index = buildIndex(bundle);

  // -------------------------------------------------------------------------
  // Step 5: Reconstruct ValidationReport from validation_results.
  // -------------------------------------------------------------------------
  const validationReport = await reconstructValidationReport(db, submissionId);

  return { bundle, index, validationReport };
}

// ---------------------------------------------------------------------------
// Internal: reconstruct ValidationReport from DB
// ---------------------------------------------------------------------------

/**
 * Reconstruct a ValidationReport from the DB validation_results row.
 *
 * If no row exists, returns a default "all-skipped" report (integrity flags
 * will not fire). This is conservative — in practice all ingested submissions
 * should have a validation_results row (written by Phase 11).
 */
async function reconstructValidationReport(
  db: DrizzleDb,
  submissionId: string,
): Promise<ValidationReport> {
  const rows = await db
    .select({
      check_1_status: validation_results.check_1_status,
      check_2_status: validation_results.check_2_status,
      check_3_status: validation_results.check_3_status,
      check_4_status: validation_results.check_4_status,
      check_5_status: validation_results.check_5_status,
      check_6_status: validation_results.check_6_status,
      check_7_status: validation_results.check_7_status,
      check_8_status: validation_results.check_8_status,
      overall: validation_results.overall,
      detail: validation_results.detail,
    })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  if (rows.length === 0) {
    return {
      overall: 'warn',
      checks: [
        { id: 'manifest_sig', label: 'Manifest signature', status: 'skipped' },
        { id: 'session_binding', label: 'Session binding', status: 'skipped' },
        { id: 'chain_integrity', label: 'Hash chain integrity', status: 'skipped' },
        { id: 'seq_gaps', label: 'Sequence gaps', status: 'skipped' },
        { id: 'monotonic_t', label: 'Monotonic t', status: 'skipped' },
        { id: 'monotonic_wall', label: 'Monotonic wall', status: 'skipped' },
        { id: 'doc_save_hashes', label: 'Doc save hashes', status: 'skipped' },
        {
          id: 'submitted_code_match',
          label: 'Submitted code match',
          status: 'skipped',
          detail: 'v1 skip',
        },
      ],
    };
  }

  const row = rows[0]!;

  // The `detail` column stores the full checks array as jsonb.
  const detailChecks = Array.isArray(row.detail) ? (row.detail as ValidationCheck[]) : null;

  if (detailChecks && detailChecks.length === 8) {
    return {
      overall: row.overall as ValidationReport['overall'],
      checks: detailChecks,
    };
  }

  // Fallback: reconstruct from individual status columns.
  const checkIds = [
    'manifest_sig',
    'session_binding',
    'chain_integrity',
    'seq_gaps',
    'monotonic_t',
    'monotonic_wall',
    'doc_save_hashes',
    'submitted_code_match',
  ] as const;

  const statusValues = [
    row.check_1_status,
    row.check_2_status,
    row.check_3_status,
    row.check_4_status,
    row.check_5_status,
    row.check_6_status,
    row.check_7_status,
    row.check_8_status,
  ] as const;

  const checks: ValidationCheck[] = checkIds.map((id, i) => ({
    id,
    label: id,
    status: (statusValues[i] ?? 'skipped') as ValidationCheck['status'],
  }));

  return {
    overall: row.overall as ValidationReport['overall'],
    checks,
  };
}
