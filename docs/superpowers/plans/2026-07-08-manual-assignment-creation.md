# Manual Assignment Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let course staff manually create an assignment row from the analyzer Assignments page, so it appears in the Assignments table and the Unmatched-tray Attach dropdown and can then be matched.

**Architecture:** Add a `POST /semesters/:semesterId/assignments` endpoint mirroring the existing PATCH on that router: a shared Zod request/response schema, a `createAssignment` service that inserts into the existing `assignments` table (409 on the `(semester_id, assignment_id_str)` unique clash), and a React create form + mutation hook on `AssignmentsView`. Matching is unchanged — the existing Attach flow already re-points unmatched files once the assignment exists.

**Tech Stack:** TypeScript (strict), Zod, Hono, Drizzle ORM (Postgres), React + TanStack Query, Vitest (server route tests via testcontainers; analyzer UI tests via MSW + Testing Library).

## Global Constraints

- HTTP API shape is a contract: the request/response schema lives in `packages/shared/src/api-schemas.ts`; both server and analyzer import it. Add both ends in this change.
- No DB schema change: the `assignments` table and its `unique(semester_id, assignment_id_str)` constraint already exist. Do **not** write a migration.
- No new dependencies.
- Auth: the new write uses `requireAuth({ action: 'write', target: (c) => ({ semesterId }) })` — semester-scoped admin, identical to the existing PATCH. Do not use the superadmin global guard.
- Errors are values/exceptions per repo convention: expected conflicts throw an `ApiError` from `Errors.*`, which the error middleware converts to the §7.3 JSON body (this is how the existing `updateAssignment` throws `Errors.notFound()`).
- Every mutation route asserts an audit row in its test (repo "V20 rule").
- `label` defaults to `assignment_id_str` when blank (matches the ingest upsert in `create-submission.ts`). `sort_order` is not in the form; it defaults to `0`.
- Assignment IDs already have `.zip`-convention semantics — store the string as sent; the UI trims surrounding whitespace before sending (mirrors `AdminSemestersView` slug handling).

---

## File Structure

- `packages/shared/src/api-schemas.ts` — **modify**: add `CreateAssignmentRequestSchema`, `CreateAssignmentResponseSchema` + types (next to the existing `UpdateAssignment*` schemas at lines 231-247).
- `packages/server/src/api/v1/errors.ts` — **modify**: add `ASSIGNMENT_ID_STR_TAKEN` to the `ApiErrorCode` union (conflict section) + `assignmentIdStrTaken()` factory.
- `packages/server/src/services/cohort/assignments.ts` — **modify**: add `CreateAssignmentInput` type + `createAssignment()`.
- `packages/server/src/api/v1/routes/assignments.ts` — **modify**: add `POST /semesters/:semesterId/assignments` to `createAssignmentsRouter()`.
- `packages/server/src/api/v1/routes/assignments.test.ts` — **modify**: append a `describe('POST …')` block.
- `packages/analyzer/src/api/queries.ts` — **modify**: import `CreateAssignmentResponseSchema`; add `useCreateAssignment()`.
- `packages/analyzer/src/views/assignments/AssignmentsView.tsx` — **modify**: add a `CreateAssignmentForm` subcomponent + render it above the table.
- `packages/analyzer/src/views/assignments/AssignmentsView.test.tsx` — **modify**: append create-form tests.

---

## Task 1: Server-side create endpoint (schema + service + route)

**Files:**
- Modify: `packages/shared/src/api-schemas.ts:247` (after `UpdateAssignmentResponseSchema`)
- Modify: `packages/server/src/api/v1/errors.ts` (union near line 51; factory near line 301)
- Modify: `packages/server/src/services/cohort/assignments.ts` (append after `updateAssignment`, line 165)
- Modify: `packages/server/src/api/v1/routes/assignments.ts`
- Test: `packages/server/src/api/v1/routes/assignments.test.ts` (append)

**Interfaces:**
- Consumes: existing `assignments` Drizzle table; `AssignmentSummary` type (from `services/cohort/assignments.ts`); `Errors`, `requireAuth`, `rateLimit`, `audit`, `getDb`.
- Produces:
  - `CreateAssignmentRequestSchema` = `{ assignment_id_str: string (1..200), label?: string (0..200) }`; `CreateAssignmentResponseSchema` = `{ assignment: AssignmentSummary }`.
  - `Errors.assignmentIdStrTaken(idStr: string): ApiError` (code `ASSIGNMENT_ID_STR_TAKEN`, status 409).
  - `createAssignment(db, semesterId: string, input: { assignmentIdStr: string; label?: string }): Promise<AssignmentSummary>`.
  - `POST /semesters/:semesterId/assignments` → `201 { assignment }`, `409` on duplicate, `400` on invalid body.

