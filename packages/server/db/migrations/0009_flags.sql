-- migration: 0009_flags
-- Creates the flags table per PRD §5.4.
--
-- Design notes:
-- - PK is gen_random_uuid() — each flag has its own UUID; there is no
--   natural unique key on (submission_id, heuristic_id) because one heuristic
--   can fire multiple flags per submission (e.g. large_paste fires once per
--   paste event). ON DELETE CASCADE on both submission_id and semester_id so
--   that deleting a submission (or semester) cascades cleanly.
-- - supporting_seqs is int[] of globalIdx values (events.seq) that contributed
--   to this flag. Translated from v2's ${sessionId}:${seq} string keys at
--   ingest time.
-- - session_id: populated only when all supporting_seqs belong to one session.
--   Set to '' (empty string default) when supporting_seqs span multiple sessions
--   or when there are no supporting_seqs.
-- - weight_at_compute and score_contribution are stored at compute time.
--   Phase 13 will switch weight_at_compute source from hard-coded default to the
--   heuristic_configs table; the columns exist now so no schema migration is
--   needed in Phase 13.
-- - heuristic_config_version=0 is the sentinel for the Phase 12 hard-coded
--   default config. Phase 13 will migrate these to version=1.
-- Three indexes per PRD §5.4: by submission, by (semester, heuristic), by
-- (semester, severity).

CREATE TABLE flags (
  id                       uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id            uuid             NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  semester_id              uuid             NOT NULL REFERENCES semesters(id)   ON DELETE CASCADE,
  heuristic_id             text             NOT NULL,
  severity                 text             NOT NULL,
  confidence               double precision NOT NULL,
  weight_at_compute        double precision NOT NULL,
  score_contribution       double precision NOT NULL,
  detail                   jsonb            NOT NULL DEFAULT '{}',
  supporting_seqs          int[]            NOT NULL DEFAULT '{}',
  session_id               text             NOT NULL DEFAULT '',
  heuristic_config_version int              NOT NULL,
  created_at               timestamptz      NOT NULL DEFAULT now(),
  CHECK (severity IN ('info','low','medium','high')),
  CHECK (confidence BETWEEN 0 AND 1)
);

CREATE INDEX flags_sub_idx      ON flags (submission_id);
CREATE INDEX flags_sem_heur_idx ON flags (semester_id, heuristic_id);
CREATE INDEX flags_sem_sev_idx  ON flags (semester_id, severity);
