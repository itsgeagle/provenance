# Protected Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Update `.notes/progress.md` after each phase.

**Goal:** Add a server-enforced "Protected mode" account flag that masks all student identity (name, SID, email, roster extras, identity-bearing filenames) behind stable, name-independent `Student N` placeholders, lockable only by a *different* superadmin.

**Architecture:** A `users.protected` boolean derives onto the request `Principal` from the real user row. A pure masking module (`services/protect.ts`) substitutes identity values; service builders that emit student objects call it. A per-semester `roster_entries.protected_index` (randomized, name-independent) supplies stable labels. List/aggregate services additionally close re-identification oracles (name search, name sort, cursor contents) in protected mode. UI adds a banner + a superadmin toggle.

**Tech Stack:** TypeScript (strict), Hono, Drizzle ORM (Postgres), Zod (shared contracts), Vitest + testcontainers (server), React/Vite/TanStack Query (analyzer).

**Spec:** `docs/superpowers/specs/2026-06-17-protected-mode-design.md`

**Conventions:** `git commit --no-gpg-sign`, conventional-commit prefixes, **no Co-Authored-By trailer**. Read a file before editing. Run `npm run typecheck` + `npm run lint` + relevant tests before marking a phase done. All commands run from the worktree root `/Users/aaryanmehta/projects/provenance/.claude/worktrees/protected-mode`. Server tests need Docker running (testcontainers).

**What is NOT masked (explicit):** staff emails on `/me` and `/admin/users` (those are admins/graders, not students); student *code content*; file paths inside a submission (`files[].path`). These are out of scope per the spec.

---

## Phase 0: Schema + migration + index assignment

**Files:**
- Modify: `packages/server/src/db/schema.ts` (users, roster_entries)
- Create: `packages/server/db/migrations/0015_protected_mode.sql`
- Modify: `packages/server/db/migrations/meta/_journal.json` (via `db:generate`)
- Create: `packages/server/src/services/protected-index.ts`
- Test: `packages/server/src/services/protected-index.test.ts`

- [ ] **Step 1: Add the schema columns**

In `packages/server/src/db/schema.ts`, add `protected` to the `users` table (after `is_superadmin`, line 51):

```ts
    is_superadmin: boolean('is_superadmin').notNull().default(false),
    protected: boolean('protected').notNull().default(false),
```

Add `protected_index` to `roster_entries` (after `extras`, line 259) and a per-semester unique index. The column is nullable (assigned post-insert):

```ts
    extras: jsonb('extras')
      .notNull()
      .default(sql`'{}'`),
    protected_index: integer('protected_index'),
```

And add to the table's index/constraint array (the `(t) => [...]` block at lines 267-270):

```ts
  (t) => [
    unique('roster_entries_semester_sid_key').on(t.semester_id, t.sid),
    index('roster_entries_semester_id_idx').on(t.semester_id),
    unique('roster_entries_semester_protected_index_key').on(t.semester_id, t.protected_index),
  ],
```

Ensure `integer` is imported from `drizzle-orm/pg-core` at the top of the file (check the existing import list; add `integer` if missing).

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate --workspace=packages/server`
Expected: a new file `packages/server/db/migrations/0015_*.sql` is created and `meta/_journal.json` is updated. The generated SQL should `ALTER TABLE "users" ADD COLUMN "protected" boolean ...` and `ALTER TABLE "roster_entries" ADD COLUMN "protected_index" integer` plus the unique index.

- [ ] **Step 3: Append the randomized backfill to the generated migration**

Open the generated `0015_*.sql` and append this data backfill (assigns 1..N per semester in random order to existing rows). A Postgres unique index treats multiple NULLs as distinct, so the constraint does not block the pre-backfill state:

```sql
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
```

- [ ] **Step 4: Write the failing test for the index-assignment helper**

Create `packages/server/src/services/protected-index.test.ts`. Mirror the harness in `packages/server/src/services/reconstruction.test.ts` (uses `withTestDb` from `../../test/helpers/db.js` — verify the exact relative path against that file). Seed a semester + roster rows with NULL `protected_index`, then assert the helper fills them uniquely and within 1..N:

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db.js';
import { roster_entries, semesters, courses } from '../db/schema.js';
import { assignMissingProtectedIndices } from './protected-index.js';

async function seedSemester(db: any): Promise<string> {
  const [course] = await db.insert(courses).values({ slug: `c-${crypto.randomUUID().slice(0, 8)}`, title: 'C' }).returning();
  const [sem] = await db.insert(semesters).values({ course_id: course!.id, slug: `s-${crypto.randomUUID().slice(0, 8)}`, title: 'S' }).returning();
  return sem!.id;
}

describe('assignMissingProtectedIndices', () => {
  it('assigns unique 1..N indices to rows with NULL protected_index', async () => {
    await withTestDb(async (db) => {
      const semId = await seedSemester(db);
      for (let i = 0; i < 5; i++) {
        await db.insert(roster_entries).values({ semester_id: semId, sid: `s${i}`, display_name: `Name ${i}` });
      }
      await assignMissingProtectedIndices(db, semId);
      const rows = await db.select({ pi: roster_entries.protected_index }).from(roster_entries).where(sql`${roster_entries.semester_id} = ${semId}`);
      const indices = rows.map((r: any) => r.pi).sort((a: number, b: number) => a - b);
      expect(indices).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('continues numbering from the existing max for newly-added NULL rows', async () => {
    await withTestDb(async (db) => {
      const semId = await seedSemester(db);
      await db.insert(roster_entries).values({ semester_id: semId, sid: 'a', display_name: 'A', protected_index: 1 });
      await db.insert(roster_entries).values({ semester_id: semId, sid: 'b', display_name: 'B' });
      await assignMissingProtectedIndices(db, semId);
      const rows = await db.select({ pi: roster_entries.protected_index }).from(roster_entries).where(sql`${roster_entries.semester_id} = ${semId}`);
      const indices = rows.map((r: any) => r.pi).sort((a: number, b: number) => a - b);
      expect(indices).toEqual([1, 2]);
    });
  });
});
```

