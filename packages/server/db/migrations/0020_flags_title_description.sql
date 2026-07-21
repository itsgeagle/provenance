-- Migration 0020: persist per-flag title and description.
--
-- analysis-core heuristics generate per-instance prose alongside every flag —
-- title ("Large paste in hw.py") and description ("A paste of 812 characters,
-- 34 lines was detected in hw.py."). Both are derived from the same data that
-- lands in `detail`, but neither was persisted, so the server-backed analyzer
-- could only ever show the raw heuristic_id. The /local route, which keeps the
-- flags in memory, has always shown the prose.
--
-- Populated by the two paths that build flag rows: runAndStoreHeuristics
-- (ingest) and recomputeSubmission (tuning). Existing rows keep the '' default
-- and the analyzer falls back to heuristic_id until a recompute repopulates
-- them; no data migration is required.

ALTER TABLE flags ADD COLUMN title       text NOT NULL DEFAULT '';
ALTER TABLE flags ADD COLUMN description text NOT NULL DEFAULT '';
