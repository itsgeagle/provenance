/**
 * recomputeSubmission — Phase 13b per-submission heuristic recompute service.
 *
 * Reconstructs a minimal Bundle stub from DB events + validation_results,
 * runs the full heuristic suite, and either:
 *   - Updates flags + submission score in a single transaction (simulate=false).
 *   - Returns prospective scores without any DB writes (simulate=true).
 *
 * ## Bundle reconstruction strategy (Strategy A — see V31)
 *
 * v2's runHeuristics(index, bundle, validationReport, config) receives both an
 * EventIndex and a Bundle. After auditing all 17 heuristics in the registry:
 *
 *   - 16 heuristics: only use `index` (EventIndex). No direct `bundle.*` access
 *     in their `run()` functions.
 *   - 1 heuristic: `extension_hash_mismatch` reads `bundle.manifest.extension_hash`.
 *
 * Strategy A: build a minimal Bundle stub with:
 *   1. `sessions[].sessionId + events[]` — reconstructed from DB `events` table.
 *      DB events carry (seq, session_id, t, wall, kind, payload) — enough for
 *      buildIndex to produce the same EventIndex as the original ingest.
 *   2. `manifest.extension_hash` — recovered from the existing `extension_hash_mismatch`
 *      flag's detail.extensionHash if one exists. If no such flag exists, the original
 *      bundle's hash was in the known-good list at ingest time; we use a known-good
 *      sentinel so extension_hash_mismatch does NOT fire (matching original behavior).
 *
 * This produces correct flag output for all heuristics without reading the blob.
 *
 * ## ValidationReport reconstruction
 *
 * `integrityFlagsFromReport` (called by runHeuristics) reads the ValidationReport
 * to produce chain_broken / manifest_sig_invalid / etc. flags. We reconstruct
 * ValidationReport from the DB `validation_results` row — the `detail` column
 * stores the full checks array as jsonb. If no validation_results row exists,
 * we use a default "pass" report (integrity flags will not fire).
 *
 * ## Transaction contract
 *
 * simulate=false writes:
 *   1. UPDATE submissions SET recompute_status='recomputing' WHERE id=...
 *   2. DELETE FROM flags WHERE submission_id=...
 *   3. INSERT INTO flags (...) VALUES ...
 *   4. UPDATE submissions SET score_total=..., score_max_severity=...,
 *        heuristic_config_version=..., recompute_status='fresh' WHERE id=...
 *
 * All 4 writes are in a single transaction so pg-boss retry sees a clean state
 * on rollback.
 *
 * If simulate=true, none of the above writes occur. The function is pure-ish
 * (reads from DB, no writes).
 */

import { eq, inArray, isNull, and } from 'drizzle-orm';
import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import { runHeuristics } from '@provenance/analyzer/src/heuristics/run-heuristics.js';
import type { Bundle, ParsedSession } from '@provenance/analyzer/src/loader/types.js';
import type {
  ValidationReport,
  ValidationCheck,
} from '@provenance/analyzer/src/validation/check-types.js';
import type { Severity } from '@provenance/analyzer/src/heuristics/types.js';
import type { HashedEnvelope } from '@provenance/log-core';
import { events, flags, submissions, validation_results } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import type { ServerHeuristicConfig } from '../heuristics/config.js';
import { computeScore } from './compute.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A known-good extension hash (from known-good-extension-hashes.json).
 * Used as the bundle.manifest.extension_hash stub when the original submission
 * had NO extension_hash_mismatch flag (meaning the original hash was known-good).
 * This prevents extension_hash_mismatch from spuriously firing during recompute.
 */
const KNOWN_GOOD_EXTENSION_HASH_SENTINEL =
  'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type RecomputeResult = {
  score_total: number;
  score_max_severity: Severity;
  flag_count: number;
};

// ---------------------------------------------------------------------------
// Internal: reconstruct Bundle from DB events
// ---------------------------------------------------------------------------

/**
 * Reconstruct a minimal Bundle stub from DB events for a submission.
 *
 * The stub satisfies buildIndex (needs sessions[].sessionId + events[]).
 * bundle.manifest.extension_hash is recovered from the existing
 * extension_hash_mismatch flag if one exists; otherwise a known-good sentinel
 * is used to preserve original flag-absence behavior.
 *
 * bundle.manifestSigHex / manifest.sessions etc. are empty stubs — no
 * heuristic reads them (confirmed by V31 audit).
 */