Run: `npx vitest run packages/server/src/services/protected-index.test.ts`
Expected: FAIL ("assignMissingProtectedIndices is not a function" / module not found).

- [ ] **Step 5: Implement the helper**

Create `packages/server/src/services/protected-index.ts`:

```ts
/**
 * Assigns roster_entries.protected_index to any rows in a semester that lack one.
 *
 * Indices are per-semester, name-independent (randomized order), and continue
 * from the current max so previously-assigned students keep their label. Used
 * by the 0015 migration backfill and by roster import (commitRoster).
 */
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../db/client.js';

export async function assignMissingProtectedIndices(
  db: DrizzleDb,
  semesterId: string,
): Promise<void> {
  await db.execute(sql`
    WITH base AS (
      SELECT COALESCE(MAX(protected_index), 0) AS max_idx
      FROM roster_entries
      WHERE semester_id = ${semesterId}
    ),
    numbered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY random()) AS rn
      FROM roster_entries
      WHERE semester_id = ${semesterId} AND protected_index IS NULL
    )
    UPDATE roster_entries r
    SET protected_index = base.max_idx + numbered.rn
    FROM numbered, base
    WHERE r.id = numbered.id
  `);
}
```

Run: `npx vitest run packages/server/src/services/protected-index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/server/src/db/schema.ts packages/server/db/migrations/ packages/server/src/services/protected-index.ts packages/server/src/services/protected-index.test.ts
git commit --no-gpg-sign -m "feat(server): add protected flag, protected_index column + assignment helper"
```

---

## Phase 1: Masking module

**Files:**
- Create: `packages/server/src/services/protect.ts`
- Test: `packages/server/src/services/protect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/protect.test.ts` (pure unit test, no DB):

```ts
import { describe, it, expect } from 'vitest';
import {
  projectStudent,
  maskEmail,
  maskExtras,
  maskFilename,
  protectedLabel,
  protectedSid,
} from './protect.js';

const ID = '11111111-2222-3333-4444-555555555555';

describe('protectedLabel / protectedSid', () => {
  it('uses the index when present', () => {
    expect(protectedLabel(42, ID)).toBe('Student 42');
    expect(protectedSid(42, ID)).toBe('S42');
  });
  it('falls back to a name-independent UUID-derived label when index is null', () => {
    expect(protectedLabel(null, ID)).toBe('Student 111111');
    expect(protectedSid(null, ID)).toBe('S-111111');
  });
});

describe('projectStudent', () => {
  const raw = { id: ID, sid: 'abc123', display_name: 'Alice Zhao', protected_index: 7 };
  it('passes identity through when not protected', () => {
    expect(projectStudent(raw, false)).toEqual({ id: ID, sid: 'abc123', display_name: 'Alice Zhao' });
  });
  it('masks identity when protected', () => {
    expect(projectStudent(raw, true)).toEqual({ id: ID, sid: 'S7', display_name: 'Student 7' });
  });
});

describe('maskEmail / maskExtras / maskFilename', () => {
  it('nulls email and extras when protected', () => {
    expect(maskEmail('a@b.com', true)).toBeNull();
    expect(maskEmail('a@b.com', false)).toBe('a@b.com');
    expect(maskExtras({ section: '1' }, true)).toBeNull();
    expect(maskExtras({ section: '1' }, false)).toEqual({ section: '1' });
  });
  it('replaces a filename with the supplied label when protected', () => {
    expect(maskFilename('chan_alice_lab03.zip', true, 'Student 7 — lab03')).toBe('Student 7 — lab03');
    expect(maskFilename('chan_alice_lab03.zip', false, 'Student 7 — lab03')).toBe('chan_alice_lab03.zip');
  });
});
```

Run: `npx vitest run packages/server/src/services/protect.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement the module**

Create `packages/server/src/services/protect.ts`:

```ts
/**
 * Protected-mode masking helpers (pure).
 *
 * When a request's principal is protected, student identity must never leave
 * the server. These helpers substitute stable, name-independent placeholders.
 * The label is derived from roster_entries.protected_index; if that is somehow
 * null, it falls back to a short slice of the (random, non-PII) UUID so masking
 * can never degrade to real PII.
 *
 * Spec: docs/superpowers/specs/2026-06-17-protected-mode-design.md
 */