- [ ] **Step 1: Add the shared request/response schema**

In `packages/shared/src/api-schemas.ts`, immediately after `UpdateAssignmentResponseSchema` (line 247), add:

```ts
// POST /semesters/:semesterId/assignments — manual assignment creation.
// label is optional; the server defaults a blank label to assignment_id_str.
export const CreateAssignmentRequestSchema = z.object({
  assignment_id_str: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
});
export type CreateAssignmentRequest = z.infer<typeof CreateAssignmentRequestSchema>;

export const CreateAssignmentResponseSchema = z.object({
  assignment: AssignmentSummarySchema,
});
export type CreateAssignmentResponse = z.infer<typeof CreateAssignmentResponseSchema>;
```

- [ ] **Step 2: Add the 409 error code + factory**

In `packages/server/src/api/v1/errors.ts`, add `'ASSIGNMENT_ID_STR_TAKEN'` to the `ApiErrorCode` union in the `// Conflict (409)` group (after `'SEMESTER_SLUG_TAKEN'`, line 44):

```ts
  | 'COURSE_SLUG_TAKEN'
  | 'SEMESTER_SLUG_TAKEN'
  | 'ASSIGNMENT_ID_STR_TAKEN'
```

Then add the factory to the `Errors` object, right after `semesterSlugTaken` (ends line 301):

```ts
  assignmentIdStrTaken(idStr: string): ApiError {
    return new ApiError(
      'ASSIGNMENT_ID_STR_TAKEN',
      409,
      `An assignment with id '${idStr}' already exists in this semester`,
      { assignment_id_str: idStr },
    );
  },
```

- [ ] **Step 3: Write the failing route tests**

Append to `packages/server/src/api/v1/routes/assignments.test.ts` (before the final closing brace of the file, after the existing PATCH `describe` block). The helpers (`insertUser`, `insertSession`, `insertCourse`, `insertSemester`, `insertMembership`) already exist at the top of the file.

```ts
describe('POST /semesters/:semesterId/assignments', () => {
  it('happy path: creates assignment, returns summary, audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'hw1', label: 'Homework 1' }),
          }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          assignment: { id: string; assignment_id_str: string; label: string; submission_count: number };
        };
        expect(body.assignment.assignment_id_str).toBe('hw1');
        expect(body.assignment.label).toBe('Homework 1');
        expect(body.assignment.submission_count).toBe(0);

        const [row] = await db
          .select()
          .from(assignments)
          .where(eq(assignments.id, body.assignment.id));
        expect(row!.assignment_id_str).toBe('hw1');

        const auditRow = await waitForAuditRow(db, 'assignment.create', body.assignment.id);
        expect(auditRow).toBeDefined();
        expect(auditRow!.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('defaults a blank label to assignment_id_str', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'lab3' }),
          }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { assignment: { label: string } };
        expect(body.assignment.label).toBe('lab3');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 when assignment_id_str already exists', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertAssignment(db, semester.id, { assignment_id_str: 'hw1' });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'hw1' }),
          }),
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ASSIGNMENT_ID_STR_TAKEN');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 400 VALIDATION when assignment_id_str is missing', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ label: 'no id' }),
          }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ assignment_id_str: 'hw1' }),
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 403 for grader (write requires admin)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const grader = await insertUser(db);
        const sessionId = await insertSession(db, grader.id);
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, grader.id, semester.id, 'grader', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'hw1' }),
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test --workspace=packages/server -- assignments.test.ts`
Expected: FAIL — the POST route 404s (no such route), so status assertions (`201`/`409`) fail. (Docker must be running for testcontainers.)

- [ ] **Step 5: Implement the `createAssignment` service**

Append to `packages/server/src/services/cohort/assignments.ts` after `updateAssignment` (line 165):

