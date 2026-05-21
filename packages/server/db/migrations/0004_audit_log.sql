-- Migration: 0004_audit_log
-- Creates the audit_log table per PRD §5.7.
--
-- Audit rows are append-only: the application never updates or deletes them
-- except via the retention sweep (which only runs after derived_retention_days
-- and never removes rows flagged preserve=true in a future release).

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_token_id  uuid REFERENCES api_tokens(id) ON DELETE SET NULL,
  semester_id     uuid REFERENCES semesters(id) ON DELETE SET NULL,
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  ip              inet,
  user_agent      text,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_semester_at_idx ON audit_log(semester_id, at DESC);
CREATE INDEX audit_log_actor_at_idx    ON audit_log(actor_user_id, at DESC);
CREATE INDEX audit_log_action_at_idx   ON audit_log(action, at DESC);
