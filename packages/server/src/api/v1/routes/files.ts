/**
 * File content and provenance routes — Phase 18 (PRD §8.9).
 *
 * GET /submissions/:submissionId/files/:path{.+}/content
 * GET /submissions/:submissionId/files/:path{.+}/provenance
 *
 * The `:path{.+}` Hono syntax captures multi-segment file paths
 * (e.g. `src/utils/foo.py`) into a named `path` parameter via the inline
 * regex `{.+}`. The decoded value equals the per_file_stats.file_path string.
 *
 * Auth: read on the submission's semester. Inline auth — same pattern as
 * submissions.ts (V34 / V35): derive semesterId post-fetch, return 404 on
 * membership failure (avoids existence leaks).
 *
 * Rate: read.detail (PRD §8.9).
 *
 * Cache-Control: max-age=60, private (PRD §8.9 line 1227).
 *
 * Error semantics:
 *   - FILE_NOT_FOUND (404)        — path not in per_file_stats
 *   - FILE_RECONSTRUCTION_TAINTED — 200 with content:"" + warning field
 */

import { Hono } from 'hono';
import { and, eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors, Warnings } from '../errors.js';
import { authorize } from '../../../auth/authorize.js';
import { findMembership } from '../../../auth/membership-cache.js';
import { resolveSemesterFromSubmission } from '../../../services/submissions/resolve.js';
import { reconstructFile } from '../../../services/reconstruction.js';
import { encodeRle } from '../../../services/provenance-rle.js';
import { events } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the last `doc.save` event's seq for a given submission + file path.
 * Falls back to the last event's seq overall if no doc.save exists for the file.
 * Returns undefined if there are no events at all for the submission.
 *
 * The file path filter uses `payload->>'path'` — same JSONB pattern as the
 * events query builder (V35). No covering index; acceptable at per-submission
 * scale (~10k events).
 */
async function resolveDefaultAtSeq(
  db: DrizzleDb,
  submissionId: string,
  filePath: string,
): Promise<number | undefined> {
  const saveResult = await db
    .select({ seq: events.seq })
    .from(events)
    .where(
      and(
        eq(events.submission_id, submissionId),
        eq(events.kind, 'doc.save'),
        sql`${events.payload}->>'path' = ${filePath}`,
      ),
    )
    .orderBy(desc(events.seq))
    .limit(1);

  if (saveResult.length > 0) {
    return saveResult[0]!.seq;
  }

  // No doc.save for this file — fall back to the last event seq overall.
  const lastEvent = await db
    .select({ seq: events.seq })
    .from(events)
    .where(eq(events.submission_id, submissionId))
    .orderBy(desc(events.seq))
    .limit(1);

  return lastEvent[0]?.seq;
}

/**
 * Parse the `at_seq` query parameter. Returns the parsed integer, undefined
 * if not present, or a validation error message if invalid.
 */
function parseAtSeq(raw: string | undefined): { value: number | undefined } | { error: string } {
  if (raw === undefined) return { value: undefined };
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) {
    return { error: 'at_seq must be a non-negative integer' };
  }
  return { value: parsed };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createFilesRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/files/:path{.+}/content
  // -------------------------------------------------------------------------

  router.get(
    '/submissions/:submissionId/files/:path{.+}/content',
    rateLimit('read.detail'),
    async (c) => {
      const submissionId = c.req.param('submissionId')!;
      const filePath = decodeURIComponent(c.req.param('path')!);
      const db = getDb();

      // Inline auth (V34 / V35 pattern).
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

      // Parse at_seq query param.
      const atSeqParsed = parseAtSeq(c.req.query('at_seq'));
      if ('error' in atSeqParsed) {
        return c.json(
          Errors.validation([{ path: 'at_seq', message: atSeqParsed.error }]).toBody(),
          400,
        );
      }

      // Resolve default atSeq (last doc.save, or last event) if not supplied.
      const atSeq =
        atSeqParsed.value !== undefined
          ? atSeqParsed.value
          : await resolveDefaultAtSeq(db, submissionId, filePath);

      let result;
      try {
        result = await reconstructFile(db, submissionId, filePath, atSeq);
      } catch (err: unknown) {
        const e = err as Record<string, unknown>;
        if (e['code'] === 'FILE_NOT_FOUND') {
          return c.json(Errors.fileNotFound(filePath).toBody(), 404);
        }
        throw err;
      }

      c.header('Cache-Control', 'max-age=60, private');

      // Tainted file: PRD §8.9 line 1228 — return 200 with content:"" + warning.
      if (result.tainted) {
        return c.json({
          submission_id: submissionId,
          path: filePath,
          at_seq: atSeq ?? null,
          content: '',
          computed_at_ms: result.computedAtMs,
          ...Warnings.fileReconstructionTainted(filePath, 'reconstruction tainted'),
        });
      }

      return c.json({
        submission_id: submissionId,
        path: filePath,
        at_seq: atSeq ?? null,
        content: result.content,
        computed_at_ms: result.computedAtMs,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/files/:path{.+}/provenance
  // -------------------------------------------------------------------------

  router.get(
    '/submissions/:submissionId/files/:path{.+}/provenance',
    rateLimit('read.detail'),
    async (c) => {
      const submissionId = c.req.param('submissionId')!;
      const filePath = decodeURIComponent(c.req.param('path')!);
      const db = getDb();

      // Inline auth.
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

      // Parse at_seq.
      const atSeqParsed = parseAtSeq(c.req.query('at_seq'));
      if ('error' in atSeqParsed) {
        return c.json(
          Errors.validation([{ path: 'at_seq', message: atSeqParsed.error }]).toBody(),
          400,
        );
      }

      const atSeq =
        atSeqParsed.value !== undefined
          ? atSeqParsed.value
          : await resolveDefaultAtSeq(db, submissionId, filePath);

      let result;
      try {
        result = await reconstructFile(db, submissionId, filePath, atSeq);
      } catch (err: unknown) {
        const e = err as Record<string, unknown>;
        if (e['code'] === 'FILE_NOT_FOUND') {
          return c.json(Errors.fileNotFound(filePath).toBody(), 404);
        }
        throw err;
      }

      c.header('Cache-Control', 'max-age=60, private');

      const provenanceRuns = encodeRle(result.provenance, result.kindByGlobalIdx);

      return c.json({
        submission_id: submissionId,
        path: filePath,
        at_seq: atSeq ?? null,
        length: result.content.length,
        provenance: provenanceRuns,
      });
    },
  );

  return router;
}
