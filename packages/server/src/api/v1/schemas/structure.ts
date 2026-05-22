/**
 * Request and response Zod schemas for courses and semesters.
 *
 * Organized per PRD §8.2 endpoint spec.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------

/**
 * Slug format: lowercase alphanumeric + dashes.
 * Examples: "cs61a", "fa2026", "proj-1"
 */
const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, digits, and dashes');

const termSchema = z.enum(['fa', 'sp', 'su', 'wi']);
const yearSchema = z.number().int().min(2000).max(2100);

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/courses — request body
 */
export const createCourseRequestSchema = z.object({
  name: z.string().min(1).max(255),
  slug: slugSchema,
});

export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;

/**
 * PATCH /api/v1/courses/:id — request body
 */
export const updateCourseRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

export type UpdateCourseRequest = z.infer<typeof updateCourseRequestSchema>;

/**
 * Course summary in list responses
 */
export const courseSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  archived: z.boolean(),
  semesters_count: z.number().int().nonnegative(),
});

export type CourseSummary = z.infer<typeof courseSummarySchema>;

/**
 * Course detail in GET responses
 */
export const courseDetailSchema = courseSummarySchema.extend({
  created_at: z.string().datetime(),
});

export type CourseDetail = z.infer<typeof courseDetailSchema>;

/**
 * GET /api/v1/courses — response
 */
export const listCoursesResponseSchema = z.object({
  courses: z.array(courseSummarySchema),
});

/**
 * POST /api/v1/courses — response
 */
export const createCourseResponseSchema = z.object({
  course: courseDetailSchema,
});

/**
 * GET /api/v1/courses/:id — response
 */
export const getCourseResponseSchema = z.object({
  course: courseDetailSchema,
});

/**
 * PATCH /api/v1/courses/:id — response
 */
export const updateCourseResponseSchema = z.object({
  course: courseDetailSchema,
});

// ---------------------------------------------------------------------------
// Semesters
// ---------------------------------------------------------------------------

/**
 * Filename convention validation happens in the service layer, but we still
 * need a schema for the request body.
 */
export const createSemesterRequestSchema = z.object({
  term: termSchema,
  year: yearSchema,
  slug: slugSchema,
  display_name: z.string().min(1).max(255),
  filename_convention: z.string().min(1).max(500),
  blob_retention_days: z.number().int().min(30).optional(),
  derived_retention_days: z.number().int().optional(),
});

export type CreateSemesterRequest = z.infer<typeof createSemesterRequestSchema>;

export const updateSemesterRequestSchema = z.object({
  display_name: z.string().min(1).max(255).optional(),
  filename_convention: z.string().min(1).max(500).optional(),
  blob_retention_days: z.number().int().min(30).optional(),
  derived_retention_days: z.number().int().optional(),
});

export type UpdateSemesterRequest = z.infer<typeof updateSemesterRequestSchema>;

/**
 * Semester summary in list responses
 */
export const semesterSummarySchema = z.object({
  id: z.string().uuid(),
  course_id: z.string().uuid(),
  slug: z.string(),
  term: z.string(),
  year: z.number().int(),
  display_name: z.string(),
  archived: z.boolean(),
  submission_count: z.number().int().nonnegative(),
  student_count: z.number().int().nonnegative(),
  assignment_count: z.number().int().nonnegative(),
  active_config_version: z.number().int().nonnegative(),
  my_role: z.enum(['admin', 'grader']).nullable(),
});

export type SemesterSummary = z.infer<typeof semesterSummarySchema>;

/**
 * Semester detail in GET responses
 */
export const semesterDetailSchema = semesterSummarySchema.extend({
  filename_convention: z.string(),
  blob_retention_days: z.number().int().nonnegative(),
  derived_retention_days: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
});

export type SemesterDetail = z.infer<typeof semesterDetailSchema>;

/**
 * GET /api/v1/courses/:courseId/semesters — response
 */
export const listSemestersResponseSchema = z.object({
  semesters: z.array(semesterSummarySchema),
});

/**
 * POST /api/v1/courses/:courseId/semesters — response
 */
export const createSemesterResponseSchema = z.object({
  semester: semesterDetailSchema,
});

/**
 * GET /api/v1/semesters/:id — response
 */
export const getSemesterResponseSchema = z.object({
  semester: semesterDetailSchema,
});

/**
 * PATCH /api/v1/semesters/:id — response
 */
export const updateSemesterResponseSchema = z.object({
  semester: semesterDetailSchema,
});

// ---------------------------------------------------------------------------
// /me memberships
// ---------------------------------------------------------------------------

export const membershipSummarySchema = z.object({
  semester_id: z.string().uuid(),
  semester_slug: z.string(),
  course_slug: z.string(),
  role: z.enum(['admin', 'grader']),
  granted_at: z.string().datetime(),
});

export type MembershipSummary = z.infer<typeof membershipSummarySchema>;
