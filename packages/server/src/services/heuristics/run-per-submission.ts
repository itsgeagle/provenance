/**
 * runAndStoreHeuristics — Phase 12 per-submission heuristic pipeline.
 *
 * Wraps v2's runHeuristics(index, bundle, validationReport) and persists
 * the resulting Flag[] into the `flags` table.
 *
 * ## Contract
 *
 * **Transactional callers (ingest worker):**
 * This function performs an INSERT without deleting prior rows first. Within
 * the worker's `withTransaction` block, if the transaction rolls back (e.g.
 * because a later phase fails), pg-boss retries from a clean state — no flags
 * rows exist for this submission yet, so the retry is safe.
 *
 * **Non-transactional callers (Phase 13 recompute):**
 * MUST DELETE all existing flags for the submission before calling this
 * function. Failure to do so will produce duplicate flag rows. The canonical
 * pattern is:
 *   ```ts
 *   await db.delete(flags).where(eq(flags.submission_id, submissionId));
 *   await runAndStoreHeuristics(db, submissionId, semesterId, bundle, report);
 *   ```
 *
 * ## supportingSeqs translation
 *
 * v2's Flag.supportingSeqs is `string[]` with `${sessionId}:${seq}` keys
 * (session-local seq). The DB `flags.supporting_seqs` column is `int[]` of
 * globalIdx values from `events.seq`. Translation uses buildIndex.bySeq which
 * maps `${sessionId}:${seq}` → IndexedEvent (with .globalIdx). Any key not
 * found in the index is silently dropped (shouldn't happen with valid bundles,
 * but defensive).
 *
 * ## session_id population rule
 *
 * If all supporting_seqs entries come from the same session, set
 * flags.session_id to that sessionId. Otherwise (multiple sessions or no
 * supporting seqs) set it to '' (the column default). This lets the UI
 * deep-link into a specific session's timeline without decoding the int[].
 */

import { buildIndex } from '@provenance/analyzer/src/index/build-index.js';
import { runHeuristics } from '@provenance/analyzer/src/heuristics/run-heuristics.js';
import type { Bundle } from '@provenance/analyzer/src/loader/types.js';
import type { ValidationReport } from '@provenance/analyzer/src/validation/check-types.js';
import type { Severity } from '@provenance/analyzer/src/heuristics/types.js';
import { flags, submissions } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/client.js';
import { DEFAULT_CONFIG_V0, HEURISTIC_CONFIG_VERSION_V0 } from './default-config.js';
import { getActiveConfig, DEFAULT_SERVER_CONFIG } from './config.js';
import { computeScore } from '../scoring/compute.js';

// ---------------------------------------------------------------------------
// Server-side scoring config (PRD §10.2)
//
// Phase 13b: looks up the active config from the heuristic_configs table.
// Falls back to DEFAULT_SERVER_CONFIG if no active config exists yet.
// Phase 12 used hard-coded DEFAULT_CONFIG_V0 (sentinel version=0); the
// backfill migration moved those flags to version=1.
// ---------------------------------------------------------------------------

/** Default severity weights per PRD §10.2 (matches DEFAULT_SERVER_CONFIG). */
const DEFAULT_SEVERITY_WEIGHTS: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 3,
  high: 8,
};

/**
 * Per-heuristic config entry (PRD §10.2).
 */