```ts
// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/assignments — manual assignment creation.
//
// Inserts a new assignment row. A brand-new assignment has no submissions, so
// all aggregate stats are zero. A blank label defaults to assignment_id_str
// (matches the ingest upsert in create-submission.ts). Relies on the
// (semester_id, assignment_id_str) unique constraint: an insert that hits it
// is DO NOTHING → empty returning → 409.
// ---------------------------------------------------------------------------

export type CreateAssignmentInput = {
  assignmentIdStr: string;
  label?: string;
};

export async function createAssignment(
  db: DrizzleDb,
  semesterId: string,
  input: CreateAssignmentInput,
): Promise<AssignmentSummary> {
  const label =
    input.label !== undefined && input.label.trim() !== '' ? input.label : input.assignmentIdStr;

  const inserted = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: input.assignmentIdStr,
      label,
      sort_order: 0,
    })
    .onConflictDoNothing({
      target: [assignments.semester_id, assignments.assignment_id_str],
    })
    .returning({
      id: assignments.id,
      semester_id: assignments.semester_id,
      assignment_id_str: assignments.assignment_id_str,
      label: assignments.label,
      sort_order: assignments.sort_order,
    });

  if (inserted.length === 0) throw Errors.assignmentIdStrTaken(input.assignmentIdStr);
  const row = inserted[0]!;

  return {
    id: row.id,
    semester_id: row.semester_id,
    assignment_id_str: row.assignment_id_str,
    label: row.label,
    sort_order: row.sort_order,
    submission_count: 0,
    distinct_students: 0,
    mean_score: 0,
    median_score: 0,
    p95_score: 0,
    fail_count: 0,
    warn_count: 0,
  };
}
```

- [ ] **Step 6: Implement the POST route**

In `packages/server/src/api/v1/routes/assignments.ts`, extend the import from `@provenance/shared/api-schemas` (line 28-31) to include the create schemas:

```ts
import {
  UpdateAssignmentRequestSchema,
  UpdateAssignmentResponseSchema,
  CreateAssignmentRequestSchema,
  CreateAssignmentResponseSchema,
} from '@provenance/shared/api-schemas';
```

Then add the POST handler inside `createAssignmentsRouter()`, before `return router;` (line 78):

