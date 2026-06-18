/**
 * Roster routes (PRD §8.4).
 *
 * GET    /semesters/:semesterId/roster           — list roster entries
 * POST   /semesters/:semesterId/roster:upload    — upload CSV, returns diff preview
 * POST   /semesters/:semesterId/roster:commit    — commit a cached preview
 * PATCH  /semesters/:semesterId/roster/:id       — update a single entry
 *
 * Auth:
 *   GET    — semester member (read)
 *   POST   — semester admin (write)
 *   PATCH  — semester admin (write)
 *
 * Rate:
 *   GET          — read.cohort
 *   POST :upload — write.ingest
 *   POST :commit — write.ingest
 *   PATCH        — write.misc
 */

import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getDb } from '../../../db/client.js';
import { getConfig } from '../../../config/index.js';
import { requireAuth } from '../../middleware/authorize.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import { parseRosterCsv } from '../../../services/roster/parse.js';
import { diffRoster } from '../../../services/roster/diff.js';
import { putPreview, getPreview } from '../../../services/roster/preview-cache.js';
import { commitRoster, listRoster, updateRosterEntry } from '../../../services/roster/index.js';
import { projectStudent, maskEmail, maskExtras } from '../../../services/protect.js';
import { roster_entries } from '../../../db/schema.js';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const commitBodySchema = z.object({
  upload_id: z.string().uuid(),
  accept_deletions: z.boolean(),
});

// sid is immutable — reject if it appears in the body.
const patchEntryBodySchema = z
  .object({
    display_name: z.string().min(1).optional(),
    email: z.string().email().nullable().optional(),
    extras: z.record(z.string(), z.string()).optional(),
  })
  .strict(); // reject unknown fields (including sid)

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createRosterRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/roster — list roster entries
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/roster',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const limitParam = c.req.query('limit');
      const rawLimit = limitParam !== undefined ? parseInt(limitParam, 10) : 50;
      const limit = isNaN(rawLimit) ? 50 : rawLimit;

      const listOpts: Parameters<typeof listRoster>[1] = { semesterId, limit };
      const cursorQ = c.req.query('cursor');
      if (cursorQ !== undefined) listOpts.cursor = cursorQ;
      const q = c.req.query('q');
      if (q !== undefined) listOpts.q = q;

      const result = await listRoster(db, listOpts);
      const protectedMode = requirePrincipal(c).user.protected;

      return c.json({
        entries: result.entries.map((e) => ({
          ...projectStudent(
            {
              id: e.id,
              sid: e.sid,
              display_name: e.display_name,
              protected_index: e.protected_index,
            },
            protectedMode,
          ),
          email: maskEmail(e.email, protectedMode),
          extras: maskExtras(e.extras, protectedMode),
        })),
        next_cursor: result.next_cursor,
        total_count: result.total_count,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/roster:upload — upload CSV, get preview
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/roster:upload',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('roster.upload', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const cfg = getConfig();
      const db = getDb();

      // Content-Length pre-check: reject before buffering the body.
      // This prevents a large upload from allocating memory before the size
      // check fires. The post-parse check (fileField.size) remains as defense-in-depth.
      const contentLengthHeader = c.req.header('content-length');
      if (contentLengthHeader !== undefined) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > cfg.ROSTER_CSV_MAX_BYTES) {
          return c.json(Errors.rosterCsvTooLarge(cfg.ROSTER_CSV_MAX_BYTES).toBody(), 413);
        }
      }

      // Parse multipart body. Hono's parseBody handles multipart.
      let formData: Record<string, unknown>;
      try {
        formData = await c.req.parseBody();
      } catch {
        return c.json(Errors.rosterCsvParse('Failed to parse multipart body').toBody(), 400);
      }

      const fileField = formData['file'];

      if (!(fileField instanceof File)) {
        return c.json(
          Errors.rosterCsvParse('Missing or invalid file field in multipart body').toBody(),
          400,
        );
      }

      // Size check.
      if (fileField.size > cfg.ROSTER_CSV_MAX_BYTES) {
        return c.json(Errors.rosterCsvTooLarge(cfg.ROSTER_CSV_MAX_BYTES).toBody(), 413);
      }

      const csvText = await fileField.text();

      // Parse CSV (may throw ROSTER_CSV_MISSING_REQUIRED_COLUMN).
      let parseResult: ReturnType<typeof parseRosterCsv>;
      try {
        parseResult = parseRosterCsv(csvText);
      } catch (err) {
        // Re-throw ApiError (e.g. missing required column) — global handler picks it up.
        throw err;
      }

      // Load current roster.
      const existing = await db
        .select()
        .from(roster_entries)
        .where(eq(roster_entries.semester_id, semesterId));

      // Compute diff.
      const diff = diffRoster(parseResult.rows, existing);

      // Cache the preview.
      const uploadId = crypto.randomUUID();
      putPreview(uploadId, {
        semesterId,
        toAdd: diff.toAdd,
        toUpdate: diff.toUpdate,
        toDelete: diff.toDelete,
        createdAt: Date.now(),
      });

      return c.json({
        upload_id: uploadId,
        parsed_rows: parseResult.rows.length,
        to_add: diff.toAdd.length,
        to_update: diff.toUpdate.length,
        to_delete: diff.toDelete.length,
        errors: parseResult.errors,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/roster:commit — commit a cached preview
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/roster:commit',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('roster.commit', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parsed = commitBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json(Errors.validation(parsed.error.issues).toBody(), 400);
      }

      const { upload_id, accept_deletions } = parsed.data;

      // Look up the cached preview and verify it belongs to this semester.
      // Using the same 404 for both missing and semester mismatch — do not leak
      // preview existence across semesters.
      const preview = getPreview(upload_id);
      if (preview === null || preview.semesterId !== semesterId) {
        throw Errors.notFound();
      }

      // Commit the roster changes.
      const counts = await commitRoster(db, semesterId, preview, accept_deletions);

      // Attach detail for the audit middleware.
      c.set('auditDetail', { ...counts, accept_deletions });

      return c.json(counts);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /semesters/:semesterId/roster/:rosterEntryId — update entry
  // -------------------------------------------------------------------------

  router.patch(
    '/semesters/:semesterId/roster/:rosterEntryId',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('roster.update_entry', 'roster_entry', (c) => c.req.param('rosterEntryId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const rosterEntryId = c.req.param('rosterEntryId')!;
      const db = getDb();

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parseResult = patchEntryBodySchema.safeParse(body);
      if (!parseResult.success) {
        return c.json(Errors.validation(parseResult.error.issues).toBody(), 400);
      }

      const { display_name, email, extras } = parseResult.data;

      // Build updates object carefully to avoid exactOptionalPropertyTypes issues.
      const entryUpdates: Parameters<typeof updateRosterEntry>[3] = {};
      if (display_name !== undefined) entryUpdates.display_name = display_name;
      // email can be string | null (nullable) or absent; only set if present in body.
      if ('email' in parseResult.data && email !== undefined) {
        // email is string | null here (Zod narrowed it past undefined via the 'in' check)
        entryUpdates.email = email as string | null;
      }
      if (extras !== undefined) entryUpdates.extras = extras;

      const updated = await updateRosterEntry(db, rosterEntryId, semesterId, entryUpdates);

      if (updated === null) {
        throw Errors.notFound();
      }

      return c.json({
        id: updated.id,
        sid: updated.sid,
        display_name: updated.display_name,
        email: updated.email,
        extras: updated.extras,
      });
    },
  );

  return router;
}