function uuidStub(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

export function protectedLabel(index: number | null | undefined, id: string): string {
  return typeof index === 'number' ? `Student ${index}` : `Student ${uuidStub(id)}`;
}

export function protectedSid(index: number | null | undefined, id: string): string {
  return typeof index === 'number' ? `S${index}` : `S-${uuidStub(id)}`;
}

export interface CoreStudentInput {
  id: string;
  sid: string;
  display_name: string;
  protected_index: number | null;
}

export interface CoreStudent {
  id: string;
  sid: string;
  display_name: string;
}

export function projectStudent(input: CoreStudentInput, protectedMode: boolean): CoreStudent {
  if (!protectedMode) {
    return { id: input.id, sid: input.sid, display_name: input.display_name };
  }
  return {
    id: input.id,
    sid: protectedSid(input.protected_index, input.id),
    display_name: protectedLabel(input.protected_index, input.id),
  };
}

export function maskEmail(email: string | null | undefined, protectedMode: boolean): string | null {
  return protectedMode ? null : (email ?? null);
}

export function maskExtras<T>(extras: T, protectedMode: boolean): T | null {
  return protectedMode ? null : extras;
}

export function maskFilename(name: string, protectedMode: boolean, label: string): string {
  return protectedMode ? label : name;
}
```

Run: `npx vitest run packages/server/src/services/protect.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add packages/server/src/services/protect.ts packages/server/src/services/protect.test.ts
git commit --no-gpg-sign -m "feat(server): add pure protected-mode masking helpers"
```

---

## Phase 2: Cohort list (projection + q-oracle + sort/cursor-oracle)

**Files:**
- Modify: `packages/server/src/services/cohort/list.ts`
- Modify: `packages/server/src/api/v1/routes/cohort.ts` (pass `protected`)
- Test: `packages/server/src/services/cohort/list.test.ts` (create if absent; else add cases)

This is the most involved phase because the cohort list both emits identity AND sorts/searches by it.

- [ ] **Step 1: Add a protected_index cursor variant + thread `protected` through the signature**

In `list.ts`, extend `CohortCursor` (line 58-62):

```ts
export type CohortCursor =
  | { kind: 'score'; score_total: number; id: string }
  | { kind: 'wall'; wall: string; id: string }
  | { kind: 'display_name'; display_name: string; id: string }
  | { kind: 'protected_index'; protected_index: number; id: string }
  | { kind: 'assignment_label'; assignment_label: string; id: string };
```

In `decodeCursor` (after the `display_name` branch, ~line 105) add:

```ts
    if (kind === 'protected_index' && typeof p['protected_index'] === 'number') {
      return { kind: 'protected_index', protected_index: p['protected_index'], id: p['id'] };
    }
```

Change the function signature (line 136-143) to accept `protectedMode`:

```ts
export async function listCohortSubmissions(
  db: DrizzleDb,
  semesterId: string,
  filters: CohortFilters,
  sort: CohortSort,
  cursor: CohortCursor | null,
  limit: number,
  protectedMode: boolean,
): Promise<{ items: SubmissionRow[]; nextCursor: string | null; totalCount: number }> {
```

- [ ] **Step 2: Close the q-search oracle**

In the `q` filter block (lines 244-252) and its duplicate in the count block (lines 396-404), guard on `!protectedMode` so a protected user's free-text never matches real name/sid:

```ts
  // q: free-text ILIKE on roster_entries.display_name or sid.
  // Disabled in protected mode (it would be a name->Student-N lookup oracle).
  if (!protectedMode && filters.q !== undefined && filters.q.trim() !== '') {
    const pattern = `%${filters.q.trim()}%`;
    whereConditions.push(
      or(
        sql`${roster_entries.display_name} ILIKE ${pattern}`,
        sql`${roster_entries.sid} ILIKE ${pattern}`,
      )!,
    );
  }
```

Apply the identical `!protectedMode &&` guard to the count-query copy at lines 396-404.

- [ ] **Step 3: Select protected_index and route student-name sorts through it**

Add `student_protected_index: roster_entries.protected_index` to the main `.select({...})` (after `student_display_name`, line 290).

Replace the `buildOrderBy`, `buildCursorCondition`, and `buildCursorFromRow` calls to pass `protectedMode`, and update those helpers. Update `buildOrderBy` (line 422):

```ts
function buildOrderBy(sort: CohortSort, protectedMode: boolean): SQL[] {
  switch (sort) {
    case 'score_desc':
      return [sql`${submissions.score_total} DESC`, sql`${submissions.id} DESC`];
    case 'score_asc':
      return [sql`${submissions.score_total} ASC`, sql`${submissions.id} ASC`];
    case 'ingested_desc':
      return [sql`${submissions.ingested_at} DESC`, sql`${submissions.id} DESC`];
    case 'student_asc':
      return protectedMode
        ? [sql`${roster_entries.protected_index} ASC`, sql`${submissions.id} ASC`]
        : [sql`${roster_entries.display_name} ASC`, sql`${submissions.id} ASC`];
    case 'student_desc':
      return protectedMode
        ? [sql`${roster_entries.protected_index} DESC`, sql`${submissions.id} DESC`]
        : [sql`${roster_entries.display_name} DESC`, sql`${submissions.id} DESC`];
    case 'assignment_asc':
      return [sql`${assignments.label} ASC`, sql`${submissions.id} ASC`];
  }
}
```

Update `buildCursorCondition` signature to `(sort, cursor, protectedMode)` and replace the `student_asc`/`student_desc` cases so they branch on the cursor kind:

```ts
    case 'student_asc': {
      if (protectedMode) {
        if (cursor.kind !== 'protected_index') return null;
        return or(
          sql`${roster_entries.protected_index} > ${cursor.protected_index}`,
          and(
            sql`${roster_entries.protected_index} = ${cursor.protected_index}`,
            sql`${submissions.id} > ${cursor.id}`,
          ),
        )!;
      }
      if (cursor.kind !== 'display_name') return null;
      return or(
        sql`${roster_entries.display_name} > ${cursor.display_name}`,
        and(
          sql`${roster_entries.display_name} = ${cursor.display_name}`,
          sql`${submissions.id} > ${cursor.id}`,
        ),
      )!;
    }
    case 'student_desc': {
      if (protectedMode) {
        if (cursor.kind !== 'protected_index') return null;
        return or(
          sql`${roster_entries.protected_index} < ${cursor.protected_index}`,
          and(
            sql`${roster_entries.protected_index} = ${cursor.protected_index}`,
            sql`${submissions.id} < ${cursor.id}`,
          ),
        )!;
      }
      if (cursor.kind !== 'display_name') return null;
      return or(
        sql`${roster_entries.display_name} < ${cursor.display_name}`,
        and(
          sql`${roster_entries.display_name} = ${cursor.display_name}`,
          sql`${submissions.id} < ${cursor.id}`,
        ),
      )!;
    }
```

Update `buildCursorFromRow` to take `protectedMode` and the new row field. Change its `row` param type to include `student_protected_index: number | null` and the `student_asc`/`student_desc` case:

```ts
    case 'student_asc':
    case 'student_desc':
      return protectedMode
        ? { kind: 'protected_index', protected_index: row.student_protected_index ?? 0, id: row.id }
        : { kind: 'display_name', display_name: row.student_display_name, id: row.id };
```

Update the three call sites: `buildOrderBy(sort, protectedMode)` (line 265), `buildCursorCondition(sort, cursor, protectedMode)` (line 256), and `buildCursorFromRow(sort, last, protectedMode)` (line 306). The `last` row passed to `buildCursorFromRow` already comes from the main select, which now includes `student_protected_index`.

- [ ] **Step 4: Mask the emitted student object**

Add the import at the top of `list.ts`:

```ts
import { projectStudent } from '../protect.js';
```

Replace the `student` block in the `items` map (lines 321-325):

```ts
    student: projectStudent(
      {
        id: row.student_id,
        sid: row.student_sid,
        display_name: row.student_display_name,
        protected_index: row.student_protected_index,
      },
      protectedMode,
    ),
```

- [ ] **Step 5: Pass `protected` from the route**

In `packages/server/src/api/v1/routes/cohort.ts`, the submissions handler calls `listCohortSubmissions(db, semesterId, filters, sort, cursor, limit)` (~line 163). Get the principal and pass its flag. Near the top of that handler add:

```ts
const principal = requirePrincipal(c);
const protectedMode = principal.user.protected;
```

(Confirm `requirePrincipal` is imported in `cohort.ts`; the route is already auth-gated, so the principal exists. If `requirePrincipal` isn't imported, add `import { requirePrincipal } from '../../middleware/auth-session.js';`.) Then:

```ts
listCohortSubmissions(db, semesterId, filters, sort, cursor, limit, protectedMode),
```

- [ ] **Step 6: Write/extend the integration test**

Add to `packages/server/src/services/cohort/list.test.ts` (create using the `withTestDb` + seed-helper pattern from `packages/server/src/api/v1/routes/cohort.test.ts` — copy its `seedUser`/`seedSession`/`seedStudent`/`seedSubmission` helpers, and insert students with explicit `protected_index`). Core assertions:

```ts
it('masks student identity and never emits real name/sid when protected', async () => {
  await withTestDb(async (db) => {
    // ...seed semester, two students with display_name 'Zara'/'Aaron', protected_index 1/2, one submission each...
    const res = await listCohortSubmissions(db, semId, {}, 'student_asc', null, 50, true);
    const names = res.items.map((i) => i.student.display_name);
    expect(names).not.toContain('Zara');
    expect(names).not.toContain('Aaron');
    expect(names.every((n) => /^Student \d+$/.test(n))).toBe(true);
    // student_asc in protected mode orders by protected_index, not name:
    expect(res.items[0]!.student.display_name).toBe('Student 1');
  });
});

it('protected cursor carries no real name', async () => {
  await withTestDb(async (db) => {
    // ...seed >1 page of students...
    const res = await listCohortSubmissions(db, semId, {}, 'student_asc', null, 1, true);
    expect(res.nextCursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(res.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded.kind).toBe('protected_index');
    expect(JSON.stringify(decoded)).not.toMatch(/Zara|Aaron/);
  });
});

it('ignores q name-search when protected', async () => {
  await withTestDb(async (db) => {
    // ...seed student 'Zara'...
    const res = await listCohortSubmissions(db, semId, { q: 'Zara' }, 'score_desc', null, 50, true);
    expect(res.totalCount).toBeGreaterThan(0); // q did not filter to the name match
  });
});

it('returns real identity when not protected', async () => {
  await withTestDb(async (db) => {
    const res = await listCohortSubmissions(db, semId, {}, 'score_desc', null, 50, false);
    expect(res.items.map((i) => i.student.display_name)).toContain('Zara');
  });
});
```

Run: `npx vitest run packages/server/src/services/cohort/list.test.ts`
Expected: PASS. Also run the existing cohort route test to catch the new arg: `npx vitest run packages/server/src/api/v1/routes/cohort.test.ts` (update its call expectations only if it calls the service directly — it goes through the route, so it should pass unchanged).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/services/cohort/list.ts packages/server/src/api/v1/routes/cohort.ts packages/server/src/services/cohort/list.test.ts
git commit --no-gpg-sign -m "feat(server): mask cohort list identity + close name search/sort/cursor oracles in protected mode"
```

---

## Phase 3: Students rollup (projection + oracle + nested worst_submission)

**Files:**
- Modify: `packages/server/src/services/cohort/students.ts`
- Modify: `packages/server/src/api/v1/routes/cohort.ts` (students handler)
- Test: `packages/server/src/services/cohort/students.test.ts`

- [ ] **Step 1: Thread `protected` + add protected_index cursor**

Extend `StudentCursor` (line 26-29):

```ts
export type StudentCursor =
  | { kind: 'score_sum'; score_sum: number; student_id: string }
  | { kind: 'score_max'; score_max: number; student_id: string }
  | { kind: 'display_name'; display_name: string; student_id: string }
  | { kind: 'protected_index'; protected_index: number; student_id: string };
```

Add to `decodeStudentCursor` (after the `display_name` branch, ~line 69):

```ts
    if (kind === 'protected_index' && typeof p['protected_index'] === 'number') {
      return { kind: 'protected_index', protected_index: p['protected_index'], student_id: p['student_id'] };
    }
```

Change `listStudents` signature (line 109-116) to add `protectedMode: boolean` as the last param.

- [ ] **Step 2: Close q + select protected_index**

Guard the `q` block (lines 177-185) with `!protectedMode &&` (same as Phase 2 Step 2).

Add `protected_index: roster_entries.protected_index` to the agg `.select({...})` (after `email`, line 197) and to the `.groupBy(...)` (line 206-211).

- [ ] **Step 3: Sort + cursor by protected_index when protected**

In the in-memory sort (lines 214-226), the `student_asc` case sorts by `display_name`. Replace with a protected-aware comparison. Add near the top of the function body:

```ts
const nameKey = (r: { display_name: string; protected_index: number | null }) =>
  protectedMode ? String(r.protected_index ?? 0).padStart(12, '0') : r.display_name;
```

Then in the `student_asc` case (lines 222-224):

```ts
      case 'student_asc': {
        const ak = nameKey(a);
        const bk = nameKey(b);
        if (ak !== bk) return ak < bk ? -1 : 1;
        return a.student_id < b.student_id ? -1 : 1;
      }
```

In the cursor-slicing `student_asc` case (lines 251-257), branch on protected:

```ts
        case 'student_asc':
          if (protectedMode && cursor.kind === 'protected_index') {
            const rk = r.protected_index ?? 0;
            afterCursor =
              rk > cursor.protected_index ||
              (rk === cursor.protected_index && r.student_id > cursor.student_id);
          } else if (!protectedMode && cursor.kind === 'display_name') {
            afterCursor =
              r.display_name > cursor.display_name ||
              (r.display_name === cursor.display_name && r.student_id > cursor.student_id);
          }
          break;
```

In the next-cursor construction `student_asc` case (lines 282-288):

```ts
      case 'student_asc':
        c = protectedMode
          ? { kind: 'protected_index', protected_index: last.protected_index ?? 0, student_id: last.student_id }
          : { kind: 'display_name', display_name: last.display_name, student_id: last.student_id };
        break;
```

- [ ] **Step 4: Mask emitted student (incl. email) + nested worst_submission**

Import at top:

```ts
import { projectStudent, maskEmail } from '../protect.js';
```

The nested `worst_submission` is built by `listCohortSubmissions` (line 302-309). Pass `protectedMode` as its new last arg so it masks too:

```ts
      const { items: worstItems } = await listCohortSubmissions(
        db,
        semesterId,
        { ...filters, studentId: agg.student_id },
        'score_desc',
        null,
        1,
        protectedMode,
      );
```

Replace the returned `student` block (lines 357-362):

```ts
        student: {
          ...projectStudent(
            { id: agg.student_id, sid: agg.sid, display_name: agg.display_name, protected_index: agg.protected_index },
            protectedMode,
          ),
          email: maskEmail(agg.email, protectedMode),
        },
```

- [ ] **Step 5: Pass `protected` from the students route handler**

In `cohort.ts`, the students handler calls `listStudents(db, semesterId, filters, sort, cursor, limit)` (~line 284). Add `const protectedMode = requirePrincipal(c).user.protected;` in that handler and pass it as the last arg.

- [ ] **Step 6: Test**

Create `packages/server/src/services/cohort/students.test.ts` mirroring Phase 2's test (masking, protected_index sort, cursor has no name, email null when protected, real identity when not protected).

Run: `npx vitest run packages/server/src/services/cohort/students.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/services/cohort/students.ts packages/server/src/api/v1/routes/cohort.ts packages/server/src/services/cohort/students.test.ts
git commit --no-gpg-sign -m "feat(server): mask students rollup + close oracles in protected mode"
```

---

## Phase 4: Submission summary (student + source_filename)

**Files:**
- Modify: `packages/server/src/services/submissions/summary.ts`
- Modify: `packages/server/src/api/v1/routes/submissions.ts`
- Test: `packages/server/src/services/submissions/summary.test.ts`

- [ ] **Step 1: Thread `protected` + mask**

Add `protectedMode: boolean` as the last param of `getSubmissionSummary` (line 98-101). Import:

```ts
import { projectStudent, maskFilename, protectedLabel } from '../protect.js';
```

Add `student_protected_index: roster_entries.protected_index` to the `.select({...})` (after `student_display_name`, line 124).

Replace the `student` block (lines 194-198) and the `source_filename` line (line 200):

```ts
    student: projectStudent(
      { id: row.student_id, sid: row.student_sid, display_name: row.student_display_name, protected_index: row.student_protected_index },
      protectedMode,
    ),
    ingested_at: row.ingested_at.toISOString(),
    source_filename: maskFilename(
      row.source_filename,
      protectedMode,
      `${protectedLabel(row.student_protected_index, row.student_id)} — submission`,
    ),
```

- [ ] **Step 2: Pass `protected` from the route**

In `packages/server/src/api/v1/routes/submissions.ts` (~line 80, `getSubmissionSummary(db, submissionId)`), add `const protectedMode = requirePrincipal(c).user.protected;` and pass it. (`requirePrincipal` is already used in that file for auth; confirm import.)

- [ ] **Step 3: Test**

Add to `packages/server/src/services/submissions/summary.test.ts` (create with `withTestDb` if absent): assert that for a protected call, `student.display_name` matches `/^Student \d+$/`, `student.sid` matches `/^S/`, and `source_filename` does not contain the real uploaded name; and that an unprotected call returns the real values.

Run: `npx vitest run packages/server/src/services/submissions/summary.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/services/submissions/summary.ts packages/server/src/api/v1/routes/submissions.ts packages/server/src/services/submissions/summary.test.ts
git commit --no-gpg-sign -m "feat(server): mask submission summary student + source_filename in protected mode"
```

---

## Phase 5: Cross-flag participants

**Files:**
- Modify: `packages/server/src/services/cross-flags/list.ts`
- Modify: `packages/server/src/api/v1/routes/cross-flags.ts`
- Test: `packages/server/src/services/cross-flags/list.test.ts`

- [ ] **Step 1: Thread `protected` into both entry points + the participant fetch**

`fetchParticipants` (line 197) builds the participant student object. Add `protectedMode` to `fetchParticipants`, `listCrossFlags`, and `getCrossFlag` signatures (pass it through). Add `student_protected_index: roster_entries.protected_index` to the participant `.select({...})` (after `student_display_name`, line ~211). Import `projectStudent`:

```ts
import { projectStudent } from '../protect.js';
```

Replace the participant `student` block (lines 227-231):

```ts
      student: projectStudent(
        { id: row.student_id, sid: row.student_sid, display_name: row.student_display_name, protected_index: row.student_protected_index },
        protectedMode,
      ),
```

- [ ] **Step 2: Pass `protected` from the routes**

In `cross-flags.ts`, both handlers (`listCrossFlags` at line 90, `getCrossFlag` at line 122) need `const protectedMode = requirePrincipal(c).user.protected;` and to pass it as the new last arg.

- [ ] **Step 3: Test**

Add a `withTestDb` test asserting cross-flag participants are masked (`/^Student \d+$/`) when protected and real when not.

Run: `npx vitest run packages/server/src/services/cross-flags/list.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/services/cross-flags/ packages/server/src/api/v1/routes/cross-flags.ts
git commit --no-gpg-sign -m "feat(server): mask cross-flag participants in protected mode"
```

---

## Phase 6: Roster listing (name + sid + email + extras)

**Files:**
- Modify: `packages/server/src/services/roster/index.ts` (or mask in the route — see step)
- Modify: `packages/server/src/api/v1/routes/roster.ts`
- Test: `packages/server/src/api/v1/routes/roster.test.ts`

The roster route builds the response inline (roster.ts lines 90-96) from `result.entries`, which carry `protected_index` (full-row select). Mask in the route to keep the service a plain reader.

- [ ] **Step 1: Mask the roster response rows**

In `roster.ts`, import at top:

```ts
import { projectStudent, maskEmail, maskExtras } from '../../../services/protect.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
```

In the GET roster handler, before building the response (line ~90), add:

```ts
const protectedMode = requirePrincipal(c).user.protected;
```

Replace the `entries.map` (lines 91-96):

```ts
    entries: result.entries.map((e) => ({
      ...projectStudent({ id: e.id, sid: e.sid, display_name: e.display_name, protected_index: e.protected_index }, protectedMode),
      email: maskEmail(e.email, protectedMode),
      extras: maskExtras(e.extras, protectedMode),
    })),
```

(`RosterEntrySchema.extras` is `z.record(...).nullable()`, so `null` is valid; `email` is nullable too — masked values satisfy the contract.)

- [ ] **Step 2: Test**

Add to `packages/server/src/api/v1/routes/roster.test.ts`: seed a protected superadmin's session, GET the roster, assert each entry's `display_name` matches `/^Student \d+$/`, `email` is null, `extras` is null; and a non-protected user sees real values.

Run: `npx vitest run packages/server/src/api/v1/routes/roster.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/api/v1/routes/roster.ts packages/server/src/api/v1/routes/roster.test.ts
git commit --no-gpg-sign -m "feat(server): mask roster listing (name/sid/email/extras) in protected mode"
```

---

## Phase 7: Ingest + unmatched file listings

**Files:**
- Modify: `packages/server/src/api/v1/routes/ingest.ts`
- Modify: `packages/server/src/api/v1/routes/unmatched.ts`
- Test: `packages/server/src/api/v1/routes/unmatched.test.ts`, `ingest.test.ts`

Both routes share a `formatFileSummary(row)` helper that emits `original_filename` and `matched_student`. Thread `protectedMode` into it.

- [ ] **Step 1: Make `formatFileSummary` protected-aware in unmatched.ts**

In `unmatched.ts`, import:

```ts
import { projectStudent, maskFilename, protectedLabel } from '../../../services/protect.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
```

Change `formatFileSummary(row)` (line ~90) to `formatFileSummary(row, protectedMode: boolean)`. Replace the filename + matched_student construction:

```ts
  const idxLabel =
    row.matched_student_id !== null ? protectedLabel(row.matched_student_protected_index, row.matched_student_id) : null;
  const out: Record<string, unknown> = {
    id: row.id,
    original_filename: maskFilename(
      row.original_filename,
      protectedMode,
      idxLabel !== null ? `${idxLabel} — file` : `(unmatched file ${row.id.slice(0, 8)})`,
    ),
    size_bytes: row.size_bytes,
    blob_sha256: row.blob_sha256,
    status: row.status,
  };

  if (row.matched_student_id !== null) {
    out['matched_student'] = projectStudent(
      { id: row.matched_student_id, sid: row.matched_student_sid, display_name: row.matched_student_display_name, protected_index: row.matched_student_protected_index },
      protectedMode,
    );
  }
```

Add `matched_student_protected_index: roster_entries.protected_index` to the `FILE_SELECT` object (line ~130). In the route handler, compute `const protectedMode = requirePrincipal(c).user.protected;` and pass it to `formatFileSummary(row, protectedMode)` at the map call (line ~238).

Note: `filename_capture` (a parsed capture from the filename) can also embed the name. In protected mode, drop it: in the `if (row.filename_capture ...)` block, guard with `if (!protectedMode && row.filename_capture ...)`.

- [ ] **Step 2: Apply the same change in ingest.ts**

`ingest.ts` has its own `formatFileSummary` (line ~189) and two call sites (job detail line ~615, files listing line ~694). Make the identical change: add `protected_index` to both the job-detail select (line ~582) and the files-listing select, change `formatFileSummary` to take `protectedMode`, compute it from `requirePrincipal(c).user.protected` in each handler, and pass it. Guard `filename_capture` the same way.

- [ ] **Step 3: Test**

Add to `unmatched.test.ts` and `ingest.test.ts`: with a protected session, assert `original_filename` does not contain the seeded real filename's name token and `matched_student.display_name` is `/^Student \d+$/`; with a normal session, real values appear.

Run: `npx vitest run packages/server/src/api/v1/routes/unmatched.test.ts packages/server/src/api/v1/routes/ingest.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/api/v1/routes/ingest.ts packages/server/src/api/v1/routes/unmatched.ts packages/server/src/api/v1/routes/unmatched.test.ts packages/server/src/api/v1/routes/ingest.test.ts
git commit --no-gpg-sign -m "feat(server): mask ingest/unmatched filenames + matched student in protected mode"
```

---

## Phase 8: Roster import assigns protected_index

**Files:**
- Modify: `packages/server/src/services/roster/index.ts` (`commitRoster`)
- Test: `packages/server/src/services/roster/index.test.ts` (or existing roster test)

- [ ] **Step 1: Call the assignment helper after insert (same transaction)**

In `commitRoster` (line 46), import at top of the file:

```ts
import { assignMissingProtectedIndices } from '../protected-index.js';
```

After the insert/update/delete logic inside the transaction (after line ~84, before the transaction returns), add:

```ts
    // Newly-inserted rows have NULL protected_index; assign per-semester indices.
    await assignMissingProtectedIndices(tx, semesterId);
```

(Confirm the transaction variable is named `tx`; `assignMissingProtectedIndices` accepts any `DrizzleDb`-compatible executor — the Drizzle transaction object qualifies.)

- [ ] **Step 2: Test**

Add a test: commit a roster preview with new rows, then assert every roster row in that semester has a non-null, unique `protected_index`.

Run: `npx vitest run packages/server/src/services/roster/index.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/services/roster/index.ts packages/server/src/services/roster/index.test.ts
git commit --no-gpg-sign -m "feat(server): assign protected_index on roster import"
```

---

## Phase 9: Shared schema — add `protected` to user schemas

**Files:**
- Modify: `packages/shared/src/api-schemas.ts`
- Test: `packages/shared/src/api-schemas.test.ts` (if present; else rely on contract test)

- [ ] **Step 1: Add the field**

In `api-schemas.ts`, add `protected: z.boolean()` to `UserSchema` (lines 19-26) and `AdminUserSummarySchema` (lines 770-777), after `is_superadmin` in each. This is additive; both server and analyzer are updated in this plan so the contract stays in sync.

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck --workspace=packages/shared
git add packages/shared/src/api-schemas.ts
git commit --no-gpg-sign -m "feat(shared): add protected field to user + admin-user schemas"
```

---

## Phase 10: Server — emit `protected`, add toggle endpoint, audit, self-guard

**Files:**
- Modify: `packages/server/src/api/v1/routes/me.ts`
- Modify: `packages/server/src/api/v1/routes/admin.ts`
- Modify: `packages/server/src/api/v1/contract.test.ts` (registry already validates; ensure responses include `protected`)
- Test: `packages/server/src/api/v1/routes/admin.test.ts`

- [ ] **Step 1: /me emits `protected`**

In `me.ts`, add `protected: boolean;` to the `UserSummary` interface (after `is_superadmin`, line 32) and to the `userSummary` object (after `is_superadmin: user.is_superadmin`, line 117): `protected: user.protected,`.

- [ ] **Step 2: /admin/users list + detail emit `protected`**

In `admin.ts` GET `/users` list: add `protected: users.protected` to the `.select({...})` (line 112-119) and `protected: u.protected` to the `items` map (line 126-133). In GET `/users/:userId` detail: the select is `db.select().from(users)` (full row, line 156) so `u.protected` is available — add `protected: u.protected` to the response `user` object (line 177-184).

- [ ] **Step 3: Write the failing test for the toggle endpoint**

In `admin.test.ts`, add tests (mirror existing admin DELETE tests for the harness):

```ts
it('PATCH /admin/users/:id/protected sets the flag (superadmin, not self)', async () => {
  await withTestDb(async (db) => {
    _testDb = db;
    _setConfigForTest(parseEnv(makeTestEnv()));
    const admin = await seedUser(db, { is_superadmin: true });
    const sess = await seedSession(db, admin.id);
    const target = await seedUser(db);
    const app = createV1App();
    const res = await app.fetch(new Request(`http://localhost/admin/users/${target.id}/protected`, {
      method: 'PATCH',
      headers: { Cookie: `__Host-prov_sess=${sess}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protected: true }),
    }));
    expect(res.status).toBe(200);
    const [row] = await db.select({ p: users.protected }).from(users).where(eq(users.id, target.id));
    expect(row!.p).toBe(true);
  });
});

it('rejects changing your OWN protected flag', async () => {
  await withTestDb(async (db) => {
    _testDb = db;
    _setConfigForTest(parseEnv(makeTestEnv()));
    const admin = await seedUser(db, { is_superadmin: true });
    const sess = await seedSession(db, admin.id);
    const app = createV1App();
    const res = await app.fetch(new Request(`http://localhost/admin/users/${admin.id}/protected`, {
      method: 'PATCH',
      headers: { Cookie: `__Host-prov_sess=${sess}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protected: false }),
    }));
    expect(res.status).toBe(400);
  });
});
```

(`seedUser` in `admin.test.ts` must support `{ is_superadmin: true }`. If the existing helper doesn't, extend it to spread opts into the insert values.)

Run: `npx vitest run packages/server/src/api/v1/routes/admin.test.ts`
Expected: FAIL (route not implemented → 404).

- [ ] **Step 4: Implement the toggle endpoint**

In `admin.ts`, add a request schema near `ViewAsRequestSchema` (line 39):

```ts
const SetProtectedRequestSchema = z.object({ protected: z.boolean() });
```

Add the route inside `createAdminRouter` (after the DELETE handler, before view-as). It mirrors the DELETE handler's self-guard + audit pattern:

```ts
  // ===========================================================================
  // PATCH /admin/users/:userId/protected — lock/unlock protected mode
  // (superadmin only; cannot change your OWN flag — that is the lock)
  // ===========================================================================
  router.patch(
    '/users/:userId/protected',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    async (c) => {
      const principal = requirePrincipal(c);
      const userId = c.req.param('userId');

      if (userId === principal.user.id) {
        return c.json(
          Errors.validation([{ field: 'user_id', issue: 'cannot change your own protected flag' }]).toBody(),
          400,
        );
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ field: 'body', issue: 'invalid JSON' }]).toBody(), 400);
      }
      const parsed = SetProtectedRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(Errors.validation([{ field: 'protected', issue: 'must be boolean' }]).toBody(), 400);
      }

      const targetRows = await db()
        .select({ id: users.id, email: users.email, protected: users.protected })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const target = targetRows[0];
      if (target === undefined) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      await db().update(users).set({ protected: parsed.data.protected }).where(eq(users.id, userId));

      void insertAuditRow({
        actorUserId: principal.user.id,
        actorTokenId: principal.principal_kind === 'token' ? principal.token.id : null,
        semesterId: null,
        action: 'admin.user.set_protected',
        targetType: 'user',
        targetId: userId,
        detail: { email: target.email, from: target.protected, to: parsed.data.protected },
        ip: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        at: new Date(),
      }).catch(() => {});

      return c.json({ id: userId, protected: parsed.data.protected });
    },
  );
```

Run: `npx vitest run packages/server/src/api/v1/routes/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the contract test still passes**

Run: `npx vitest run packages/server/src/api/v1/contract.test.ts`
Expected: PASS — `/me` and `/admin/users` responses now include `protected`, satisfying the updated `UserSchema`/`AdminUserSummarySchema`. If it fails because a response is missing `protected`, add it at the indicated builder.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/server/src/api/v1/routes/me.ts packages/server/src/api/v1/routes/admin.ts packages/server/src/api/v1/routes/admin.test.ts
git commit --no-gpg-sign -m "feat(server): expose protected on /me + /admin/users; add self-guarded toggle endpoint with audit"
```

---

## Phase 11: Analyzer — banner + admin toggle

**Files:**
- Create: `packages/analyzer/src/components/nav/ProtectedModeBanner.tsx`
- Modify: `packages/analyzer/src/components/nav/AppShell.tsx`
- Modify: `packages/analyzer/src/api/queries.ts` (add `useSetUserProtected`)
- Modify: `packages/analyzer/src/views/admin/AdminUsersView.tsx`
- Test: analyzer component test if the suite has one for AppShell/AdminUsersView; otherwise rely on typecheck + manual.

- [ ] **Step 1: Banner component**

Create `packages/analyzer/src/components/nav/ProtectedModeBanner.tsx`:

```tsx
import { useMe } from '../../api/queries';

export function ProtectedModeBanner() {
  const { data: me } = useMe();
  if (!me?.user.protected) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-sm font-medium text-amber-900"
      data-testid="protected-mode-banner"
    >
      🔒 Protected mode — student identities are masked
    </div>
  );
}
```

(Match the styling idiom of the existing `ViewAsBanner`; adjust class names to the project's palette if they differ.)

- [ ] **Step 2: Mount it in AppShell**

In `AppShell.tsx`, import `ProtectedModeBanner` and render it right after `<ViewAsBanner />` (line ~90):

```tsx
        <ViewAsBanner />
        <ProtectedModeBanner />
```

- [ ] **Step 3: Mutation hook**

In `packages/analyzer/src/api/queries.ts`, add (mirror the existing `useUpdateMemberRole` PATCH mutation pattern):

```ts
export function useSetUserProtected() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, protected: isProtected }: { userId: string; protected: boolean }) =>
      apiFetch(`/admin/users/${userId}/protected`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protected: isProtected }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers ?? ['admin', 'users'] });
    },
  });
}
```

(Use the exact query key the existing `useAdminUsers` hook registers — check `queryKeys` in this file and match it.)

- [ ] **Step 4: Per-row toggle in AdminUsersView**

In `AdminUsersView.tsx`, import `useSetUserProtected` and `useMe`. In the component body add:

```tsx
const { mutate: setProtected } = useSetUserProtected();
const { data: me } = useMe();
```

In the per-row actions cell (alongside the existing "View as"/"Delete" buttons), add:

```tsx
<button
  type="button"
  onClick={() => setProtected({ userId: u.id, protected: !u.protected })}
  disabled={u.id === me?.user.id}
  className="rounded border border-amber-300 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50"
  data-testid={`protected-toggle-${u.id}`}
>
  {u.protected ? 'Unprotect' : 'Protect'}
</button>
```

- [ ] **Step 5: Typecheck + lint + build the analyzer**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (`me.user.protected` and `u.protected` are now typed because Phase 9 added them to the shared schemas the analyzer consumes.)

Run: `npm run build --workspace=packages/analyzer`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/components/nav/ProtectedModeBanner.tsx packages/analyzer/src/components/nav/AppShell.tsx packages/analyzer/src/api/queries.ts packages/analyzer/src/views/admin/AdminUsersView.tsx
git commit --no-gpg-sign -m "feat(analyzer): protected-mode banner + superadmin toggle in admin users"
```

---

## Phase 12: Full verification + progress update

- [ ] **Step 1: Whole-workspace gates**

Run (Docker must be running for server integration tests):

```bash
npm run typecheck
npm run lint
npm run test
```

Expected: all pass. If any pre-existing unrelated test is flaky/failing, note it in `.notes/progress.md` rather than weakening it.

- [ ] **Step 2: Manual oracle sanity (optional but recommended)**

With dev server + a protected superadmin account, confirm: cohort/students/roster/cross-flags/ingest views show `Student N`; CSV export contains only `Student N`; the admin self-row toggle is disabled; the banner shows.

- [ ] **Step 3: Update `.notes/progress.md`**

Mark all phases DONE in the status table, append a Worklog entry summarizing what shipped, and record any on-the-fly deviations under "Decisions made on the fly".

- [ ] **Step 4: Final commit (if progress.md is tracked — it is NOT; it's git-excluded, so no commit needed). Confirm tree is clean of source changes:**

```bash
git status
git log --oneline -15
```

---

## Coverage check (plan ↔ spec)

- Hard server-side boundary → Phases 1-7 (masking before serialization, incl. cursors).
- `users.protected` + lock via can't-change-own-flag → Phases 0, 10.
- `roster_entries.protected_index` randomized, stable, per-semester → Phases 0, 8.
- Mask name/sid/email/extras/filenames → Phases 2-7 (source_filename + ingest filenames included).
- Exports inherit masking → automatic (Phase 2 covers the cohort submissions feed the CSV uses); verified in Phase 12 Step 2.
- Oracle closures (q-search, name sort, cursor contents) → Phases 2, 3.
- View-as cannot bypass → derives from `principal.user.protected` (the real user) everywhere; no extra code, asserted implicitly (Phase 10 audit/test note).
- No student-identity contract change; additive `protected` field on user schemas → Phase 9.
- Banner + admin toggle → Phase 11.
- Out of scope (code content, staff emails, files[].path) → explicitly untouched.
```