async function reconstructBundleStub(db: DrizzleDb, submissionId: string): Promise<Bundle> {
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
  // If the original ingest flagged extension_hash_mismatch, the heuristic
  // stored the actual extension_hash in flag.detail.extensionHash. We recover
  // it here so the recompute produces the same flag behavior.
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
    // detail is typed as unknown (jsonb); we narrow it.
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
  // Each DB event is converted to a HashedEnvelope. The seq values are global
  // indices (assigned by the original buildIndex) — so buildIndex on this
  // reconstructed bundle will produce the same EventIndex as the original.
  //
  // session.start events may not be present in the events table for older
  // ingests; we construct a minimal firstEvent stub for those sessions.
  // -------------------------------------------------------------------------
  const sessions: ParsedSession[] = [];

  for (const [sessionId, evRows] of sessionMap.entries()) {
    const envelopes: HashedEnvelope[] = evRows.map((ev) => ({
      seq: ev.seq,
      t: ev.t,
      // wall is stored as a Date by Drizzle; convert back to ISO string
      wall: ev.wall instanceof Date ? ev.wall.toISOString() : String(ev.wall),
      kind: ev.kind as HashedEnvelope['kind'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: payload is jsonb → any
      data: ev.payload as any,
      prev_hash: ev.prev_hash,
      hash: ev.hash,
    }));

    // Find the session.start event (first event in the session, kind='session.start').
    // If it doesn't exist in DB (shouldn't happen for well-formed ingests), use a stub.
    const firstEnvelope = envelopes.find((e) => e.kind === 'session.start') ?? envelopes[0]!;

    sessions.push({
      sessionId,
      events: envelopes,
      // meta is only needed by a few heuristics that check session-level fields.
      // All registered heuristics access meta via index.sessions or don't use it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic stub
      meta: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic stub
      firstEvent: firstEnvelope as any,
    });
  }

  const bundle: Bundle = {
    id: crypto.randomUUID(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: only extension_hash is read by heuristics
    manifest: { extension_hash: extensionHash } as any,
    manifestSigHex: '',
    sessions,
    sourceFilename: `recompute-stub-${submissionId}`,
    loadedAt: new Date().toISOString(),
  };

  return bundle;
}

// ---------------------------------------------------------------------------
// Internal: reconstruct ValidationReport from DB
// ---------------------------------------------------------------------------

/**
 * Reconstruct a ValidationReport from the DB validation_results row.
 *
 * If no row exists, returns a default "all-pass" report (integrity flags
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
    // No validation row — return a permissive default so recompute doesn't crash.
    // This shouldn't happen for correctly ingested submissions but is defensive.
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

  // The `detail` column stores the full checks array as jsonb (written by
  // runAndStoreValidation). If it's a valid array, use it directly.
  const detailChecks = Array.isArray(row.detail) ? (row.detail as ValidationCheck[]) : null;

  if (detailChecks && detailChecks.length === 8) {
    return {
      overall: row.overall as ValidationReport['overall'],
      checks: detailChecks,
    };
  }

  // Fallback: reconstruct from individual status columns.
  // This is the conservative path if detail JSON is malformed.
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

// ---------------------------------------------------------------------------
// Internal: translate Flag[] to DB rows (same logic as run-per-submission.ts)
// ---------------------------------------------------------------------------

type FlagRow = typeof flags.$inferInsert;

function translateFlagsToRows(
  rawFlags: ReturnType<typeof runHeuristics>,
  index: ReturnType<typeof buildIndex>,
  submissionId: string,
  semesterId: string,
  config: ServerHeuristicConfig,
  configVersion: number,
): { flagRows: FlagRow[]; scoreInputs: Array<{ severity: string; score_contribution: number }> } {
  const flagRows: FlagRow[] = [];
  const scoreInputs: Array<{ severity: string; score_contribution: number }> = [];

  for (const flag of rawFlags) {
    const perFlagCfg = config.per_flag[flag.heuristic];

    // PRD §10.3: disabled heuristics contribute zero and are not stored.
    if (!perFlagCfg || !perFlagCfg.enabled) {
      continue;
    }

    // Translate supportingSeqs: string[] → int[] of globalIdx values.
    const globalIdxs: number[] = [];
    for (const seqKey of flag.supportingSeqs) {
      const event = index.bySeq.get(seqKey);
      if (event !== undefined) {
        globalIdxs.push(event.globalIdx);
      }
    }

    // Determine session_id: set if all supporting seqs share the same session.
    let sessionId = '';
    if (flag.supportingSeqs.length > 0) {
      const uniqueSessions = new Set<string>();
      for (const seqKey of flag.supportingSeqs) {
        const lastColon = seqKey.lastIndexOf(':');
        if (lastColon !== -1) {
          uniqueSessions.add(seqKey.slice(0, lastColon));
        }
      }
      if (uniqueSessions.size === 1) {
        sessionId = uniqueSessions.values().next().value!;
      }
    }

    // score_contribution = severity_weights[severity] * confidence * weight
    const severityWeight =
      config.severity_weights[flag.severity as keyof typeof config.severity_weights] ?? 0;
    const scoreContribution = severityWeight * flag.confidence * perFlagCfg.weight;

    const row: FlagRow = {
      submission_id: submissionId,
      semester_id: semesterId,
      heuristic_id: flag.heuristic,
      severity: flag.severity,
      confidence: flag.confidence,
      weight_at_compute: perFlagCfg.weight,
      score_contribution: scoreContribution,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: jsonb accepts JSON-serializable value
      detail: (flag.detail ?? {}) as any,
      supporting_seqs: globalIdxs,
      session_id: sessionId,
      heuristic_config_version: configVersion,
    };

    flagRows.push(row);
    scoreInputs.push({ severity: flag.severity, score_contribution: scoreContribution });
  }

  return { flagRows, scoreInputs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recompute heuristics for a single submission using the given config.
 *
 * If simulate=false (default): rewrites flags and updates the submission row
 * inside a single transaction.
 *
 * If simulate=true: reads events + validation, runs heuristics, returns the
 * prospective scores WITHOUT any DB writes.
 *
 * @param db - Drizzle DB handle.
 * @param submissionId - UUID of the submission to recompute.
 * @param semesterId - UUID of the semester (FK for flag rows).
 * @param config - The ServerHeuristicConfig to apply.
 * @param configVersion - The version number to write to flags.heuristic_config_version.
 * @param options.simulate - If true, skip all writes (dry-run mode).
 */
export async function recomputeSubmission(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  config: ServerHeuristicConfig,
  configVersion: number,
  { simulate = false }: { simulate?: boolean } = {},
): Promise<RecomputeResult> {
  // -------------------------------------------------------------------------
  // Step 1: Reconstruct Bundle stub from DB events.
  // -------------------------------------------------------------------------
  const bundle = await reconstructBundleStub(db, submissionId);

  // -------------------------------------------------------------------------
  // Step 2: Reconstruct ValidationReport from DB.
  // -------------------------------------------------------------------------
  const validationReport = await reconstructValidationReport(db, submissionId);

  // -------------------------------------------------------------------------
  // Step 3: Build EventIndex and run heuristics.
  //
  // Pass undefined configOverride — the server-side ServerHeuristicConfig
  // (enabled/weight/severity_weights) is distinct from v2's HeuristicConfig
  // (threshold values). v2's runHeuristics uses its own DEFAULT_HEURISTIC_CONFIG
  // internally for threshold-based logic. The server-side enabled/weight is
  // applied below when translating flags to DB rows.
  // -------------------------------------------------------------------------
  const index = buildIndex(bundle);
  const rawFlags = runHeuristics(index, bundle, validationReport, undefined);

  // -------------------------------------------------------------------------
  // Step 4: Translate flags to DB rows using the server-side config.
  // -------------------------------------------------------------------------
  const { flagRows, scoreInputs } = translateFlagsToRows(
    rawFlags,
    index,
    submissionId,
    semesterId,
    config,
    configVersion,
  );

  // -------------------------------------------------------------------------
  // Step 5: Compute aggregate score.
  // -------------------------------------------------------------------------
  const { score_total, score_max_severity } = computeScore(scoreInputs);
  const flag_count = flagRows.length;

  if (simulate) {
    // Dry-run: return scores without writing anything.
    return { score_total, score_max_severity, flag_count };
  }

  // -------------------------------------------------------------------------
  // Step 6: Write to DB in a single transaction.
  //
  // 6a. Mark submission as recomputing (visible to other readers during recompute).
  // 6b. Delete all existing flags.
  // 6c. Insert new flags.
  // 6d. Update submission score + heuristic_config_version + recompute_status='fresh'.
  //
  // All 4 writes are atomic: a retry after crash sees a clean state.
  // -------------------------------------------------------------------------
  await withTransaction(db, async (tx) => {
    // 6a: recomputing sentinel
    await tx
      .update(submissions)
      .set({ recompute_status: 'recomputing' })
      .where(eq(submissions.id, submissionId));

    // 6b: DELETE old flags
    await tx.delete(flags).where(eq(flags.submission_id, submissionId));

    // 6c: INSERT new flags (skip if empty)
    if (flagRows.length > 0) {
      await tx.insert(flags).values(flagRows);
    }

    // 6d: UPDATE submission
    await tx
      .update(submissions)
      .set({
        score_total,
        score_max_severity,
        heuristic_config_version: configVersion,
        recompute_status: 'fresh',
      })
      .where(eq(submissions.id, submissionId));
  });

  return { score_total, score_max_severity, flag_count };
}

// ---------------------------------------------------------------------------
// Exported helper: enumerate non-superseded submissions in a semester
// ---------------------------------------------------------------------------

/**
 * Return IDs of all non-superseded submissions in a semester.
 * Used by the recompute_semester worker to build the work queue.
 */
export async function getNonSupersededSubmissionIds(
  db: DrizzleDb,
  semesterId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(eq(submissions.semester_id, semesterId), isNull(submissions.superseded_by_submission_id)),
    );
  return rows.map((r) => r.id);
}

/**
 * Mark a list of submission IDs as 'stale' (recompute pending).
 * Called by the recompute_semester worker before dispatching per-submission jobs.
 */
export async function markSubmissionsStale(db: DrizzleDb, submissionIds: string[]): Promise<void> {
  if (submissionIds.length === 0) return;
  await db
    .update(submissions)
    .set({ recompute_status: 'stale' })
    .where(inArray(submissions.id, submissionIds));
}

/**
 * Mark a submission as 'error' due to a recompute failure.
 */
export async function markSubmissionRecomputeError(
  db: DrizzleDb,
  submissionId: string,
): Promise<void> {
  await db
    .update(submissions)
    .set({ recompute_status: 'error' })
    .where(eq(submissions.id, submissionId));
}
