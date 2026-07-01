/**
 * Per-submission events routes — Phase 17 (PRD §8.9).
 *
 * GET /submissions/:submissionId/events        — paginated event query
 * GET /submissions/:submissionId/events/:seq   — single event by seq
 *
 * Auth: read on the submission's semester (inline auth; same pattern as
 * submissions.ts — derive semesterId from row, then authorize).
 *
 * Rate: read.detail (PRD §8.9 line 1185 — events endpoint).
 *
 * Audit: reads NOT logged per PRD §13.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors } from '../errors.js';
import { authorize } from '../../../auth/authorize.js';
import { findMembership } from '../../../auth/membership-cache.js';
import { resolveSemesterFromSubmission } from '../../../services/submissions/resolve.js';
import { getStorageClient } from '../../../services/storage/default-client.js';
import {
  queryEvents,
  getEventBySeq,
  decodeEventCursor,
  type EventQueryParams,
} from '../../../services/events/query.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createEventsRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/events
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/events', rateLimit('read.detail'), async (c) => {
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

    // Parse query params
    const params: EventQueryParams = {};

    // kind — repeated key
    const kindParam = c.req.queries('kind');
    if (kindParam && kindParam.length > 0) params.kind = kindParam;

    const seqFromStr = c.req.query('seq_from');
    if (seqFromStr !== undefined) {
      const n = parseInt(seqFromStr, 10);
      if (!isNaN(n)) params.seq_from = n;
    }

    const seqToStr = c.req.query('seq_to');
    if (seqToStr !== undefined) {
      const n = parseInt(seqToStr, 10);
      if (!isNaN(n)) params.seq_to = n;
    }

    const tFromStr = c.req.query('t_from');
    if (tFromStr !== undefined) {
      const n = parseInt(tFromStr, 10);
      if (!isNaN(n)) params.t_from = n;
    }

    const tToStr = c.req.query('t_to');
    if (tToStr !== undefined) {
      const n = parseInt(tToStr, 10);
      if (!isNaN(n)) params.t_to = n;
    }

    const wallFrom = c.req.query('wall_from');
    if (wallFrom !== undefined) params.wall_from = wallFrom;

    const wallTo = c.req.query('wall_to');
    if (wallTo !== undefined) params.wall_to = wallTo;

    const file = c.req.query('file');
    if (file !== undefined) params.file = file;

    const sessionId = c.req.query('session_id');
    if (sessionId !== undefined) params.session_id = sessionId;

    const order = c.req.query('order');
    if (order === 'seq_asc' || order === 'seq_desc') {
      params.order = order;
    } else if (order !== undefined) {
      return c.json(
        Errors.validation([{ field: 'order', issue: 'Must be seq_asc or seq_desc' }]).toBody(),
        400,
      );
    }

    const cursorStr = c.req.query('cursor');
    if (cursorStr !== undefined) {
      const decoded = decodeEventCursor(cursorStr);
      if (decoded === null) {
        return c.json(
          Errors.validation([{ field: 'cursor', issue: 'Invalid cursor' }]).toBody(),
          400,
        );
      }
      params.cursor = cursorStr;
    }

    const limitStr = c.req.query('limit');
    if (limitStr !== undefined) {
      const n = parseInt(limitStr, 10);
      if (isNaN(n) || n < 1) {
        return c.json(
          Errors.validation([{ field: 'limit', issue: 'Must be a positive integer' }]).toBody(),
          400,
        );
      }
      params.limit = n;
    }

    // queryEvents throws ApiError on invalid ranges or limit exceeded
    const storage = getStorageClient();
    const result = await queryEvents(db, storage, submissionId, params);

    return c.json(result);
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/events/:seq
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/events/:seq', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const seqStr = c.req.param('seq')!;
    const db = getDb();

    const seq = parseInt(seqStr, 10);
    if (isNaN(seq)) {
      return c.json(
        Errors.validation([{ field: 'seq', issue: 'Must be an integer' }]).toBody(),
        400,
      );
    }

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

    const storage = getStorageClient();
    const event = await getEventBySeq(db, storage, submissionId, seq);
    if (event === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    return c.json(event);
  });

  return router;
}
