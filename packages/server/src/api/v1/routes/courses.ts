/**
 * Course CRUD routes.
 *
 * GET  /api/v1/courses           — list courses
 * POST /api/v1/courses           — create course (superadmin only)
 * GET  /api/v1/courses/:id       — get course
 * PATCH /api/v1/courses/:id      — update course (superadmin only)
 * POST /api/v1/courses/:id/archive — archive course (superadmin only)
 *
 * Auth: see individual routes.
 * Rate limiting: read.cohort for list, read.detail for get, write.misc for writes.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { courses } from '../../../db/schema.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import {
  createCourseRequestSchema,
  updateCourseRequestSchema,
  listCoursesResponseSchema,
  createCourseResponseSchema,
  getCourseResponseSchema,
  updateCourseResponseSchema,
  type CourseDetail,
} from '../schemas/structure.js';
import * as structureService from '../../../services/structure.js';

// ---------------------------------------------------------------------------
// Helper: serialize CourseRow to CourseSummary
// ---------------------------------------------------------------------------

function courseToCourseDetail(course: typeof courses.$inferSelect): CourseDetail {
  return {
    id: course.id,
    name: course.name,
    slug: course.slug,
    archived: course.archived_at !== null,
    semesters_count: 0, // Will be filled in by queries in list
    created_at: course.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createCoursesRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /courses — list courses (authenticated, rate-limited)
  // -------------------------------------------------------------------------

  router.get(
    '/',
    rateLimit('read.cohort'),
    requireAuth({ action: 'read', target: 'global' }),
    async (c) => {
      const principal = c.var.principal!;
      const db = getDb();

      try {
        const courseSummaries = await structureService.listCoursesForPrincipal(db, principal);

        const response = listCoursesResponseSchema.parse({
          courses: courseSummaries,
        });

        return c.json(response);
      } catch (err) {
        if (err instanceof Error && err.message.includes('validation')) {
          return c.json(Errors.validation([{ error: err.message }]).toBody(), 400);
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /courses — create course (superadmin only)
  // -------------------------------------------------------------------------

  router.post(
    '/',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    audit('course.create', 'course', (c) => c.var.target ? 'global' : 'global'),
    async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parseResult = createCourseRequestSchema.safeParse(body);
      if (!parseResult.success) {
        return c.json(
          Errors.validation(parseResult.error.issues).toBody(),
          400,
        );
      }

      const { name, slug } = parseResult.data;
      const db = getDb();

      try {
        const course = await structureService.createCourse(db, { name, slug });

        const response = createCourseResponseSchema.parse({
          course: courseToCourseDetail(course),
        });

        return c.json(response, 201);
      } catch (err) {
        if (err instanceof Error && err.message.includes('COURSE_SLUG_TAKEN')) {
          throw Errors.courseSlugTaken(slug);
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /courses/:courseId — get course detail
  // -------------------------------------------------------------------------

  router.get(
    '/:courseId',
    rateLimit('read.detail'),
    requireAuth({ action: 'read', target: 'global' }),
    async (c) => {
      const courseId = c.req.param('courseId');
      const principal = c.var.principal!;
      const db = getDb();

      // Check if user can see this course
      try {
        const courses_list = await structureService.listCoursesForPrincipal(db, principal);
        if (!courses_list.find((course) => course.id === courseId)) {
          throw Errors.notFound();
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('NOT_FOUND')) {
          throw err;
        }
      }

      const course = await structureService.getCourse(db, courseId);
      if (!course) {
        throw Errors.notFound();
      }

      const response = getCourseResponseSchema.parse({
        course: courseToCourseDetail(course),
      });

      return c.json(response);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /courses/:courseId — update course (superadmin only)
  // -------------------------------------------------------------------------

  router.patch(
    '/:courseId',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    audit('course.update', 'course', (c) => c.req.param('courseId')!),
    async (c) => {
      const courseId = c.req.param('courseId');

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parseResult = updateCourseRequestSchema.safeParse(body);
      if (!parseResult.success) {
        return c.json(
          Errors.validation(parseResult.error.issues).toBody(),
          400,
        );
      }

      const db = getDb();
      const course = await structureService.getCourse(db, courseId);
      if (!course) {
        throw Errors.notFound();
      }

      const updateInput: { name?: string } = {};
      if (parseResult.data.name !== undefined) {
        updateInput.name = parseResult.data.name;
      }

      const updated = await structureService.updateCourse(db, courseId, updateInput);
      if (!updated) {
        throw Errors.notFound();
      }

      const response = updateCourseResponseSchema.parse({
        course: courseToCourseDetail(updated),
      });

      return c.json(response);
    },
  );

  // -------------------------------------------------------------------------
  // POST /courses/:courseId/archive — archive course (superadmin only)
  // -------------------------------------------------------------------------

  router.post(
    '/:courseId/archive',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    audit('course.archive', 'course', (c) => c.req.param('courseId')!),
    async (c) => {
      const courseId = c.req.param('courseId');
      const db = getDb();

      const course = await structureService.getCourse(db, courseId);
      if (!course) {
        throw Errors.notFound();
      }

      await structureService.archiveCourse(db, courseId);
      return c.body(null, 204);
    },
  );

  return router;
}
