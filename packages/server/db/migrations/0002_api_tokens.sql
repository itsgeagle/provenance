-- Migration: 0002_api_tokens
-- Creates the api_tokens table per PRD §4.3.
--
-- Design notes:
-- - prefix: 8 alphanumeric characters, unique per token. Generated server-side.
-- - hashed_token: argon2id hash of the full prov_<prefix>_<random> token.
-- - scopes: jsonb with { read_only, semester_ids, include_blobs } shape.
--   Enforcement lands in Phase 4; Phase 3 stores and surfaces.
-- - last_used_at: bumped on each successful token verification (Phase 3).
-- - expires_at: nullable; NULL means no expiry.
-- - revoked_at: when set (non-NULL), token is revoked.

CREATE TABLE api_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           text NOT NULL,
  prefix          text NOT NULL,
  hashed_token    text NOT NULL,
  scopes          jsonb NOT NULL DEFAULT '{}',
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX api_tokens_prefix_idx ON api_tokens(prefix);
CREATE INDEX api_tokens_user_id_idx ON api_tokens(user_id);
