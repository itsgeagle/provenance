-- Migration 0015: ingest_files.match_sid — out-of-band match hint
--
-- The Gradescope export ingest path (services/ingest/gradescope/) resolves the
-- student identity for each bundle from `submission_metadata.yml` at upload
-- time, not from the filename. It records the intended student id (`sid`) on
-- the ingest_files row so the worker can:
--   1. Match to the roster by this sid directly, skipping the semester's
--      filename_convention regex.
--   2. Dedup per (semester, student, blob) instead of (semester, blob), so two
--      co-submitters of one group bundle (identical blob bytes) each get their
--      own submission instead of the second being marked a duplicate.
--
-- Null for the normal /ingest path (filename-regex match, blob-only dedup).
-- Nullable, no backfill: existing rows are all from the filename-regex path.

ALTER TABLE ingest_files
  ADD COLUMN match_sid text;
