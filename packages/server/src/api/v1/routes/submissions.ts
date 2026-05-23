/**
 * Per-submission routes — Phase 17 (PRD §8.9).
 *
 * GET /submissions/:submissionId/summary    — full summary
 * GET /submissions/:submissionId/flags      — flag list
 * GET /submissions/:submissionId/stats      — per-file + aggregate stats
 * GET /submissions/:submissionId/validation — validation results
 * GET /submissions/:submissionId/files      — file list (path + length + saves)
 *
 * Auth: read on the submission's semester. All routes use inline auth (the
 * semester_id is derived from the submission row, so requireAuth middleware
 * cannot be used — semesterId unknown until after the DB fetch).
 *
 * Pattern: same as cross-flags detail (V34). Derive semester from row, then
 * call authorize() manually. Return 404 (not 403) on membership failure to
 * avoid leaking submission existence to non-members.
 *
 * Rate: read.detail (PRD §8.9).
 *
 * Audit: reads are NOT logged per PRD §13 cohort-read convention.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors } from '../errors.js';
import { authorize } from '../../../auth/authorize.js';
import { findMembership } from '../../../auth/membership-cache.js';
import { resolveSemesterFromSubmission } from '../../../services/submissions/resolve.js';
import { getSubmissionSummary } from '../../../services/submissions/summary.js';
import { getSubmissionFlags } from '../../../services/submissions/flags.js';
import { getSubmissionStats } from '../../../services/submissions/stats.js';
import { getSubmissionValidation } from '../../../services/submissions/validation.js';
import { getSubmissionFiles } from '../../../services/submissions/files.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSubmissionsRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/summary
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/summary', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const summary = await getSubmissionSummary(db, submissionId);
    if (summary === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    return c.json(summary);
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/flags
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/flags', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const flags = await getSubmissionFlags(db, submissionId);
    return c.json({ flags });
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/stats
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/stats', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const stats = await getSubmissionStats(db, submissionId);
    return c.json(stats);
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/validation
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/validation', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const validation = await getSubmissionValidation(db, submissionId);
    if (validation === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    return c.json(validation);
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/files
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/files', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const files = await getSubmissionFiles(db, submissionId);
    return c.json({ files });
  });

  return router;
}
