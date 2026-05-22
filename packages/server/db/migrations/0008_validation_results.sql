-- migration: 0008_validation_results
-- Creates the validation_results table per PRD §5.4.
--
-- Design notes:
-- - PK is submission_id (single-column); each submission has at most one
--   validation result row. ON DELETE CASCADE cleans up when submission is
--   deleted.
-- - The 8 check_N_status columns correspond to the 8 checks in PRD §5.4 spec
--   order (same order v2's runValidation returns them):
--     1. manifest_sig
--     2. session_binding
--     3. chain_integrity
--     4. seq_gaps
--     5. monotonic_t
--     6. monotonic_wall
--     7. doc_save_hashes
--     8. submitted_code_match  (always 'skipped' in v1 by design)
-- - Each check_N_status accepts all four values: 'pass'|'fail'|'warn'|'skipped'.
--   The DB CHECK constraint is the authority; v2 currently emits only
--   'pass'|'fail'|'skipped', but the schema pre-accepts 'warn' for future use.
-- - overall mirrors submissions.validation_status minus 'pending'.
-- - detail (jsonb): the full ValidationReport.checks array serialized so the
--   API can return human-readable check labels/details without re-running
--   validation.
-- - validated_at: timestamp of when this result was written; default now()
--   is idiomatic for these append-then-upsert records.

CREATE TABLE validation_results (
  submission_id  uuid        PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  check_1_status text        NOT NULL,
  check_2_status text        NOT NULL,
  check_3_status text        NOT NULL,
  check_4_status text        NOT NULL,
  check_5_status text        NOT NULL,
  check_6_status text        NOT NULL,
  check_7_status text        NOT NULL,
  check_8_status text        NOT NULL,
  overall        text        NOT NULL,
  detail         jsonb       NOT NULL DEFAULT '{}',
  validated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (check_1_status IN ('pass','fail','warn','skipped')),
  CHECK (check_2_status IN ('pass','fail','warn','skipped')),
  CHECK (check_3_status IN ('pass','fail','warn','skipped')),
  CHECK (check_4_status IN ('pass','fail','warn','skipped')),
  CHECK (check_5_status IN ('pass','fail','warn','skipped')),
  CHECK (check_6_status IN ('pass','fail','warn','skipped')),
  CHECK (check_7_status IN ('pass','fail','warn','skipped')),
  CHECK (check_8_status IN ('pass','fail','warn','skipped')),
  CHECK (overall IN ('pass','warn','fail'))
);
