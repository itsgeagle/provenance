/**
 * Course and semester service module.
 *
 * Pure Drizzle operations for structural entities (courses and semesters).
 * All DB writes go through here. Error handling for conflicts (slug uniqueness).
 *
 * Architecture:
 * - No side effects beyond the DB.
 * - No response shape serialization (routes handle that).
 * - Errors are thrown as ApiError instances (mapped from postgres constraint violations).
 * - Transactions are the responsibility of callers (routes or integration tests).
 */

import { eq, and, isNull, desc, count as countFn, inArray } from 'drizzle-orm';
import { courses, semesters, memberships } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import type { Principal } from '../api/middleware/auth-session.js';
import { Errors } from '../api/v1/errors.js';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

export type CourseRow = typeof courses.$inferSelect;
export type SemesterRow = typeof semesters.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;

export interface CourseSummary {
  id: string;
  name: string;
  slug: string;
  archived: boolean;
  semesters_count: number;
}

export interface SemesterSummary {
  id: string;
  course_id: string;
  slug: string;
  term: string;
  year: number;
  display_name: string;
  archived: boolean;
  submission_count: number;
  student_count: number;
  assignment_count: number;
  active_config_version: number;
  my_role: 'admin' | 'grader' | null;
}

export interface SemesterDetail extends SemesterSummary {
  filename_convention: string;
  blob_retention_days: number;
  derived_retention_days: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Error detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `err` represents a Postgres unique constraint violation
 * (error code 23505).
 *
 * Postgres.js wraps the underlying PostgresError in a query wrapper; we must
 * check both the top-level error and its `.cause` to handle both cases.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Direct postgres error
  if ((err as unknown as { code?: string }).code === '23505') return true;
  // Wrapped by postgres.js query layer
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && (cause as unknown as { code?: string }).code === '23505') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

/**
 * Create a new course.
 * Throws COURSE_SLUG_TAKEN if slug is already taken.
 */
export async function createCourse(
  db: DrizzleDb,
  input: { name: string; slug: string },
): Promise<CourseRow> {
  try {
    const [course] = await db
      .insert(courses)
      .values({
        name: input.name,
        slug: input.slug,
      })
      .returning();
    return course!;
  } catch (err) {
    // Postgres.js wraps the DB error; check both the wrapper and the cause.
    // Unique constraint violations have postgres error code '23505'.
    if (isUniqueConstraintViolation(err)) {
      throw Errors.courseSlugTaken(input.slug);
    }
    throw err;
  }
}

/**
 * List courses accessible by the given principal.
 * - Superadmin: all courses
 * - Others: courses containing at least one semester the principal is a member of
 */
export async function listCoursesForPrincipal(db: DrizzleDb, principal: Principal): Promise<CourseSummary[]> {
  if (principal.user.is_superadmin) {
    // Superadmin: all courses with semester counts
    const rows = await db
      .select({
        id: courses.id,
        name: courses.name,
        slug: courses.slug,
        archived: isNull(courses.archived_at).as('not_archived'),
        semesters_count: countFn(semesters.id).as('count'),
      })
      .from(courses)
      .leftJoin(semesters, eq(semesters.course_id, courses.id))
      .groupBy(courses.id, courses.name, courses.slug, courses.archived_at)
      .orderBy(desc(courses.created_at));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      archived: !row.archived,
      semesters_count: row.semesters_count,
    }));
  }

  // Non-superadmin: courses with at least one semester they're a member of.
  // created_at is included in the select so it can appear in the ORDER BY
  // clause (SELECT DISTINCT requires this in Postgres).
  const rows = await db
    .selectDistinct({
      id: courses.id,
      name: courses.name,
      slug: courses.slug,
      archived: isNull(courses.archived_at).as('not_archived'),
      created_at: courses.created_at,
    })
    .from(courses)
    .innerJoin(semesters, eq(semesters.course_id, courses.id))
    .innerJoin(memberships, eq(memberships.semester_id, semesters.id))
    .where(eq(memberships.user_id, principal.user.id))
    .orderBy(desc(courses.created_at));

  // Short-circuit: user has no accessible courses.
  // inArray with an empty list generates invalid SQL, so return early.
  if (rows.length === 0) {
    return [];
  }

  // Count semesters per course
  const semesterCounts = await db
    .select({
      course_id: courses.id,
      count: countFn(semesters.id).as('count'),
    })
    .from(courses)
    .leftJoin(semesters, eq(semesters.course_id, courses.id))
    .where(
      inArray(
        courses.id,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(courses.id);

  const countMap = Object.fromEntries(semesterCounts.map((r) => [r.course_id, r.count]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    archived: !row.archived,
    semesters_count: countMap[row.id] || 0,
  }));
}