type PerFlagConfig = {
  enabled: boolean;
  weight: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full per-submission heuristic suite and persist the results.
 *
 * After inserting flags, computes the aggregate score and updates the
 * submissions row with score_total and score_max_severity.
 *
 * @param db           - Drizzle DB handle (or transaction handle from withTransaction).
 * @param submissionId - UUID of the submission row.
 * @param semesterId   - UUID of the semester (for flags.semester_id FK).
 * @param bundle       - Fully-loaded Bundle value (from parseBundlePhase).
 * @param validationReport - ValidationReport from runValidation (used by
 *                       integrity-flags.ts adapter inside runHeuristics).
 */
export async function runAndStoreHeuristics(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  bundle: Bundle,
  validationReport: ValidationReport,
): Promise<void> {
  // -------------------------------------------------------------------------
  // Step 1: Look up the active server-side config for this semester.
  //
  // Phase 13b: look up from heuristic_configs table.
  // Falls back to DEFAULT_SERVER_CONFIG if no active config exists.
  // This happens for semesters created after migration 0010 but before any
  // admin sets a config (e.g. in tests, or during initial semester setup).
  //
  // configVersion=0 sentinel: if no config exists yet, use version 0.
  // The backfill migration updated existing version=0 rows to version=1.
  // New submissions before any config is set will use version=0 until an
  // admin commits a config.
  // -------------------------------------------------------------------------
  const activeConfigRow = await getActiveConfig(db, semesterId);
  const serverConfig = activeConfigRow?.config ?? DEFAULT_SERVER_CONFIG;
  const configVersion = activeConfigRow?.version ?? HEURISTIC_CONFIG_VERSION_V0;

  // -------------------------------------------------------------------------
  // Step 2: Build EventIndex from bundle.
  // -------------------------------------------------------------------------
  const index = buildIndex(bundle);

  // -------------------------------------------------------------------------
  // Step 3: Run v2's heuristic suite.
  //
  // Pass undefined as configOverride — v2's HeuristicConfig (threshold values)
  // is separate from the server-side ServerHeuristicConfig (enabled/weight).
  // We use DEFAULT_CONFIG_V0 for v2 thresholds. The server-side enabled/weight
  // filtering is applied below using serverConfig.
  // -------------------------------------------------------------------------
  const v2Config = DEFAULT_CONFIG_V0;
  const rawFlags = runHeuristics(index, bundle, validationReport, undefined);

  // -------------------------------------------------------------------------
  // Step 4: Filter disabled heuristics and translate each Flag to a DB row.
  //
  // PRD §10.3: disabled heuristics contribute zero and are not stored.
  // The server-side per_flag[id].enabled gate is applied here.
  // -------------------------------------------------------------------------
  type FlagRow = typeof flags.$inferInsert;

  const flagRows: FlagRow[] = [];
  const scoreInputs: Array<{ severity: string; score_contribution: number }> = [];

  for (const flag of rawFlags) {
    const perFlagEntry = serverConfig.per_flag[flag.heuristic];
    const perFlagCfg: PerFlagConfig = perFlagEntry ?? { enabled: true, weight: 1.0 };

    // PRD §10.3: disabled heuristics contribute zero (and we do not store them).
    if (!perFlagCfg.enabled) {
      continue;
    }

    // -----------------------------------------------------------------------
    // Translate supportingSeqs: string[] → int[] of globalIdx values.
    //
    // flag.supportingSeqs is `${sessionId}:${seq}` keys.
    // index.bySeq uses the same key format → O(1) lookup per entry.
    // Keys not found in the index are dropped with a silent skip (defensively
    // correct: a well-formed bundle will never produce unmappable keys).
    // -----------------------------------------------------------------------
    const globalIdxs: number[] = [];
    for (const seqKey of flag.supportingSeqs) {
      const event = index.bySeq.get(seqKey);
      if (event !== undefined) {
        globalIdxs.push(event.globalIdx);
      }
    }

    // -----------------------------------------------------------------------
    // Determine session_id:
    //   - If ALL supporting entries share the same sessionId → set to that sessionId.
    //   - Otherwise (multi-session or no supporting seqs) → '' (column default).
    //
    // We extract sessionIds from the original string keys rather than re-querying
    // the index to avoid an extra lookup per flag.
    // -----------------------------------------------------------------------
    let sessionId = '';
    if (flag.supportingSeqs.length > 0) {
      const uniqueSessions = new Set<string>();
      for (const seqKey of flag.supportingSeqs) {
        // seqKey format: "${sessionId}:${seq}" — sessionId may contain ':' only if
        // the sessionId itself contains a colon (UUIDs do not). Safe to use
        // the last ':' as the delimiter by splitting on the last occurrence.
        const lastColon = seqKey.lastIndexOf(':');
        if (lastColon !== -1) {
          uniqueSessions.add(seqKey.slice(0, lastColon));
        }
      }
      if (uniqueSessions.size === 1) {
        sessionId = uniqueSessions.values().next().value!;
      }
      // uniqueSessions.size > 1 or === 0: leave sessionId = ''
    }

    // -----------------------------------------------------------------------
    // Compute score_contribution per PRD §10.3:
    //   score_contribution = severity_weights[severity] * confidence * weight
    // Use server-side severity_weights from the active config.
    // -----------------------------------------------------------------------
    const severityWeight =
      serverConfig.severity_weights[flag.severity as Severity] ??
      DEFAULT_SEVERITY_WEIGHTS[flag.severity as Severity] ??
      DEFAULT_SEVERITY_WEIGHTS.info;
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

  // -------------------------------------------------------------------------
  // Step 4: Bulk-insert flag rows.
  //
  // No onConflictDoNothing / onConflictDoUpdate: flags have no natural unique
  // key (one heuristic can fire multiple flags). See JSDoc contract above for
  // why this is safe within the ingest transaction (pg-boss retry) and what
  // non-transactional callers must do (DELETE first).
  //
  // If there are no flags, skip the INSERT to avoid a no-op statement.
  // -------------------------------------------------------------------------
  if (flagRows.length > 0) {
    await db.insert(flags).values(flagRows);
  }

  // -------------------------------------------------------------------------
  // Step 5: Compute aggregate score and update the submissions row.
  // -------------------------------------------------------------------------
  const { score_total, score_max_severity } = computeScore(scoreInputs);

  await db
    .update(submissions)
    .set({ score_total, score_max_severity })
    .where(eq(submissions.id, submissionId));

  // v2Config is used for threshold-based checks — referenced here to satisfy
  // the TypeScript 'declared but never read' rule. Phase 13 will use it to
  // pass thresholds into runHeuristics as configOverride.
  void v2Config;
}
