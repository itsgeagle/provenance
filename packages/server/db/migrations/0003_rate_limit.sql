-- Migration: 0003_rate_limit
-- Creates the rate_limit_buckets table for Postgres-backed token-bucket
-- rate limiting (PRD §7.6).
--
-- This table is used when RATE_LIMIT_BACKEND=postgres (i.e. in production
-- with multiple API processes). In-memory (single-process) mode does not
-- use this table.

CREATE TABLE rate_limit_buckets (
  principal_id    text NOT NULL,             -- "user:<uuid>" | "token:<uuid>" | "anon:<ip>"
  route_class     text NOT NULL,             -- see RouteClass in rate-limit.ts
  tokens          double precision NOT NULL, -- current token count (fractional ok)
  last_refill_at  timestamptz NOT NULL,
  PRIMARY KEY (principal_id, route_class)
);
