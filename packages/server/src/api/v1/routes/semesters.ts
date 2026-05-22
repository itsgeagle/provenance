/**
 * Semester CRUD routes.
 *
 * GET  /api/v1/courses/:courseId/semesters     — list semesters in course
 * POST /api/v1/courses/:courseId/semesters     — create semester (superadmin only)
 * GET  /api/v1/semesters/:semesterId           — get semester detail
 * PATCH /api/v1/semesters/:semesterId          — update semester (semester admin)
 * POST /api/v1/semesters/:semesterId/archive   — archive semester (superadmin only)
 *
 * Auth: see individual routes.
 * Rate limiting: read.cohort for list, read.detail for get, write.misc for writes.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { semesters } from '../../../db/schema.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import {
  createSemesterRequestSchema,
  updateSemesterRequestSchema,
  listSemestersResponseSchema,
  createSemesterResponseSchema,
  getSemesterResponseSchema,
  updateSemesterResponseSchema,
  type SemesterDetail,
} from '../schemas/structure.js';
import * as structureService from '../../../services/structure.js';

// ---------------------------------------------------------------------------
// Helper: serialize SemesterRow to SemesterDetail
// ---------------------------------------------------------------------------

function semesterToSemesterDetail(
  semester: typeof semesters.$inferSelect,
  myRole?: string | null,
): SemesterDetail {
  return {
    id: semester.id,
    course_id: semester.course_id,
    slug: semester.slug,
    term: semester.term,
    year: semester.year,
    display_name: semester.display_name,
    filename_convention: semester.filename_convention,
    blob_retention_days: semester.blob_retention_days,
    derived_retention_days: semester.derived_retention_days,
    archived: semester.archived_at !== null,
    submission_count: 0, // Phase 9+
    student_count: 0, // Phase 7+
    assignment_count: 0, // Phase 9+
    active_config_version: 0, // Phase 13+
    my_role: (myRole as 'admin' | 'grader' | null) || null,
    created_at: semester.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createSemestersRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /courses/:courseId/semesters — list semesters in course
  //
  // Uses a manual auth check rather than requireAuth('global') because
  // 'global' implies superadmin-only. Any authenticated user with visibility
  // into the course (member of at least one semester in it) may list semesters;
  // the service layer filters results by membership for non-superadmins.
  // -------------------------------------------------------------------------

  router.get('/courses/:courseId/semesters', rateLimit('read.cohort'), async (c) => {
    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }
    const courseId = c.req.param('courseId');
    const db = getDb();

    // Check if user can see this course
    const courses_list = await structureService.listCoursesForPrincipal(db, principal);
    if (!courses_list.find((course) => course.id === courseId)) {
      throw Errors.notFound();
    }

    const semesters_list = await structureService.listSemestersInCourse(db, courseId, principal);

    const response = listSemestersResponseSchema.parse({
      semesters: semesters_list,
    });

    return c.json(response);
  });

  // -------------------------------------------------------------------------
  // POST /courses/:courseId/semesters — create semester (superadmin only)
  // -------------------------------------------------------------------------

  router.post(
    '/courses/:courseId/semesters',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    audit('semester.create', 'semester', (c) => (c.var.auditDetail?.id as string) ?? 'unknown'),
    async (c) => {
      const courseId = c.req.param('courseId');

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parseResult = createSemesterRequestSchema.safeParse(body);
      if (!parseResult.success) {
        return c.json(Errors.validation(parseResult.error.issues).toBody(), 400);
      }

      const db = getDb();
      const course = await structureService.getCourse(db, courseId);
      if (!course) {
        throw Errors.notFound();
      }

      try {
        const {
          term,
          year,
          slug,
          display_name,
          filename_convention,
          blob_retention_days,
          derived_retention_days,
        } = parseResult.data;

        const semesterInput: {
          courseId: string;
          term: string;
          year: number;
          slug: string;
          displayName: string;
          filenameConvention: string;
          blobRetentionDays?: number;
          derivedRetentionDays?: number;
        } = {
          courseId,
          term,
          year,
          slug,
          displayName: display_name,
          filenameConvention: filename_convention,
        };

        if (blob_retention_days !== undefined) {
          semesterInput.blobRetentionDays = blob_retention_days;
        }
        if (derived_retention_days !== undefined) {
          semesterInput.derivedRetentionDays = derived_retention_days;
        }

        const semester = await structureService.createSemester(db, semesterInput);

        // Set auditDetail so the audit middleware captures the created entity's UUID.
        c.set('auditDetail', { id: semester.id });

        const response = createSemesterResponseSchema.parse({
          semester: semesterToSemesterDetail(semester),
        });

        return c.json(response, 201);
      } catch (err) {
        // ApiError will be re-thrown from service layer
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId — get semester detail
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId',
    rateLimit('read.detail'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId');
      const principal = c.var.principal!;
      const db = getDb();

      const semester = await structureService.getSemester(db, semesterId, principal);
      if (!semester) {
        throw Errors.notFound();
      }

      const response = getSemesterResponseSchema.parse({
        semester,
      });

      return c.json(response);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /semesters/:semesterId — update semester (semester admin only)
  // -------------------------------------------------------------------------

  router.patch(
    '/semesters/:semesterId',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('semester.update', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId');
      const principal = c.var.principal!;
      const db = getDb();

      // Check if semester is archived (write not allowed)
      const isArchived = await structureService.isArchivedSemester(db, semesterId);
      if (isArchived) {
        // TODO: add RESOURCE_ARCHIVED error code in a future PRD update; using INSUFFICIENT_ROLE as a stand-in per Phase 5 review.
        throw Errors.insufficientRole('admin');
      }

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parseResult = updateSemesterRequestSchema.safeParse(body);
      if (!parseResult.success) {
        return c.json(Errors.validation(parseResult.error.issues).toBody(), 400);
      }

      try {
        const { display_name, filename_convention, blob_retention_days, derived_retention_days } =
          parseResult.data;

        const updateInput: {
          displayName?: string;
          filenameConvention?: string;
          blobRetentionDays?: number;
          derivedRetentionDays?: number;
        } = {};

        if (display_name !== undefined) updateInput.displayName = display_name;
        if (filename_convention !== undefined) updateInput.filenameConvention = filename_convention;
        if (blob_retention_days !== undefined) updateInput.blobRetentionDays = blob_retention_days;
        if (derived_retention_days !== undefined)
          updateInput.derivedRetentionDays = derived_retention_days;

        await structureService.updateSemester(db, semesterId, updateInput);

        const semester = await structureService.getSemester(db, semesterId, principal);
        if (!semester) {
          throw Errors.notFound();
        }

        const response = updateSemesterResponseSchema.parse({
          semester,
        });

        return c.json(response);
      } catch (err) {
        // ApiError will be re-thrown from service layer
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/archive — archive semester (superadmin only)
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/archive',
    rateLimit('write.misc'),
    requireAuth({ action: 'admin', target: 'global' }),
    audit('semester.archive', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId');
      const db = getDb();

      const semester = await structureService.getSemester(db, semesterId);
      if (!semester) {
        throw Errors.notFound();
      }

      await structureService.archiveSemester(db, semesterId);
      return c.body(null, 204);
    },
  );

  return router;
}
