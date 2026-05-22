-- migration: 0010_heuristic_configs_and_recompute
-- Creates heuristic_configs and recompute_jobs tables per PRD §5.5.
-- Backfills v1 default config for every existing semester (admin-only).
-- Migrates flags.heuristic_config_version and submissions.heuristic_config_version 0 → 1.
--
-- IMPORTANT: The JSON literal below is the canonical DEFAULT_HEURISTIC_CONFIG
-- (v2 format, PRD §10.2 server-side shape). Future changes to default weights
-- require a FOLLOW-UP migration — do NOT edit this SQL retroactively.
--
-- config_format_version=1 is the first DB-managed version.
-- set_by: earliest admin member for the semester.
--   Semesters with no admin member are skipped (the next config write will create
--   the first row). This is safer than inventing a sentinel user_id.

-- ---------------------------------------------------------------------------
-- heuristic_configs  (PRD §5.5)
-- ---------------------------------------------------------------------------

CREATE TABLE heuristic_configs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id  uuid        NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  version      int         NOT NULL,
  config       jsonb       NOT NULL,
  set_by       uuid        NOT NULL REFERENCES users(id),
  set_at       timestamptz NOT NULL DEFAULT now(),
  note         text        NOT NULL DEFAULT '',
  is_active    boolean     NOT NULL DEFAULT false,
  UNIQUE (semester_id, version)
);

-- Partial unique index: at most one active config per semester.
-- Drizzle cannot express partial unique indexes; defined here only (V27 convention).
CREATE UNIQUE INDEX heuristic_configs_active_idx
  ON heuristic_configs(semester_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- recompute_jobs  (PRD §5.5)
-- ---------------------------------------------------------------------------

CREATE TABLE recompute_jobs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id       uuid        NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  target_config_id  uuid        NOT NULL REFERENCES heuristic_configs(id),
  triggered_by      uuid        NOT NULL REFERENCES users(id),
  status            text        NOT NULL,
  progress_total    int         NOT NULL DEFAULT 0,
  progress_done     int         NOT NULL DEFAULT 0,
  progress_failed   int         NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  summary           jsonb       NOT NULL DEFAULT '{}',
  CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled'))
);

CREATE INDEX recompute_jobs_sem_idx ON recompute_jobs(semester_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Backfill: insert v1 default config for every existing semester that has
-- at least one admin member. set_by = earliest admin member.
--
-- Semesters with no admin member are skipped (safe — the next config write
-- will create the first row for those semesters).
-- ---------------------------------------------------------------------------

-- NOTE FOR DEVELOPERS: If you applied an earlier draft of this migration
-- (which had only 15 per_flag entries and used "extension_set_changed"
-- instead of "extension_set_changed_mid_assignment"), run `npm run db:reset`
-- to get a clean local DB with the correct 24-entry config.

INSERT INTO heuristic_configs (semester_id, version, config, set_by, is_active, note)
SELECT
  s.id,
  1,
  '{
    "per_flag": {
      "large_paste":                           {"enabled": true, "weight": 1.0},
      "external_edits":                        {"enabled": true, "weight": 1.0},
      "low_typing_high_output":                {"enabled": true, "weight": 1.0},
      "chain_broken":                          {"enabled": true, "weight": 1.0},
      "paste_is_solution":                     {"enabled": true, "weight": 1.0},
      "mass_external_replacement":             {"enabled": true, "weight": 1.0},
      "time_to_first_save_anomaly":            {"enabled": true, "weight": 1.0},
      "idle_then_complete":                    {"enabled": true, "weight": 1.0},
      "no_intermediate_errors":                {"enabled": true, "weight": 1.0},
      "paste_matches_known_source":            {"enabled": true, "weight": 1.0},
      "ai_extension_active":                   {"enabled": true, "weight": 1.0},
      "extension_hash_mismatch":               {"enabled": true, "weight": 1.0},
      "extension_set_changed_mid_assignment":  {"enabled": true, "weight": 1.0},
      "clock_jumps":                           {"enabled": true, "weight": 1.0},
      "gap_in_heartbeats":                     {"enabled": true, "weight": 1.0},
      "manifest_sig_invalid":                  {"enabled": true, "weight": 1.0},
      "session_binding_invalid":               {"enabled": true, "weight": 1.0},
      "monotonic_t_regression":                {"enabled": true, "weight": 1.0},
      "monotonic_wall_regression":             {"enabled": true, "weight": 1.0},
      "shell_integration_disabled":            {"enabled": true, "weight": 1.0},
      "terminal_active_during_external_change":{"enabled": true, "weight": 1.0},
      "multiple_sessions_overlap":             {"enabled": true, "weight": 1.0},
      "editing_pattern_clone":                 {"enabled": true, "weight": 1.0},
      "paste_shared_across_students":          {"enabled": true, "weight": 1.0}
    },
    "severity_weights": {"info": 0, "low": 1, "medium": 3, "high": 8},
    "config_format_version": 1
  }'::jsonb,
  (
    SELECT m.user_id
    FROM memberships m
    WHERE m.semester_id = s.id AND m.role = 'admin'
    ORDER BY m.granted_at ASC
    LIMIT 1
  ),
  TRUE,
  'backfilled-v1'
FROM semesters s
WHERE EXISTS (
  SELECT 1 FROM memberships m
  WHERE m.semester_id = s.id AND m.role = 'admin'
);

-- ---------------------------------------------------------------------------
-- Migrate Phase 12 sentinel: flags.heuristic_config_version 0 → 1
-- ---------------------------------------------------------------------------

UPDATE flags SET heuristic_config_version = 1 WHERE heuristic_config_version = 0;

-- ---------------------------------------------------------------------------
-- Migrate Phase 12 sentinel: submissions.heuristic_config_version 0 → 1
-- (column already exists from migration 0006)
-- ---------------------------------------------------------------------------

UPDATE submissions SET heuristic_config_version = 1 WHERE heuristic_config_version = 0;
