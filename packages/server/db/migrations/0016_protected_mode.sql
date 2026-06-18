-- Migration 0016: protected mode — users.protected flag + roster_entries.protected_index
--
-- Adds:
--   users.protected              boolean NOT NULL DEFAULT false
--     A superadmin-only flag. When true, all student identity is masked in
--     API responses (name → "Student N", sid → "S<N>", email/extras → null,
--     filenames → placeholder). The flag cannot be toggled by the flagged user
--     themselves (self-guard in the toggle endpoint).
--
--   roster_entries.protected_index  integer (nullable)
--     A per-semester, randomized, name-independent ordinal used to produce
--     stable "Student N" labels. NULL until the backfill runs or the row is
--     inserted via roster import (which calls assignMissingProtectedIndices).
--     A partial unique index (semester_id, protected_index) enforces uniqueness
--     when the value is not null; Postgres treats multiple NULLs as distinct,
--     so pre-backfill rows do not violate the constraint.

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "protected" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "roster_entries" ADD COLUMN "protected_index" integer;
--> statement-breakpoint
CREATE UNIQUE INDEX "roster_entries_semester_protected_index_key" ON "roster_entries" ("semester_id","protected_index");
--> statement-breakpoint
-- Backfill protected_index: per-semester, randomized order, name-independent.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY semester_id ORDER BY random()) AS rn
  FROM roster_entries
  WHERE protected_index IS NULL
)
UPDATE roster_entries r
SET protected_index = n.rn
FROM numbered n
WHERE r.id = n.id;