```ts
  router.post(
    '/semesters/:semesterId/assignments',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('assignment.create', 'assignment', (c) => (c.var.auditDetail?.id as string) ?? 'unknown'),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parsed = CreateAssignmentRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(Errors.validation(parsed.error.issues).toBody(), 400);
      }

      const db = getDb();
      const created = await assignmentService.createAssignment(db, semesterId, {
        assignmentIdStr: parsed.data.assignment_id_str,
        label: parsed.data.label,
      });

      // Feed the audit middleware the created entity's UUID.
      c.set('auditDetail', { id: created.id });

      const response = CreateAssignmentResponseSchema.parse({ assignment: created });
      return c.json(response, 201);
    },
  );
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test --workspace=packages/server -- assignments.test.ts`
Expected: PASS — all POST tests (201 happy path, blank-label default, 409, 400, 401, 403) and the pre-existing PATCH tests green.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors (confirms shared schema export + route/service types line up).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/api-schemas.ts packages/server/src/api/v1/errors.ts packages/server/src/services/cohort/assignments.ts packages/server/src/api/v1/routes/assignments.ts packages/server/src/api/v1/routes/assignments.test.ts
git commit --no-gpg-sign -m "feat(server): POST /semesters/:id/assignments to create an assignment manually"
```

---

## Task 2: Analyzer create-assignment UI

**Files:**
- Modify: `packages/analyzer/src/api/queries.ts` (import at line 21-26; add hook after `useUpdateAssignment`, line 804)
- Modify: `packages/analyzer/src/views/assignments/AssignmentsView.tsx`
- Test: `packages/analyzer/src/views/assignments/AssignmentsView.test.tsx` (append)

**Interfaces:**
- Consumes: `useCreateAssignment(semesterId)` → `useMutation` whose `mutationFn` takes `{ assignmentIdStr: string; label?: string }` and POSTs to `/semesters/:semesterId/assignments`; invalidates `queryKeys.assignments(semesterId)` on success. `CreateAssignmentResponseSchema`, `apiFetch`, `ApiError`.
- Produces: a `CreateAssignmentForm` rendered above the assignments table. Test hooks: `create-assignment-id-input`, `create-assignment-label-input`, `create-assignment-submit`, `create-assignment-error`.

- [ ] **Step 1: Write the failing UI tests**

Append to `packages/analyzer/src/views/assignments/AssignmentsView.test.tsx` inside the existing `describe('AssignmentsView', …)` block (before its closing `});`, line 161). These reuse the imports already at the top of the file (`http`, `HttpResponse`, `mswServer`, `assignmentsHandler`, `DEFAULT_SEMESTER_ID`, `fireEvent`, `waitFor`, `screen`).

```ts
  it('create form POSTs and refreshes the list with the new assignment', async () => {
    let observedBody: { assignment_id_str?: string; label?: string } | null = null;
    const items: Array<Record<string, unknown>> = [];

    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`, () =>
        HttpResponse.json({ items }),
      ),
      http.post(
        `/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`,
        async ({ request }) => {
          observedBody = (await request.json()) as { assignment_id_str?: string; label?: string };
          const created = {
            id: '30000000-0000-0000-0000-000000000009',
            semester_id: DEFAULT_SEMESTER_ID,
            assignment_id_str: observedBody.assignment_id_str,
            label: observedBody.label || observedBody.assignment_id_str,
            sort_order: 0,
            submission_count: 0,
            distinct_students: 0,
            mean_score: 0,
            median_score: 0,
            p95_score: 0,
            fail_count: 0,
            warn_count: 0,
          };
          items.push(created);
          return HttpResponse.json({ assignment: created }, { status: 201 });
        },
      ),
    );

    renderAssignmentsView();

    await waitFor(() => expect(screen.getByTestId('create-assignment-submit')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.change(screen.getByTestId('create-assignment-id-input'), {
      target: { value: '  proj2  ' },
    });
    fireEvent.change(screen.getByTestId('create-assignment-label-input'), {
      target: { value: 'Project 2' },
    });
    fireEvent.click(screen.getByTestId('create-assignment-submit'));

    await waitFor(() => expect(observedBody).not.toBeNull(), { timeout: 3000 });
    expect(observedBody!.assignment_id_str).toBe('proj2'); // trimmed
    expect(observedBody!.label).toBe('Project 2');

    await waitFor(() => expect(screen.getByText('Project 2')).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('shows an inline error when create returns 409', async () => {
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.post(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'ASSIGNMENT_ID_STR_TAKEN',
              message: "An assignment with id 'hw1' already exists in this semester",
            },
          },
          { status: 409 },
        ),
      ),
    );

    renderAssignmentsView();

    await waitFor(() => expect(screen.getByTestId('create-assignment-submit')).toBeInTheDocument(), {
      timeout: 3000,
    });

    fireEvent.change(screen.getByTestId('create-assignment-id-input'), {
      target: { value: 'hw1' },
    });
    fireEvent.click(screen.getByTestId('create-assignment-submit'));

    await waitFor(() => expect(screen.getByTestId('create-assignment-error')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByTestId('create-assignment-error').textContent).toMatch(/already exists/);
  });
```

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- AssignmentsView.test.tsx`
Expected: FAIL — `getByTestId('create-assignment-submit')` throws (no create form rendered yet).

- [ ] **Step 3: Add the `useCreateAssignment` hook**

In `packages/analyzer/src/api/queries.ts`, add `CreateAssignmentResponseSchema` to the schema import block (after `UpdateAssignmentResponseSchema`, line 26):

```ts
  AssignmentListResponseSchema,
  UpdateAssignmentResponseSchema,
  CreateAssignmentResponseSchema,
```

Then add the hook immediately after `useUpdateAssignment` (line 804):

```ts
/** Mutation: POST /semesters/:semesterId/assignments */
export function useCreateAssignment(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assignmentIdStr, label }: { assignmentIdStr: string; label?: string }) => {
      const body: { assignment_id_str: string; label?: string } = {
        assignment_id_str: assignmentIdStr,
      };
      if (label !== undefined && label !== '') body.label = label;
      return apiFetch(
        `/semesters/${semesterId}/assignments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        CreateAssignmentResponseSchema,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments(semesterId) });
    },
  });
}
```

- [ ] **Step 4: Add the create form to `AssignmentsView`**

In `packages/analyzer/src/views/assignments/AssignmentsView.tsx`, extend the hook import (line 11) to include `useCreateAssignment`:

```ts
import { useAssignments, useUpdateAssignment, useCreateAssignment } from '../../api/queries.js';
```

Add this `CreateAssignmentForm` component after the `EditRow` component (after line 72, before `export function AssignmentsView`):

```tsx
function CreateAssignmentForm({ semesterId }: { semesterId: string }) {
  const [assignmentIdStr, setAssignmentIdStr] = useState('');
  const [label, setLabel] = useState('');
  const { mutate: createAssignment, isPending, error } = useCreateAssignment(semesterId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const id = assignmentIdStr.trim();
    if (id === '') return;
    createAssignment(
      { assignmentIdStr: id, label: label.trim() },
      {
        onSuccess: () => {
          setAssignmentIdStr('');
          setLabel('');
        },
      },
    );
  }

  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Create assignment</h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-600">
          Assignment ID
          <input
            type="text"
            value={assignmentIdStr}
            onChange={(e) => setAssignmentIdStr(e.target.value)}
            placeholder="hw1"
            className="mt-0.5 block w-40 rounded border border-gray-300 px-2 py-1.5 font-mono text-xs"
            data-testid="create-assignment-id-input"
          />
        </label>
        <label className="text-xs text-gray-600">
          Label (optional)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Homework 1"
            className="mt-0.5 block w-56 rounded border border-gray-300 px-2 py-1.5 text-sm"
            data-testid="create-assignment-label-input"
          />
        </label>
        <button
          type="submit"
          disabled={isPending || assignmentIdStr.trim() === ''}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
          data-testid="create-assignment-submit"
        >
          {isPending ? 'Creating…' : 'Create'}
        </button>
        {errorMsg && (
          <span className="text-xs text-red-600" data-testid="create-assignment-error">
            {errorMsg}
          </span>
        )}
      </form>
      <p className="mt-2 text-[11px] text-gray-400">
        The ID must match the filename convention / manifest id that submissions will use, so
        later-ingested or attached files link to this assignment.
      </p>
    </div>
  );
}
```

Then render it inside `AssignmentsView`'s returned JSX, directly after the intro `<p>` (line 83) and before the `{isLoading && …}` block, guarded on `semesterId`:

```tsx
      <p className="mb-4 text-xs text-gray-500">Click a label to edit it inline.</p>

      {semesterId && <CreateAssignmentForm semesterId={semesterId} />}

      {isLoading && (
```

- [ ] **Step 5: Run the UI tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- AssignmentsView.test.tsx`
Expected: PASS — both new tests (POST + refresh, 409 inline error) and the pre-existing render/edit tests green.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/analyzer/src/api/queries.ts packages/analyzer/src/views/assignments/AssignmentsView.tsx packages/analyzer/src/views/assignments/AssignmentsView.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): create-assignment form on the Assignments page"
```

---

## Self-Review

**Spec coverage:**
- Shared `CreateAssignmentRequest/ResponseSchema` → Task 1 Step 1. ✓
- `POST /semesters/:semesterId/assignments`, write/semester auth, `assignment.create` audit → Task 1 Steps 2, 6. ✓
- `createAssignment` service, unique-conflict → 409, blank label defaults to id → Task 1 Steps 2, 5. ✓
- `useCreateAssignment` hook invalidating `queryKeys.assignments` → Task 2 Step 3. ✓
- Create form on `AssignmentsView` mirroring `AdminSemestersView` → Task 2 Step 4. ✓
- Tests: service+route (201/409/400/auth/audit) → Task 1 Step 3; UI (submit + inline error) → Task 2 Step 1. ✓
- Non-goals honored: no matching changes, no DB migration, `sort_order` not in form (defaults 0). ✓

**Note on a spec refinement:** the spec floated a discriminated `{ ok:false, reason:'exists' }` return; this plan instead throws `Errors.assignmentIdStrTaken()` (an `ApiError` → 409 via the error middleware), matching the existing `Errors.courseSlugTaken`/`semesterSlugTaken` conflict pattern and how `updateAssignment` already throws `Errors.notFound()`. Same 409 behavior, more consistent with the codebase.

**Placeholder scan:** none — every step has full code and exact commands.

**Type consistency:** `createAssignment(db, semesterId, { assignmentIdStr, label })` returns `AssignmentSummary`; the route maps `parsed.data.assignment_id_str` → `assignmentIdStr`; the hook's `mutationFn` arg `{ assignmentIdStr, label }` matches the form's `createAssignment({ assignmentIdStr: id, label })` call; response validated with `CreateAssignmentResponseSchema`. Test hook ids (`create-assignment-id-input`/`-label-input`/`-submit`/`-error`) match between Task 2 Step 1 and Step 4.