/**
 * Get a single course by ID.
 */
export async function getCourse(db: DrizzleDb, courseId: string): Promise<CourseRow | null> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  return course || null;
}

/**
 * Update course name.
 */
export async function updateCourse(
  db: DrizzleDb,
  courseId: string,
  input: { name?: string },
): Promise<CourseRow | null> {
  if (input.name === undefined) {
    return getCourse(db, courseId);
  }

  const [updated] = await db
    .update(courses)
    .set({ name: input.name })
    .where(eq(courses.id, courseId))
    .returning();

  return updated || null;
}

/**
 * Archive a course by setting archived_at to now.
 * Does NOT cascade to semesters; they remain accessible but with archived parent.
 */
export async function archiveCourse(db: DrizzleDb, courseId: string): Promise<void> {
  await db
    .update(courses)
    .set({ archived_at: new Date() })
    .where(eq(courses.id, courseId));
}

// ---------------------------------------------------------------------------
// Semesters
// ---------------------------------------------------------------------------

/**
 * Validates a filename convention regex.
 * Returns null on success, or an error to throw.
 *
 * Checks:
 *   (a) Valid ECMA-262 regex
 *   (b) Contains (?<sid>...) named group
 *   (c) Length ≤ 500 chars
 */
export function validateFilenameConvention(pattern: string): void {
  if (pattern.length > 500) {
    throw Errors.validationRegex('filename_convention', 'Pattern exceeds 500 characters');
  }

  try {
    const regex = new RegExp(pattern);
    // Check for (?<sid>...) named group
    if (!regex.source.includes('(?<sid>')) {
      throw Errors.validationRegex(
        'filename_convention',
        "Pattern must contain a named group (?<sid>...)",
      );
    }
  } catch (err) {
    if (err instanceof Errors.constructor) {
      throw err; // re-throw our ApiError
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw Errors.validationRegex('filename_convention', msg);
  }
}

/**
 * Create a new semester.
 * Throws SEMESTER_SLUG_TAKEN if slug is taken within the course.
 * Throws VALIDATION_REGEX if filename_convention is invalid.
 */
export async function createSemester(
  db: DrizzleDb,
  input: {
    courseId: string;
    term: string;
    year: number;
    slug: string;
    displayName: string;
    filenameConvention: string;
    blobRetentionDays?: number;
    derivedRetentionDays?: number;
  },
): Promise<SemesterRow> {
  // Validate filename convention before attempting DB insert
  validateFilenameConvention(input.filenameConvention);

  const blobRetentionDays = input.blobRetentionDays ?? 540;
  const derivedRetentionDays = input.derivedRetentionDays ?? 1825;

  try {
    const [semester] = await db
      .insert(semesters)
      .values({
        course_id: input.courseId,
        term: input.term,
        year: input.year,
        slug: input.slug,
        display_name: input.displayName,
        filename_convention: input.filenameConvention,
        blob_retention_days: blobRetentionDays,
        derived_retention_days: derivedRetentionDays,
      })
      .returning();
    return semester!;
  } catch (err) {
    // Postgres.js wraps the DB error; check both the wrapper and the cause.
    // Unique constraint violations have postgres error code '23505'.
    if (isUniqueConstraintViolation(err)) {
      throw Errors.semesterSlugTaken(input.slug);
    }
    throw err;
  }
}

/**
 * List semesters in a course with membership info for the given principal.
 * Returns summaries with placeholders for counts (filled in later phases).
 */
export async function listSemestersInCourse(
  db: DrizzleDb,
  courseId: string,
  principal: Principal,
): Promise<SemesterSummary[]> {
  const rows = await db
    .select({
      id: semesters.id,
      course_id: semesters.course_id,
      slug: semesters.slug,
      term: semesters.term,
      year: semesters.year,
      display_name: semesters.display_name,
      archived_at: semesters.archived_at,
      role: memberships.role,
    })
    .from(semesters)
    .leftJoin(
      memberships,
      and(
        eq(memberships.semester_id, semesters.id),
        eq(memberships.user_id, principal.user.id),
      ),
    )
    .where(eq(semesters.course_id, courseId))
    .orderBy(desc(semesters.created_at));

  return rows.map((row) => ({
    id: row.id,
    course_id: row.course_id,
    slug: row.slug,
    term: row.term,
    year: row.year,
    display_name: row.display_name,
    archived: row.archived_at !== null,
    submission_count: 0, // Phase 9+
    student_count: 0, // Phase 7+
    assignment_count: 0, // Phase 9+
    active_config_version: 0, // Phase 13+
    my_role: (row.role as 'admin' | 'grader') || null,
  }));
}

/**
 * Get a single semester by ID with full details.
 * `principal` is optional — if omitted, my_role will always be null.
 */
export async function getSemester(
  db: DrizzleDb,
  semesterId: string,
  principal?: Principal,
): Promise<SemesterDetail | null> {
  const row = await db
    .select({
      id: semesters.id,
      course_id: semesters.course_id,
      slug: semesters.slug,
      term: semesters.term,
      year: semesters.year,
      display_name: semesters.display_name,
      filename_convention: semesters.filename_convention,
      blob_retention_days: semesters.blob_retention_days,
      derived_retention_days: semesters.derived_retention_days,
      archived_at: semesters.archived_at,
      created_at: semesters.created_at,
      role: memberships.role,
    })
    .from(semesters)
    .leftJoin(
      memberships,
      principal
        ? and(
            eq(memberships.semester_id, semesters.id),
            eq(memberships.user_id, principal.user.id),
          )
        : isNull(memberships.user_id),
    )
    .where(eq(semesters.id, semesterId));

  if (row.length === 0) {
    return null;
  }

  const r = row[0]!;
  return {
    id: r.id,
    course_id: r.course_id,
    slug: r.slug,
    term: r.term,
    year: r.year,
    display_name: r.display_name,
    filename_convention: r.filename_convention,
    blob_retention_days: r.blob_retention_days,
    derived_retention_days: r.derived_retention_days,
    archived: r.archived_at !== null,
    created_at: r.created_at.toISOString(),
    submission_count: 0,
    student_count: 0,
    assignment_count: 0,
    active_config_version: 0,
    my_role: (r.role as 'admin' | 'grader') || null,
  };
}

/**
 * Update semester fields.
 */
export async function updateSemester(
  db: DrizzleDb,
  semesterId: string,
  input: {
    displayName?: string;
    filenameConvention?: string;
    blobRetentionDays?: number;
    derivedRetentionDays?: number;
  },
): Promise<SemesterRow | null> {
  if (input.filenameConvention) {
    validateFilenameConvention(input.filenameConvention);
  }

  const updates: Record<string, unknown> = {};
  if (input.displayName !== undefined) updates.display_name = input.displayName;
  if (input.filenameConvention !== undefined) updates.filename_convention = input.filenameConvention;
  if (input.blobRetentionDays !== undefined) updates.blob_retention_days = input.blobRetentionDays;
  if (input.derivedRetentionDays !== undefined)
    updates.derived_retention_days = input.derivedRetentionDays;

  if (Object.keys(updates).length === 0) {
    const [sem] = await db.select().from(semesters).where(eq(semesters.id, semesterId));
    return sem || null;
  }

  const [updated] = await db
    .update(semesters)
    .set(updates)
    .where(eq(semesters.id, semesterId))
    .returning();

  return updated || null;
}

/**
 * Archive a semester by setting archived_at to now.
 */
export async function archiveSemester(db: DrizzleDb, semesterId: string): Promise<void> {
  await db
    .update(semesters)
    .set({ archived_at: new Date() })
    .where(eq(semesters.id, semesterId));
}

/**
 * Check if a semester is archived.
 */
export async function isArchivedSemester(db: DrizzleDb, semesterId: string): Promise<boolean> {
  const [row] = await db
    .select({ archived_at: semesters.archived_at })
    .from(semesters)
    .where(eq(semesters.id, semesterId));

  return row ? row.archived_at !== null : false;
}

// ---------------------------------------------------------------------------
// Memberships (for populating /me)
// ---------------------------------------------------------------------------

/**
 * Get all memberships for a user.
 */
export async function getUserMemberships(
  db: DrizzleDb,
  userId: string,
): Promise<
  Array<{
    semester_id: string;
    semester_slug: string;
    course_slug: string;
    role: string;
    granted_at: Date;
  }>
> {
  const rows = await db
    .select({
      semester_id: memberships.semester_id,
      semester_slug: semesters.slug,
      course_slug: courses.slug,
      role: memberships.role,
      granted_at: memberships.granted_at,
    })
    .from(memberships)
    .innerJoin(semesters, eq(memberships.semester_id, semesters.id))
    .innerJoin(courses, eq(semesters.course_id, courses.id))
    .where(eq(memberships.user_id, userId))
    .orderBy(desc(memberships.granted_at));

  return rows;
}
