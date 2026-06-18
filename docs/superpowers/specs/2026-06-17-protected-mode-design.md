# Protected Mode — Design

**Date:** 2026-06-17
**Status:** Approved design, pending implementation plan
**Branch:** `feat/protected-mode`

## Problem

While the system is live, a privileged operator (the developer/admin) may be
**legally barred from viewing students' protected data** — names, student IDs
(SIDs), email. They still need full operational access to everything else
(flags, scores, timelines, replay, cross-flags, heuristics tuning, ingest).

We need a **Protected mode**: an account flag that lets the holder use the whole
system normally, except the server never reveals real student identity. Instead,
each student appears as a stable, name-independent placeholder (`Student 42`).

## Decisions (locked)

These were settled during brainstorming and are not open for re-litigation
during implementation:

1. **Hard, server-side boundary.** Real `display_name` / `sid` / `email` must
   never leave the server for a protected principal — not over the wire, not in
   DevTools, not in exports, not in pagination cursors. Masking happens in the
   service layer *before* serialization. The protected user has **no reveal
   path**.
2. **Controlling-party lock via "can't change your own flag."** Reuse the
   existing superadmin role. A superadmin may set/clear `protected` on any
   account **except their own**. Lifting your own protection therefore requires a
   *second* superadmin. No new role tier is introduced.
3. **Stable, per-semester, name-independent placeholder.** Each student gets a
   `protected_index` stored on their roster row, assigned in **randomized order**
   (not derived from name/SID/insertion order, so the number leaks nothing).
   Same student → same `Student N` in every view, every session, the whole
   semester.
4. **Mask scope:** `display_name`, `sid`, `email`, roster `extras` (stripped),
   and identity-bearing ingest filenames. Exports inherit masking automatically
   because they are built from already-masked data.
5. **No API contract change.** Masked values keep their existing types
   (`sid`/`display_name` stay non-empty strings; `email` is already nullable).
   `packages/shared` schemas are unchanged; no format/version bump.

## Threat model & re-identification oracles

A naive "swap the displayed string at the very end" approach is insufficient.
Reading the cohort/students service surfaced two oracles that must be closed in
protected mode:

- **Search-by-name (`filters.q`).** `services/cohort/students.ts` and the cohort
  list run `ILIKE` against `display_name`/`sid`. If left active, a protected
  user could type a real name and observe *which* `Student N` matches — a lookup
  oracle. In protected mode, `q` matching against name/SID is disabled (the
  search either no-ops or is restricted to placeholder matching).
- **Sort-by-name (`student_asc`).** Ordering rows by hidden real name leaks
  alphabetical ordering (e.g. last-name initials), and the pagination **cursor
  embeds the real `display_name`** (`students.ts` `display_name` cursor kind),
  which would ship real names to the client inside the cursor token. In
  protected mode, name-sort is replaced by `protected_index` sort and the cursor
  carries the index, never a name.

Consequence: masking is a **request-level concern** (search + sort + cursor +
final projection), not a single output substitution.

Additional boundary closures:

- **View-as cannot bypass.** `protected` is derived onto the `Principal` from the
  **real** authenticated user row at auth time. A protected superadmin using the
  existing view-as impersonation still gets masked output.
- **Self-toggle rejected server-side.** Enforced in the admin user-update path,
  not just hidden in the UI.

## Data model

Two additive schema changes (`packages/server/src/db/schema.ts`):

- `users.protected boolean NOT NULL DEFAULT false` — the lock flag.
- `roster_entries.protected_index integer` — per-semester stable index, unique
  within a semester. Assigned in randomized order at roster import.

Migrations:

- Drizzle migration adding both columns.
- **Backfill**: assign `protected_index` to all existing roster rows, randomized
  order, unique per semester. New roster imports assign the next index at
  import/match time.

`protected_index` is the **only** new identifier exposed to protected users.
Student UUIDs (`roster_entries.id`, submission ids) remain visible — they are
random, non-PII, and required for navigation/drill-in URLs.

## Masking chokepoint

One pure module, `packages/server/src/services/protect.ts`:

```
type ProtectContext = { protected: boolean };

// Returns the student object to embed in any response.
projectStudent(entry: { id; sid; display_name; email; extras; protected_index },
               ctx: ProtectContext): { id; sid; display_name; email?; extras? }

// Returns a display-safe filename for ingest listings.
protectFilename(name: string, ctx: ProtectContext,
                opts: { index?: number; assignment?: string; unmatchedSeq?: number }): string
```

When `ctx.protected` is true:

