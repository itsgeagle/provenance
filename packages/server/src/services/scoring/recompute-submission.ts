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
 * Bundle reconstruction is delegated to the shared helper in
 * services/heuristics/reconstruct-bundle.ts (extracted in Phase 14 so
 * run-cross.ts can reuse the same logic). See V31 + V32 for design decisions.
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
import type { Severity } from '@provenance/analyzer/src/heuristics/types.js';
import { flags, submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import type { ServerHeuristicConfig } from '../heuristics/config.js';
import { reconstructBundleFromDb } from '../heuristics/reconstruct-bundle.js';
import { computeScore } from './compute.js';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type RecomputeResult = {
  score_total: number;
  score_max_severity: Severity;
  flag_count: number;
};

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
  // Step 1: Reconstruct Bundle + EventIndex + ValidationReport from DB.
  //
  // Delegates to the shared reconstructBundleFromDb helper (extracted in
  // Phase 14 for reuse by run-cross.ts). See V31/V32 for strategy rationale.
  // -------------------------------------------------------------------------
  const { bundle, index: reconstructedIndex, validationReport } = await reconstructBundleFromDb(
    db,
    submissionId,
  );

  // -------------------------------------------------------------------------
  // Step 2: Build EventIndex and run heuristics.
  //
  // reconstructBundleFromDb already calls buildIndex; we call it again here
  // to get the same index as a ReturnType<typeof buildIndex> for translateFlagsToRows.
  // This is a cheap O(n_events) operation (~1ms for typical bundles; V27).
  //
  // Pass undefined configOverride — the server-side ServerHeuristicConfig
  // (enabled/weight/severity_weights) is distinct from v2's HeuristicConfig
  // (threshold values). v2's runHeuristics uses its own DEFAULT_HEURISTIC_CONFIG
  // internally for threshold-based logic. The server-side enabled/weight is
  // applied below when translating flags to DB rows.
  // -------------------------------------------------------------------------
  const index = buildIndex(bundle);
  void reconstructedIndex; // the helper's copy; we rebuild for type compatibility
  const rawFlags = runHeuristics(index, bundle, validationReport, undefined);

  // -------------------------------------------------------------------------
  // Step 3: Translate flags to DB rows using the server-side config.
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
  // Step 4: Compute aggregate score.
  // -------------------------------------------------------------------------
  const { score_total, score_max_severity } = computeScore(scoreInputs);
  const flag_count = flagRows.length;

  if (simulate) {
    // Dry-run: return scores without writing anything.
    return { score_total, score_max_severity, flag_count };
  }

  // -------------------------------------------------------------------------
  // Step 5: Write to DB in a single transaction.
  //
  // 5a. Mark submission as recomputing (visible to other readers during recompute).
  // 5b. Delete all existing flags.
  // 5c. Insert new flags.
  // 5d. Update submission score + heuristic_config_version + recompute_status='fresh'.
  //
  // All 4 writes are atomic: a retry after crash sees a clean state.
  // -------------------------------------------------------------------------
  await withTransaction(db, async (tx) => {
    // 5a: recomputing sentinel
    await tx
      .update(submissions)
      .set({ recompute_status: 'recomputing' })
      .where(eq(submissions.id, submissionId));

    // 5b: DELETE old flags
    await tx.delete(flags).where(eq(flags.submission_id, submissionId));

    // 5c: INSERT new flags (skip if empty)
    if (flagRows.length > 0) {
      await tx.insert(flags).values(flagRows);
    }

    // 5d: UPDATE submission
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
