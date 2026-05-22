/**
 * Heuristic config service — Phase 13a.
 *
 * Provides:
 *   - getActiveConfig(db, semesterId)   — fetch the active config row.
 *   - listConfigHistory(db, semesterId) — list all versions, newest first.
 *   - validateConfig(input)             — validate a PRD §10.2 config candidate.
 *
 * Phase 13b will add commitNewVersion (atomic flip + recompute enqueue).
 *
 * ## Known heuristic IDs
 *
 * The set of known IDs is defined as KNOWN_HEURISTIC_IDS below — the same
 * set backfilled in migration 0010. Any config PUT against the API must
 * include an entry for every known ID (none missing, none unknown).
 * This matches the PRD §10.2 validation rule and the convention stated in
 * docs/analyzer-v3-implementation-plan.md §13a.
 */

import { eq, desc, and, count, sql } from 'drizzle-orm';
import { heuristic_configs, recompute_jobs, submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';

// ---------------------------------------------------------------------------
// PRD §10.2 server-side config shape
// ---------------------------------------------------------------------------

export type PerFlagEntry = {
  enabled: boolean;
  weight: number;
  thresholds?: Record<string, unknown>;
};

export type SeverityWeights = {
  info: number;
  low: number;
  medium: number;
  high: number;
};

/**
 * Server-side heuristic config stored in heuristic_configs.config (PRD §10.2).
 *
 * This is DISTINCT from v2's HeuristicConfig (which carries threshold values
 * for each heuristic). This shape carries enabled/weight/thresholds per heuristic
 * ID plus overall severity_weights.
 */
export type ServerHeuristicConfig = {
  per_flag: Record<string, PerFlagEntry>;
  severity_weights: SeverityWeights;
  config_format_version: 1;
};

// ---------------------------------------------------------------------------
// Default server-side config values
// ---------------------------------------------------------------------------

/** Default severity weights per PRD §10.2. */
export const DEFAULT_SEVERITY_WEIGHTS: SeverityWeights = {
  info: 0,
  low: 1,
  medium: 3,
  high: 8,
};

/**
 * The set of known heuristic IDs. Must match the per_flag keys in migration 0010.
 *
 * PRD §10.2: "Every known heuristicId must have a per_flag entry."
 * Source of truth: the complete list of IDs in v2's heuristic suite.
 * Convention (per plan §13a): these are the known IDs — any config must have
 * an entry for each, and may not introduce unknown IDs.
 *
 * Integrity-derived flags (chain_broken, manifest_sig_invalid, etc.) are
 * included because they appear as Flag rows and must be configurable.
 */
export const KNOWN_HEURISTIC_IDS: ReadonlySet<string> = new Set([
  'large_paste',
  'external_edits',
  'low_typing_high_output',
  'chain_broken',
  'paste_is_solution',
  'mass_external_replacement',
  'time_to_first_save_anomaly',
  'idle_then_complete',
  'no_intermediate_errors',
  'paste_matches_known_source',
  'ai_extension_active',
  'extension_hash_mismatch',
  'extension_set_changed_mid_assignment',
  'clock_jumps',
  'gap_in_heartbeats',
  'manifest_sig_invalid',
  'session_binding_invalid',
  'monotonic_t_regression',
  'monotonic_wall_regression',
  'shell_integration_disabled',
  'terminal_active_during_external_change',
  'multiple_sessions_overlap',
  'editing_pattern_clone',
  'paste_shared_across_students',
]);

/** The default server-side config (all heuristics enabled, weight 1.0). */
export const DEFAULT_SERVER_CONFIG: ServerHeuristicConfig = {
  per_flag: Object.fromEntries(
    [...KNOWN_HEURISTIC_IDS].map((id) => [id, { enabled: true, weight: 1.0 }]),
  ),
  severity_weights: DEFAULT_SEVERITY_WEIGHTS,
  config_format_version: 1,
};

// ---------------------------------------------------------------------------
// getActiveConfig
// ---------------------------------------------------------------------------

export type ActiveConfigRow = {
  id: string;
  version: number;
  config: ServerHeuristicConfig;
  set_at: Date;
  note: string;
};

/**
 * Fetch the currently active heuristic config for a semester.
 *
 * Returns null if no active config exists (e.g. a semester created before
 * the backfill migration ran, or a semester with no admin member).
 * Callers that need a config should fall back to DEFAULT_SERVER_CONFIG in that case.
 */
export async function getActiveConfig(
  db: DrizzleDb,
  semesterId: string,
): Promise<ActiveConfigRow | null> {
  // Use is_active = true in the WHERE clause so Postgres can use the partial
  // unique index heuristic_configs_active_idx (WHERE is_active) — at most one
  // row is returned without a full table scan.
  const rows = await db
    .select({
      id: heuristic_configs.id,
      version: heuristic_configs.version,
      config: heuristic_configs.config,
      set_at: heuristic_configs.set_at,
      note: heuristic_configs.note,
    })
    .from(heuristic_configs)
    .where(
      and(eq(heuristic_configs.semester_id, semesterId), eq(heuristic_configs.is_active, true)),
    )
    .limit(1);

  const activeRow = rows[0];
  if (!activeRow) return null;

  return {
    id: activeRow.id,
    version: activeRow.version,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb stored as unknown, validated at write-time
    config: activeRow.config as any as ServerHeuristicConfig,
    set_at: activeRow.set_at,
    note: activeRow.note,
  };
}

// ---------------------------------------------------------------------------
// listConfigHistory
// ---------------------------------------------------------------------------

export type ConfigHistoryRow = {
  id: string;
  version: number;
  set_at: Date;
  set_by: string;
  note: string;
  is_active: boolean;
};

/**
 * List all heuristic config versions for a semester, newest first.
 */
export async function listConfigHistory(
  db: DrizzleDb,
  semesterId: string,
): Promise<ConfigHistoryRow[]> {
  const rows = await db
    .select({
      id: heuristic_configs.id,
      version: heuristic_configs.version,
      set_at: heuristic_configs.set_at,
      set_by: heuristic_configs.set_by,
      note: heuristic_configs.note,
      is_active: heuristic_configs.is_active,
    })
    .from(heuristic_configs)
    .where(eq(heuristic_configs.semester_id, semesterId))
    .orderBy(desc(heuristic_configs.version));

  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    set_at: r.set_at,
    set_by: r.set_by,
    note: r.note,
    is_active: r.is_active,
  }));
}

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

