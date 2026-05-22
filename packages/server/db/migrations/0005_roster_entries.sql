-- Migration: 0005_roster_entries
-- Creates the roster_entries table per PRD §5.2.
--
-- Design notes:
-- - sid is unique per semester; matched case-insensitively during CSV diffing.
-- - extras is a jsonb column for additional CSV columns beyond sid/display_name/email.
-- - Rows are deleted when a commit with accept_deletions=true removes them.

CREATE TABLE roster_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id  uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  sid          text NOT NULL,
  display_name text NOT NULL,
  email        text,
  extras       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semester_id, sid)
);

CREATE INDEX roster_entries_semester_id_idx ON roster_entries(semester_id);
-- Functional index on LOWER(email) per PRD §5.2.
-- The q= filter does ilike on both display_name + email; only the email side
-- is index-assisted (the design choice in the PRD), which matches typical
-- staff workflow of looking students up by email.
CREATE INDEX roster_entries_semester_email_idx ON roster_entries(semester_id, LOWER(email));
