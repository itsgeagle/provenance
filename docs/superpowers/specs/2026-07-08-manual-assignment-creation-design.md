# Manual assignment creation via the analyzer Assignments page

**Date:** 2026-07-08
**Status:** Approved design
**Affects:** `packages/shared`, `packages/server`, `packages/analyzer`

## Problem

Assignments are created only implicitly during ingest: when a submission matches,
`create-submission.ts` upserts an `assignments` row (`INSERT … ON CONFLICT DO NOTHING`
on `(semester_id, assignment_id_str)`). There is no way to create an assignment row
before any submission for it has been successfully ingested.

This blocks the manual-match workflow. The Unmatched tray's **Attach modal**
(`UnmatchedView.tsx`) re-points an unmatched staged file to a student + assignment and
re-runs the pipeline — this is the "match" step. But its assignment picker
(`UnmatchedView.tsx:92-108`) is populated **only from existing `assignments` rows** and
is not free-text. So an unmatched file whose assignment was never auto-created cannot be
attached: the target assignment isn't in the dropdown.

The fix is to let staff **manually create an assignment row**. Once it exists, it appears
in the Assignments table and in the Attach dropdown, and the existing match flow works
unchanged. No changes to matching are needed.

## Non-goals

- No changes to the matching / attach flow. The Unmatched tray already handles matching.
- No re-pointing of an already-created `submissions` row (its `student_id`/`assignment_id`
  FKs remain fixed; superseding is the only existing post-ingest path).
- `sort_order` is not exposed in the create form (defaults to `0`, stays server-settable).

## Behavior

A "Create assignment" form sits above the assignments table on the Assignments page
(`/s/:courseSlug/:semesterSlug/assignments`). Fields:

- **Assignment ID** (`assignment_id_str`, required, 1–200 chars). This is the string that
  later-ingested files / attaches match against; it must equal the filename capture group
  or manifest `assignment.id`.
- **Label** (optional, 0–200 chars). Defaults to the assignment ID when left blank
  (matching the ingest upsert, which sets `label = assignment_id_str`).

On submit the row is created with `sort_order = 0`. On success the form clears and the
assignments query is invalidated so the table — and the Attach modal's dropdown — refresh.

**Duplicate ID:** if an assignment with the same `assignment_id_str` already exists in the
semester, the server returns **409** ("assignment already exists"); the form surfaces the
error inline. A manual create is an explicit act, so a clash is treated as a mistake rather
than a silent no-op.

## Pieces

### 1. Shared schema — `packages/shared/src/api-schemas.ts`

Add alongside the existing assignment schemas:

- `CreateAssignmentRequestSchema` = `{ assignment_id_str: string.min(1).max(200), label?:
  string.max(200) }`.
- `CreateAssignmentResponseSchema` = `{ assignment: AssignmentSummarySchema }`.
- Exported request/response TS types, mirroring `UpdateAssignmentRequest`/`Response`.

### 2. Server route — `packages/server/src/api/v1/routes/assignments.ts`

Add `POST /semesters/:semesterId/assignments` to `createAssignmentsRouter()`, mirroring the
existing PATCH handler in the same file:

- `rateLimit('write.misc')`
- `requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('semesterId')! }) })`
  — same guard as the PATCH (semester-scoped write), not the superadmin global guard.
- `audit('assignment.create', 'assignment', (c) => auditDetail.id)`.
- Parse body with `CreateAssignmentRequestSchema.safeParse`; on failure return
  `Errors.validation(...)` 400.
- Call the service; on success set `auditDetail` and return `{ assignment }` with **201**.
- On duplicate return **409** (see service).

### 3. Service — `packages/server/src/services/cohort/assignments.ts`

Add `createAssignment(db, { semesterId, assignmentIdStr, label })`:

- Insert into `assignments` with `label` defaulting to `assignmentIdStr` when blank and
  `sort_order = 0`.
- Use `.onConflictDoNothing({ target: [semester_id, assignment_id_str] }).returning()`; an
  empty `returning` array means the row already existed → return a discriminated error
  (`{ ok: false, reason: 'exists' }`) that the route maps to 409. (Errors are values here,
  per repo convention.)
- Return the created row shaped as an `AssignmentSummary` (submission_count / distinct_students
  = 0 for a brand-new assignment), consistent with what `listAssignments` returns.

### 4. UI — `packages/analyzer/src/api/queries.ts` + `AssignmentsView.tsx`

- `useCreateAssignment(semesterId)` hook: `POST /semesters/:semesterId/assignments`,
  `onSuccess` → `invalidateQueries(queryKeys.assignments(semesterId))`. Mirrors
  `useCreateSemester` and the existing `useUpdateAssignment`.
- "Create assignment" `<form>` above the table in `AssignmentsView`, mirroring
  `AdminSemestersView`'s create form: `useState` per field, disabled/`isPending` submit
  button, inline error on failure (409 message included), clear fields on success.

## Testing

- **Service** (`assignments.test.ts` or co-located): insert succeeds and returns the row;
  duplicate `(semester_id, assignment_id_str)` returns the `exists` error; blank label
  defaults to the ID.
- **Route** (server route test, testcontainers): 201 on create; 409 on duplicate; 400 on
  invalid body; auth rejection for a non-write caller.
- **UI** (`AssignmentsView.test.tsx`): submitting the create form calls the mutation with the
  right body and refreshes the list; duplicate error is shown inline.

## Contract / convention notes

- New endpoint follows the existing HTTP-API contract discipline: schema added to
  `packages/shared/src/api-schemas.ts`, both ends updated in one change.
- No DB schema change — the `assignments` table and its unique constraint already exist.
- No new dependencies.