export type ValidateConfigResult =
  | { ok: true; config: ServerHeuristicConfig }
  | { ok: false; errors: string[] };

/**
 * Validate a raw candidate config against PRD §10.2 rules.
 *
 * Rules:
 *   1. config_format_version must be 1.
 *   2. per_flag must have an entry for EVERY known heuristic ID (no missing).
 *   3. per_flag must NOT have entries for UNKNOWN heuristic IDs (no extras).
 *   4. Each entry's weight must be in [0, 100].
 *   5. Each entry's enabled must be a boolean.
 *   6. severity_weights must have all 4 keys (info, low, medium, high) with
 *      numeric values >= 0.
 *
 * The "known" set is KNOWN_HEURISTIC_IDS (per convention in plan §13a:
 * these are the known IDs; the set is the same as the migration backfill).
 */
export function validateConfig(input: unknown): ValidateConfigResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['config must be an object'] };
  }

  const obj = input as Record<string, unknown>;

  // Rule 1: config_format_version
  if (obj['config_format_version'] !== 1) {
    errors.push('config_format_version must be 1');
  }

  // Rule 6: severity_weights
  const sw = obj['severity_weights'];
  if (typeof sw !== 'object' || sw === null || Array.isArray(sw)) {
    errors.push('severity_weights must be an object');
  } else {
    const swObj = sw as Record<string, unknown>;
    for (const key of ['info', 'low', 'medium', 'high'] as const) {
      const val = swObj[key];
      if (typeof val !== 'number' || !isFinite(val) || val < 0) {
        errors.push(`severity_weights.${key} must be a non-negative number`);
      }
    }
    // No extra keys check for severity_weights — PRD doesn't require it.
  }

  // Rules 2, 3, 4, 5: per_flag
  const pf = obj['per_flag'];
  if (typeof pf !== 'object' || pf === null || Array.isArray(pf)) {
    errors.push('per_flag must be an object');
  } else {
    const pfObj = pf as Record<string, unknown>;
    const inputIds = new Set(Object.keys(pfObj));

    // Rule 3: reject unknown IDs
    for (const id of inputIds) {
      if (!KNOWN_HEURISTIC_IDS.has(id)) {
        errors.push(`per_flag contains unknown heuristic ID: '${id}'`);
      }
    }

    // Rule 2: missing IDs
    for (const id of KNOWN_HEURISTIC_IDS) {
      if (!inputIds.has(id)) {
        errors.push(`per_flag is missing required heuristic ID: '${id}'`);
      }
    }

    // Rules 4 and 5: validate each entry
    for (const id of inputIds) {
      if (!KNOWN_HEURISTIC_IDS.has(id)) continue; // already reported above
      const entry = pfObj[id];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`per_flag['${id}'] must be an object`);
        continue;
      }
      const entryObj = entry as Record<string, unknown>;

      // Rule 5: enabled
      if (typeof entryObj['enabled'] !== 'boolean') {
        errors.push(`per_flag['${id}'].enabled must be a boolean`);
      }

      // Rule 4: weight in [0, 100]
      const w = entryObj['weight'];
      if (typeof w !== 'number' || !isFinite(w) || w < 0 || w > 100) {
        errors.push(`per_flag['${id}'].weight must be a number in [0, 100]`);
      }

      // thresholds is optional and opaque — no validation here.
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Safe cast: all validation passed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated above
  return { ok: true, config: input as any as ServerHeuristicConfig };
}

