/**
 * Default heuristic config v0 — Phase 12 temporary hard-coded source.
 *
 * Phase 13 will introduce the heuristic_configs DB table and replace this
 * with a DB-sourced config lookup. The sentinel version=0 written to
 * flags.heuristic_config_version during Phase 12 ingest will be migrated to
 * version=1 as part of the Phase 13 backfill migration.
 *
 * DO NOT modify packages/analyzer/src/heuristics/config.ts — this file
 * re-exports from there exclusively.
 */

export { DEFAULT_HEURISTIC_CONFIG as DEFAULT_CONFIG_V0 } from '@provenance/analyzer/src/heuristics/config.js';

/**
 * Sentinel version for the Phase 12 hard-coded config.
 *
 * All flags written during Phase 12 ingest carry this version.
 * Phase 13's backfill migration will update them to version=1 (the first
 * DB-managed config version).
 */
export const HEURISTIC_CONFIG_VERSION_V0 = 0;
