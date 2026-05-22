-- migration: 0007_events_per_file_stats
-- Creates events and per_file_stats tables per PRD §5.4.
--
-- Design notes:
-- - events.seq is the monotonic chronological index across all sessions within
--   a submission. This is IndexedEvent.globalIdx from v2 buildIndex, NOT the
--   session-local seq in the bundle envelope.
-- - events.payload is jsonb NOT NULL — preserves the original event data object
--   from the bundle envelope as-is for structured queries.
-- - events.prev_hash + events.hash carry the log-core hash-chain values from
--   HashedEnvelope, enabling server-side chain verification.
-- - per_file_stats.final_length and start_length store 0 at ingest time.
--   Reconstruction is a Phase 18 concern; v2 computeStats (FileStats) does
--   not compute them.
-- - All three event indexes are plain composite B-trees (no functional/partial
--   expressions), so they are also representable in Drizzle schema.ts.

CREATE TABLE events (
  submission_id   uuid  NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  seq             int   NOT NULL,
  session_id      text  NOT NULL,
  t               int   NOT NULL,
  wall            timestamptz NOT NULL,
  kind            text  NOT NULL,
  payload         jsonb NOT NULL,
  prev_hash       text  NOT NULL,
  hash            text  NOT NULL,
  PRIMARY KEY (submission_id, seq)
);

CREATE INDEX events_sub_kind_t_idx      ON events (submission_id, kind, t);
CREATE INDEX events_sub_t_idx           ON events (submission_id, t);
CREATE INDEX events_sub_session_seq_idx ON events (submission_id, session_id, seq);

CREATE TABLE per_file_stats (
  submission_id               uuid    NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  file_path                   text    NOT NULL,
  chars_typed                 int     NOT NULL DEFAULT 0,
  chars_pasted                int     NOT NULL DEFAULT 0,
  chars_external_change_delta int     NOT NULL DEFAULT 0,
  saves                       int     NOT NULL DEFAULT 0,
  final_length                int     NOT NULL DEFAULT 0,
  start_length                int     NOT NULL DEFAULT 0,
  reconstruction_tainted      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (submission_id, file_path)
);