// ---------------------------------------------------------------------------
// commitNewVersion — Phase 13b
// ---------------------------------------------------------------------------

export type CommitNewVersionResult = {
  newConfigId: string;
  newVersion: number;
  newConfigSetAt: Date;
  recomputeJobId: string;
};

/**
 * Atomically commit a new active heuristic config version and create a
 * recompute_jobs row for it.
 *
 * Transaction contract:
 *   1. SELECT ... FOR UPDATE on the current active config row (advisory row-lock
 *      prevents concurrent commits from racing past the version bump).
 *   2. UPDATE prior active row → is_active=false.
 *   3. INSERT new row → version=prior.version+1, is_active=true.
 *   4. INSERT recompute_jobs row → status='queued',
 *        progress_total = count of non-superseded submissions.
 *
 * The pg-boss enqueue (boss.send) MUST happen OUTSIDE this transaction so the
 * queue insert is not blocked by the row lock. Callers are responsible for
 * calling boss.send after the transaction commits.
 *
 * If no active config exists, version starts at 1.
 *
 * The partial unique index (heuristic_configs WHERE is_active) guarantees
 * at most one active row per semester — this is the DB-level safety net if
 * two concurrent transactions both see no active row and both try to insert
 * version=1. In that case, the second INSERT will fail with a unique violation
 * (the transaction will be rolled back) and the caller should retry.
 *
 * @param db - Drizzle DB handle (transaction-capable).
 * @param semesterId - UUID of the semester.
 * @param candidateConfig - Already-validated ServerHeuristicConfig.
 * @param triggeredBy - UUID of the user committing the config.
 * @param note - Optional admin note for the config version.
 */
