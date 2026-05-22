-- Migration 0006: ingest_jobs, ingest_files, assignments, submissions
-- PRD §5.2 (assignments), §5.3 (ingest_jobs, ingest_files), §5.4 (submissions)
--
-- Note: functional/partial indexes (submissions_cohort_idx, ingest_files_unmatched_idx)
-- are SQL-only per V10 convention — drizzle-kit cannot express them in schema.ts.
-- Table defs in schema.ts carry standard indexes only.

-- ---------------------------------------------------------------------------
-- assignments  (PRD §5.2)
-- ---------------------------------------------------------------------------

CREATE TABLE assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id         uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  assignment_id_str   text NOT NULL,
  label               text NOT NULL DEFAULT '',
  sort_order          int  NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semester_id, assignment_id_str)
);

-- ---------------------------------------------------------------------------
-- ingest_jobs  (PRD §5.3)
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id     uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL,
  summary         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled'))
);

CREATE INDEX ingest_jobs_semester_id_idx ON ingest_jobs(semester_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- submissions  (PRD §5.4)
-- Must be declared before ingest_files because ingest_files FKs to it.
-- ---------------------------------------------------------------------------

CREATE TABLE submissions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id                 uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  assignment_id               uuid NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  student_id                  uuid NOT NULL REFERENCES roster_entries(id) ON DELETE RESTRICT,
  blob_object_key             text NOT NULL,
  blob_sha256                 text NOT NULL,
  recorder_version            text NOT NULL DEFAULT '',
  format_version              text NOT NULL DEFAULT '',
  source_filename             text NOT NULL,
  ingest_job_id               uuid NOT NULL REFERENCES ingest_jobs(id) ON DELETE RESTRICT,
  ingested_at                 timestamptz NOT NULL DEFAULT now(),
  version_index               int NOT NULL,
  superseded_by_submission_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
  score_total                 double precision NOT NULL DEFAULT 0,
  score_max_severity          text NOT NULL DEFAULT 'info',
  validation_status           text NOT NULL DEFAULT 'pending',
  heuristic_config_version    int NOT NULL DEFAULT 0,
  recompute_status            text NOT NULL DEFAULT 'fresh',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semester_id, assignment_id, student_id, version_index),
  CHECK (score_max_severity IN ('info','low','medium','high')),
  CHECK (validation_status IN ('pending','pass','warn','fail')),
  CHECK (recompute_status IN ('fresh','stale','recomputing','error'))
);

-- Partial covering index for cohort list (non-superseded only) per PRD §5.4.
-- Cannot be expressed in Drizzle schema; lives here only.
CREATE INDEX submissions_cohort_idx
  ON submissions (semester_id, assignment_id, score_total DESC)
  WHERE superseded_by_submission_id IS NULL;

CREATE INDEX submissions_student_idx ON submissions (semester_id, student_id);
CREATE INDEX submissions_blob_sha_idx ON submissions (semester_id, blob_sha256);

-- ---------------------------------------------------------------------------
-- ingest_files  (PRD §5.3)
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_files (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_job_id         uuid NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,
  original_filename     text NOT NULL,
  size_bytes            bigint NOT NULL,
  blob_sha256           text NOT NULL,
  status                text NOT NULL,
  matched_student_id    uuid REFERENCES roster_entries(id) ON DELETE SET NULL,
  matched_assignment_id uuid REFERENCES assignments(id) ON DELETE SET NULL,
  submission_id         uuid REFERENCES submissions(id) ON DELETE SET NULL,
  filename_capture      jsonb,
  error                 jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  resolved_by           uuid REFERENCES users(id),
  CHECK (status IN ('pending','matched','unmatched','duplicate','failed','superseded','discarded'))
);

CREATE INDEX ingest_files_job_idx ON ingest_files(ingest_job_id);
CREATE INDEX ingest_files_blob_sha256_idx ON ingest_files(blob_sha256);

-- Partial index for the unmatched-tray query — SQL-only per V10 convention.
CREATE INDEX ingest_files_unmatched_idx ON ingest_files(ingest_job_id) WHERE status='unmatched';
