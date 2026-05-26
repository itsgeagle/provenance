-- Migration 0013: view-as columns on sessions
--
-- Adds two nullable columns so a superadmin can scope their session to view
-- the analyzer as another user (read-only). Both columns are null when
-- view-as is inactive (the common case).
--
--   view_as_user_id      — target user the superadmin is currently impersonating.
--                          ON DELETE SET NULL so a target user's removal
--                          gracefully exits view-as for any active sessions.
--   view_as_started_at   — set at the moment view-as is entered; used for the
--                          UI banner and audit attribution.
--
-- Server enforcement (auth-session + authorize) ensures that:
--   - Only sessions of superadmins can have view_as_user_id set.
--   - When set, all non-read actions return VIEW_AS_READ_ONLY (403).
--   - Token principals cannot impersonate (view-as is session-only).

ALTER TABLE sessions
  ADD COLUMN view_as_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN view_as_started_at timestamptz;