export async function commitNewVersion(
  db: DrizzleDb,
  semesterId: string,
  candidateConfig: ServerHeuristicConfig,
  triggeredBy: string,
  note: string,
): Promise<CommitNewVersionResult> {
  let newConfigId: string;
  let newVersion: number;
  let newConfigSetAt: Date;
  let recomputeJobId: string;

  await withTransaction(db, async (tx) => {
    // -------------------------------------------------------------------------
    // Step 1: Lock the current active config row.
    //
    // Using raw SQL for SELECT ... FOR UPDATE because Drizzle's typed builder
    // does not expose the FOR UPDATE clause (V25 pattern).
    // -------------------------------------------------------------------------
    const lockedRows = await tx.execute(sql`
      SELECT id, version
      FROM heuristic_configs
      WHERE semester_id = ${semesterId}
        AND is_active = true
      FOR UPDATE
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
    const lockedRowsArr = lockedRows as any as Array<{ id: string; version: number }>;
    const currentActive = lockedRowsArr[0];
    const priorVersion = currentActive?.version ?? 0;
    newVersion = priorVersion + 1;

    // -------------------------------------------------------------------------
    // Step 2: Deactivate the current active config (if one exists).
    // -------------------------------------------------------------------------
    if (currentActive) {
      await tx
        .update(heuristic_configs)
        .set({ is_active: false })
        .where(eq(heuristic_configs.id, currentActive.id));
    }

    // -------------------------------------------------------------------------
    // Step 3: Insert the new active config row.
    // -------------------------------------------------------------------------
    const [inserted] = await tx
      .insert(heuristic_configs)
      .values({
        semester_id: semesterId,
        version: newVersion,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb accepts validated config
        config: candidateConfig as any,
        set_by: triggeredBy,
        is_active: true,
        note,
      })
      .returning({ id: heuristic_configs.id, set_at: heuristic_configs.set_at });

    newConfigId = inserted!.id;
    newConfigSetAt = inserted!.set_at;

    // -------------------------------------------------------------------------
    // Step 4: Count non-superseded submissions for the recompute_jobs row.
    // -------------------------------------------------------------------------
    const countResult = await tx
      .select({ cnt: count() })
      .from(submissions)
      .where(
        and(
          eq(submissions.semester_id, semesterId),
          sql`${submissions.superseded_by_submission_id} IS NULL`,
        ),
      );
    const progressTotal = countResult[0]?.cnt ?? 0;

    // -------------------------------------------------------------------------
    // Step 5: Insert the recompute_jobs row.
    // -------------------------------------------------------------------------
    const [jobRow] = await tx
      .insert(recompute_jobs)
      .values({
        semester_id: semesterId,
        target_config_id: newConfigId,
        triggered_by: triggeredBy,
        status: 'queued',
        progress_total: progressTotal,
      })
      .returning({ id: recompute_jobs.id });

    recomputeJobId = jobRow!.id;
  });

  return {
    newConfigId: newConfigId!,
    newVersion: newVersion!,
    newConfigSetAt: newConfigSetAt!,
    recomputeJobId: recomputeJobId!,
  };
}

export type CreateRecomputeJobRow = {
  id: string;
  semester_id: string;
  target_config_id: string;
  triggered_by: string;
  status: string;
  progress_total: number;
  progress_done: number;
  progress_failed: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  summary: unknown;
};

/**
 * Insert a recompute_jobs row against the CURRENT active config (no config change).
 * Used by POST /recompute.
 *
 * Returns null if no active config exists for the semester.
 *
 * @param note - Optional admin note passed as { note?: string } in the request body.
 */
export async function createRecomputeJob(
  db: DrizzleDb,
  semesterId: string,
  triggeredBy: string,
  note?: string,
): Promise<{
  recomputeJobId: string;
  targetConfigId: string;
  jobRow: CreateRecomputeJobRow;
} | null> {
  const active = await getActiveConfig(db, semesterId);
  if (!active) return null;

  // Count non-superseded submissions for the progress_total field.
  const countResult = await db
    .select({ cnt: count() })
    .from(submissions)
    .where(
      and(
        eq(submissions.semester_id, semesterId),
        sql`${submissions.superseded_by_submission_id} IS NULL`,
      ),
    );
  const progressTotal = countResult[0]?.cnt ?? 0;

  const [insertedRow] = await db
    .insert(recompute_jobs)
    .values({
      semester_id: semesterId,
      target_config_id: active.id,
      triggered_by: triggeredBy,
      status: 'queued',
      progress_total: progressTotal,
      summary: note !== undefined ? { note } : {},
    })
    .returning();

  const jobRow: CreateRecomputeJobRow = {
    id: insertedRow!.id,
    semester_id: insertedRow!.semester_id,
    target_config_id: insertedRow!.target_config_id,
    triggered_by: insertedRow!.triggered_by,
    status: insertedRow!.status,
    progress_total: insertedRow!.progress_total,
    progress_done: insertedRow!.progress_done,
    progress_failed: insertedRow!.progress_failed,
    created_at: insertedRow!.created_at,
    started_at: insertedRow!.started_at ?? null,
    completed_at: insertedRow!.completed_at ?? null,
    summary: insertedRow!.summary,
  };

  return {
    recomputeJobId: insertedRow!.id,
    targetConfigId: active.id,
    jobRow,
  };
}
