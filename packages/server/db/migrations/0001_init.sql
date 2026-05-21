-- Migration: 0001_init
-- Creates the identity & structure tables per PRD §5.1 and §4.2.
--
-- Design notes:
-- - gen_random_uuid() is built into Postgres 16 (pgcrypto not required).
--   We do NOT create the pgcrypto extension; Postgres 13+ includes
--   gen_random_uuid() as a core built-in function.
-- - Enums (role, term) are text columns with CHECK constraints, NOT Postgres
--   enum types. This matches PRD §5.1 explicit guidance and simplifies future
--   value additions (no ALTER TYPE … ADD VALUE DDL needed).
-- - Functional indexes (LOWER(email) on users; LOWER(email)+semester_id on
--   pending_invitations) are hand-authored here because drizzle-kit cannot
--   express them fully in schema.ts.
-- - The partial unique index on pending_invitations is hand-authored for the
--   same reason (Drizzle does not support WHERE clauses on indexes in schema.ts).

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject  text NOT NULL UNIQUE,
  email           text NOT NULL,
  display_name    text NOT NULL DEFAULT '',
  is_superadmin   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

-- Case-insensitive unique index on email (PRD §5.1)
CREATE UNIQUE INDEX users_email_lower_idx ON users(LOWER(email));

-- ---------------------------------------------------------------------------
-- sessions  (PRD §4.2)
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id              text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  ip              inet,
  user_agent      text
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- courses  (PRD §5.1)
-- ---------------------------------------------------------------------------

CREATE TABLE courses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- semesters  (PRD §5.1)
-- ---------------------------------------------------------------------------

CREATE TABLE semesters (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id              uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  term                   text NOT NULL,
  year                   int  NOT NULL,
  slug                   text NOT NULL,
  display_name           text NOT NULL,
  filename_convention    text NOT NULL,
  blob_retention_days    int  NOT NULL DEFAULT 540,
  derived_retention_days int  NOT NULL DEFAULT 1825,
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, slug),
  CHECK (term IN ('fa','sp','su','wi')),
  CHECK (year BETWEEN 2000 AND 2100),
  CHECK (blob_retention_days >= 30),
  CHECK (derived_retention_days >= blob_retention_days)
);

-- ---------------------------------------------------------------------------
-- memberships  (PRD §5.1)
-- ---------------------------------------------------------------------------

CREATE TABLE memberships (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  semester_id uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  role        text NOT NULL,
  granted_by  uuid NOT NULL REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, semester_id),
  CHECK (role IN ('admin','grader'))
);

CREATE INDEX memberships_semester_id_idx ON memberships(semester_id);

-- ---------------------------------------------------------------------------
-- pending_invitations  (PRD §4.4)
-- ---------------------------------------------------------------------------

CREATE TABLE pending_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  semester_id uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  role        text NOT NULL,
  invited_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  CHECK (role IN ('admin','grader'))
);

-- Partial unique index: only one open (unconsumed) invitation per email+semester.
-- Partial indexes cannot be expressed in drizzle-kit schema output; authored here.
CREATE UNIQUE INDEX pending_invitations_unique_open
  ON pending_invitations(LOWER(email), semester_id) WHERE consumed_at IS NULL;
