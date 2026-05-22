-- Migration 0012: cross_flags + cross_flag_participants tables
-- PRD §5.4 cross-submission heuristics schema.
--
-- Two new tables:
--   cross_flags            — one row per cross-heuristic finding for a semester.
--   cross_flag_participants — one row per (cross_flag, submission) pair,
--                             carrying the supporting event seq list.
--
-- Both are keyed to semesters with CASCADE delete so archival sweeps are clean.
-- cross_flag_participants also CASCADEs on cross_flags.id so a single DELETE on
-- cross_flags removes all participant rows (the replace contract in run-cross.ts).

CREATE TABLE cross_flags (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id              uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  heuristic_id             text NOT NULL,
  severity                 text NOT NULL,
  confidence               double precision NOT NULL,
  detail                   jsonb NOT NULL DEFAULT '{}',
  heuristic_config_version int NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cross_flags_severity_check CHECK (severity IN ('info','low','medium','high'))
);

CREATE TABLE cross_flag_participants (
  cross_flag_id  uuid NOT NULL REFERENCES cross_flags(id) ON DELETE CASCADE,
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  supporting_seqs int[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (cross_flag_id, submission_id)
);

-- cfp_submission_idx: look up all cross flags for a given submission (PRD §5.4).
CREATE INDEX cfp_submission_idx ON cross_flag_participants(submission_id);

-- cross_flags_sem_h_idx: list cross flags by semester + heuristic (PRD §5.4).
CREATE INDEX cross_flags_sem_h_idx ON cross_flags(semester_id, heuristic_id);
