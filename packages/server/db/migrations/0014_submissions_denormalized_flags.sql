-- Migration 0014: denormalize cohort-list columns onto submissions
--
-- P1-1a fix: at 50k submissions, GET /semesters/{id}/submissions was running
-- p95 ~928ms vs the PRD §16.1 ceiling of 300ms. The dominant cost was the
-- two correlated sub-queries (flag_counts aggregation + top_flags ROW_NUMBER
-- window) that ran per-page on every list request. Both can be answered by
-- jsonb columns on `submissions` that the heuristic-compute write site
-- (run-per-submission + recompute-submission) keeps in sync.
--
-- Adds:
--   flag_counts   jsonb    — { "info": N, "low": N, "medium": N, "high": N }.
--                            Default zero counts for submissions that haven't
--                            been scored yet.
--   top_flags     jsonb    — array of up to 3 { heuristic_id, severity }
--                            sorted by severity_rank DESC, confidence DESC.
--                            Empty array for unscored submissions.
--   severity_rank smallint — 0=info, 1=low, 2=medium, 3=high. Derived from
--                            score_max_severity but stored as a number so the
--                            severity_min filter is a single range predicate
--                            instead of OR-expansion across severity strings.
--
-- The partial cohort index is recreated to cover severity_rank so the common
-- "show me everything at medium+ severity in this semester" query can be
-- answered without dropping to a heap scan.
--
-- The backfill UPDATE re-derives flag_counts/top_flags/severity_rank for
-- every existing submission row from the existing `flags` rows in a single
-- statement. For 50k submissions this is one query, not 50k.

ALTER TABLE submissions
  ADD COLUMN flag_counts   jsonb NOT NULL DEFAULT '{"info":0,"low":0,"medium":0,"high":0}'::jsonb,
  ADD COLUMN top_flags     jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN severity_rank smallint NOT NULL
    GENERATED ALWAYS AS (
      CASE score_max_severity
        WHEN 'info'   THEN 0::smallint
        WHEN 'low'    THEN 1::smallint
        WHEN 'medium' THEN 2::smallint
        WHEN 'high'   THEN 3::smallint
      END
    ) STORED;

-- Backfill: re-derive denormalized columns from existing flags rows.
-- This is one UPDATE that touches every submission once, regardless of how
-- many flags each has.
WITH flag_agg AS (
  SELECT
    submission_id,
    jsonb_build_object(
      'info',   COUNT(*) FILTER (WHERE severity = 'info'),
      'low',    COUNT(*) FILTER (WHERE severity = 'low'),
      'medium', COUNT(*) FILTER (WHERE severity = 'medium'),
      'high',   COUNT(*) FILTER (WHERE severity = 'high')
    ) AS counts
  FROM flags
  GROUP BY submission_id
),
top_agg AS (
  SELECT
    submission_id,
    jsonb_agg(
      jsonb_build_object('heuristic_id', heuristic_id, 'severity', severity)
      ORDER BY rn
    ) FILTER (WHERE rn <= 3) AS top
  FROM (
    SELECT
      submission_id,
      heuristic_id,
      severity,
      ROW_NUMBER() OVER (
        PARTITION BY submission_id
        ORDER BY
          CASE severity
            WHEN 'high'   THEN 3
            WHEN 'medium' THEN 2
            WHEN 'low'    THEN 1
            ELSE               0
          END DESC,
          confidence DESC
      ) AS rn
    FROM flags
  ) ranked
  GROUP BY submission_id
)
-- severity_rank is GENERATED so we only backfill the jsonb columns here.
UPDATE submissions s
SET
  flag_counts = COALESCE(flag_agg.counts,
                         '{"info":0,"low":0,"medium":0,"high":0}'::jsonb),
  top_flags   = COALESCE(top_agg.top, '[]'::jsonb)
FROM (SELECT id FROM submissions) sub
LEFT JOIN flag_agg ON flag_agg.submission_id = sub.id
LEFT JOIN top_agg  ON top_agg.submission_id  = sub.id
WHERE s.id = sub.id;

-- Replace the partial cohort index with one that covers severity_rank.
-- Old definition: (semester_id, assignment_id, score_total DESC) WHERE
-- superseded_by_submission_id IS NULL.
--
-- New definition keeps the same leading columns for the default sort path
-- but appends severity_rank so the severity_min filter can be answered from
-- the index. The trailing id is a tie-breaker for the cursor pagination's
-- (score_total, id) tuple.
DROP INDEX IF EXISTS submissions_cohort_idx;
CREATE INDEX submissions_cohort_idx
  ON submissions (semester_id, score_total DESC, severity_rank, id)
  WHERE superseded_by_submission_id IS NULL;
