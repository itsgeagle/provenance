-- Migration 0019: drop the events table.
--
-- Events are no longer materialized into Postgres. The `.slog` provenance logs
-- inside each submission's stored bundle blob are the source of the event
-- stream; server read paths (events API, replay/reconstruction, per-submission
-- recompute, cross-flags, submission summary) re-parse the bundle on demand via
-- loadSubmissionIndex instead of querying this table. Removing it eliminates the
-- dominant Postgres storage + write-amplification cost (one row per event, never
-- purged).
--
-- Nothing references the events table by FK (it referenced submissions, not the
-- reverse), so a plain DROP is sufficient; its indexes drop with it. Derived
-- data that stores globalIdx values (flags.supporting_seqs,
-- cross_flag_participants.supporting_seqs) is unaffected — those integers are
-- recomputed identically from the re-parsed bundle.

DROP TABLE IF EXISTS events;
