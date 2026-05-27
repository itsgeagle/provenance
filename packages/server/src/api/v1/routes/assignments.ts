/**
 * Assignment update route — PRD §8.5.
 *
 * PATCH /api/v1/semesters/:semesterId/assignments/:assignmentId
 *
 * Auth:  semester admin (action='write', target=semester).
 * Audit: 'assignment.update' on the assignment id.
 *
 * Body: { label?: string, sort_order?: number } — at least one required.
 *
 * Returns: { assignment: AssignmentSummary } so the UI can patch in-place.
 *
 * 404 covers both "assignment id unknown" and "assignment id belongs to a
 * different semester than the path :semesterId" — we never want a write to a
 * sibling course's row to succeed because the caller has admin rights on a
 * different semester within the same course.
 *
 * GET /:semesterId/assignments stays in cohort.ts; that endpoint is read-heavy
 * (joins to submissions stats) and groups naturally with the cohort list.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireAuth } from '../../middleware/authorize.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import {
  UpdateAssignmentRequestSchema,
  UpdateAssignmentResponseSchema,
} from '@provenance/shared/api-schemas';
import * as assignmentService from '../../../services/cohort/assignments.js';

export function createAssignmentsRouter(): Hono {
  const router = new Hono();

  router.patch(
    '/semesters/:semesterId/assignments/:assignmentId',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('assignment.update', 'assignment', (c) => c.req.param('assignmentId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const assignmentId = c.req.param('assignmentId')!;

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parsed = UpdateAssignmentRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(Errors.validation(parsed.error.issues).toBody(), 400);
      }

      const db = getDb();
      const updateInput: { label?: string; sort_order?: number } = {};
      if (parsed.data.label !== undefined) updateInput.label = parsed.data.label;
      if (parsed.data.sort_order !== undefined) updateInput.sort_order = parsed.data.sort_order;

      const updated = await assignmentService.updateAssignment(
        db,
        semesterId,
        assignmentId,
        updateInput,
      );

      const response = UpdateAssignmentResponseSchema.parse({ assignment: updated });
      return c.json(response);
    },
  );

  return router;
}