| Field            | Masked value                          |
| ---------------- | ------------------------------------- |
| `display_name`   | `Student {protected_index}`           |
| `sid`            | `S{protected_index}`                  |
| `email`          | `null`                                |
| `extras`         | omitted (`undefined`)                 |
| matched filename | `Student {index} — {assignment}`      |
| unmatched filename | `(unmatched file #{k})`             |

`ctx.protected` is read from the principal (derived from the real user row).

### Service builders that must route through `projectStudent`

- `services/cohort/list.ts` (SubmissionRow)
- `services/cohort/students.ts` (StudentRow) — **plus** `q`/sort/cursor handling
- `services/submissions/summary.ts` (SubmissionSummary)
- cross-flags participant builder
- roster listing
- ingest matched/unmatched file listings (via `protectFilename`)

If a builder constructs a student object without going through `projectStudent`,
that is a leak. Tests assert the negative (no real PII for a protected
principal) across every endpoint.

## Authorization & control

- Derive `protected` onto `Principal` at auth time (`api/middleware/auth-session.ts`)
  from `users.protected` of the **real** user (independent of view-as).
- Admin user-update path (the `/admin/users` mutation): a superadmin may set or
  clear `protected` on any user **except themselves**. Self-change → rejected
  (`INSUFFICIENT_ROLE` or a dedicated error code). Write an `audit_log` entry for
  every protected-flag change (who, target, old→new, when).
- `authorize()` itself is unchanged; the masking decision is orthogonal to the
  read/write/admin decision (a protected user keeps all their normal
  permissions; only the *content* of student identity is masked).

## API contract

No change to `packages/shared/src/api-schemas.ts`. Masked responses validate
against the existing schemas: `sid`/`display_name` remain strings, `email` is
already nullable, `extras` is already optional. No version bump.

## UI (analyzer)

1. **Protected-mode banner.** Non-dismissable indicator in the analyzer shell
   ("🔒 Protected mode — student identities are masked"), shown on every view so
   the operator is never confused by placeholders. Driven by a field on the
   `/me` response (or equivalent session state) reflecting the real user's
   `protected` flag.
2. **Superadmin toggle in `/admin/users`.** Per-user ON/OFF control to set/clear
   `protected`. Disabled on your own row (mirrors the server-side rule). Surfaces
   the server error if a self-toggle is somehow attempted.

No other UI changes. Components that render student identity
(`CohortTable`, `StudentRollupTable`, `Overview`, `CrossFlagDetailView`,
`IngestJobView`, roster view, export) need **no changes** — they render whatever
the server sends, which is already masked.

## Testing

- **Unit**: `protect.test.ts` — `projectStudent` and `protectFilename` for both
  context states, all field substitutions, edge cases (missing index, empty
  extras, unmatched files).
- **Service/integration** (testcontainers): for a protected principal, assert no
  real `display_name`/`sid`/`email` and no real name inside any pagination
  cursor across cohort list, students rollup, submission summary, cross-flags,
  roster, ingest listings, and the export CSV. Assert the same endpoints return
  real PII for a non-protected principal (mask is gated correctly).
- **Oracle tests**: protected `q` name-search does not reveal which `Student N`
  matches; protected `student_asc` orders by `protected_index`, not name.
- **Authz tests**: self-toggle of `protected` is rejected; a second superadmin
  can toggle another's flag; flag change writes an audit entry.
- **View-as test**: a protected superadmin in view-as still gets masked output.
- **Index stability test**: a given student maps to the same `protected_index`
  across requests/sessions.

## Out of scope (first cut)

- Masking student **code content** and audit-log internal payloads. (Identity in
  code comments is a separate, harder problem; flagged, not solved here.)
- The deferred markdown findings export (`findings-markdown.ts` stub).
- A configurable per-field `extras` allowlist (we strip wholesale instead).
- Any new role tier above superadmin.

## Affected files (anticipated)

- `packages/server/src/db/schema.ts` — `users.protected`, `roster_entries.protected_index`
- `packages/server/src/db/migrations/*` — add columns + randomized backfill
- `packages/server/src/services/protect.ts` — **new** masking module (+ test)
- `packages/server/src/services/cohort/list.ts`, `cohort/students.ts`
- `packages/server/src/services/submissions/summary.ts`
- cross-flags / roster / ingest service builders
- `packages/server/src/api/middleware/auth-session.ts` — derive `protected` on Principal
- `packages/server/src/api/v1/routes/admin.ts` — set/clear flag, reject self-change, audit
- `packages/server/src/api/v1/routes/me.ts` — expose `protected` for the banner
- `packages/server/src/services/.../roster import` — assign `protected_index`
- `packages/analyzer/src/...` — shell banner + `/admin/users` toggle control
