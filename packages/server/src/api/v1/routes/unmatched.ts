/**
 * Unmatched tray routes (PRD §8.7).
 *
 * GET  /semesters/:semesterId/unmatched                — semester member
 * PATCH /semesters/:semesterId/unmatched/:ingestFileId — semester admin
 * POST /semesters/:semesterId/unmatched/:ingestFileId/discard — semester admin
 *
 * Auth:
 *   GET list   — semester member (read)
 *   PATCH      — semester admin (write.ingest)
 *   POST discard — semester admin (write.ingest)
 *
 * Audit:
 *   ingest.unmatched.attach  — on PATCH success
 *   ingest.unmatched.discard — on POST discard success
 *
 * Cursor format:
 *   Opaque base64-encoded JSON `{ ca: isoString, id: uuid }` for stable keyset
 *   pagination that ties on (created_at, id). The `id` tie-breaker prevents
 *   missed rows when multiple files share the same created_at timestamp.
 */

import { Hono } from 'hono';
import { eq, and, or, sql, gt, gte } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { insertAuditRow } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import { ingest_files, ingest_jobs, roster_entries, assignments } from '../../../db/schema.js';
import { createStorageClient, storageConfigFromEnv } from '../../../services/storage/client.js';
import { getConfig } from '../../../config/index.js';
import { getBoss } from '../../../jobs/pg-boss.js';
import { attachUnmatchedFile, getIngestFileSemesterId } from '../../../services/ingest/attach.js';

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  ca: string; // created_at ISO string
  id: string; // ingest_files.id UUID
}

function encodeCursor(createdAt: Date | null, id: string): string {
  const payload: CursorPayload = { ca: createdAt?.toISOString() ?? '', id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(encoded: string): CursorPayload | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['ca'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['id'] === 'string'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IngestFileSummary formatter (reuse the shape from ingest.ts)
// ---------------------------------------------------------------------------

interface RawFileRow {
  id: string;
  original_filename: string;
  size_bytes: number;
  blob_sha256: string;
  status: string;
  matched_student_id: string | null;
  matched_student_sid: string | null;
  matched_student_display_name: string | null;
  matched_assignment_id: string | null;
  matched_assignment_id_str: string | null;
  matched_assignment_label: string | null;
  submission_id: string | null;
  filename_capture: unknown;
  error: unknown;
  created_at: Date | null;
}

function formatFileSummary(row: RawFileRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    original_filename: row.original_filename,
    size_bytes: row.size_bytes,
    blob_sha256: row.blob_sha256,
    status: row.status,
  };

  if (row.matched_student_id !== null) {
    out['matched_student'] = {
      id: row.matched_student_id,
      sid: row.matched_student_sid,
      display_name: row.matched_student_display_name,
    };
  }
  if (row.matched_assignment_id !== null) {
    out['matched_assignment'] = {
      id: row.matched_assignment_id,
      assignment_id_str: row.matched_assignment_id_str,
      label: row.matched_assignment_label,
    };
  }
  if (row.submission_id !== null) {
    out['submission_id'] = row.submission_id;
  }
  if (row.filename_capture !== null && row.filename_capture !== undefined) {
    out['filename_capture'] = row.filename_capture;
  }
  if (row.error !== null && row.error !== undefined) {
    out['error'] = row.error;
  }

  return out;
}

// ---------------------------------------------------------------------------
// File row query helper (with LEFT JOINs for nested objects)
// ---------------------------------------------------------------------------

const FILE_SELECT = {
  id: ingest_files.id,
  original_filename: ingest_files.original_filename,
  size_bytes: ingest_files.size_bytes,
  blob_sha256: ingest_files.blob_sha256,
  status: ingest_files.status,
  matched_student_id: ingest_files.matched_student_id,
  matched_student_sid: roster_entries.sid,
  matched_student_display_name: roster_entries.display_name,
  matched_assignment_id: ingest_files.matched_assignment_id,
  matched_assignment_id_str: assignments.assignment_id_str,
  matched_assignment_label: assignments.label,
  submission_id: ingest_files.submission_id,
  filename_capture: ingest_files.filename_capture,
  error: ingest_files.error,
  created_at: ingest_files.created_at,
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createUnmatchedRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/unmatched
  //
  // Returns paginated unmatched files for the semester. Uses a (created_at, id)
  // compound keyset cursor for stable pagination.
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/unmatched',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 || rawLimit > 200 ? 50 : rawLimit;

      const cursorStr = c.req.query('cursor');
      const cursor = cursorStr !== undefined ? decodeCursor(cursorStr) : null;

      // Build the WHERE clause. We join ingest_files → ingest_jobs to filter
      // by semester_id, then apply the unmatched status filter (which uses the
      // ingest_files_unmatched_idx partial index when status='unmatched').
      //
      // Keyset pagination: (created_at, id) compound cursor.
      //   next page condition:  created_at < cursor.ca
      //                      OR (created_at = cursor.ca AND id < cursor.id)
      // We order by (created_at ASC, id ASC) so the cursor advances forward
      // through older → newer files (ascending chronological order).
      let cursorCondition = undefined;
      if (cursor !== null && cursor.ca !== '') {
        const cursorDate = new Date(cursor.ca);
        if (!isNaN(cursorDate.getTime())) {
          // Files created after the cursor date, or at the same time with a
          // lexicographically larger ID (UUIDs sort lexicographically in Postgres).
          // The cursor stores a millisecond-precision timestamp (JS Date), but
          // Postgres stores timestamptz with microsecond precision.  A row whose
          // DB timestamp is "2026-05-22T12:13:32.770123Z" compares as
          //   created_at > '2026-05-22T12:13:32.770Z'   → TRUE (123µs > 0)
          // which would include the cursor row itself in the next page.
          //
          // Fix: rows after the cursor are those with:
          //   (created_at >= T_next_ms)                  — any row in the next ms or later
          //   OR (created_at >= T_this_ms AND id > cursor.id)  — same ms bucket, later id
          //
          // T_next_ms is T_this_ms + 1 millisecond, so no row in the same ms
          // bucket satisfies the first branch unless it's genuinely in a later ms.
          const nextMs = new Date(cursorDate.getTime() + 1);
          cursorCondition = or(
            gte(ingest_files.created_at, nextMs),
            and(gte(ingest_files.created_at, cursorDate), gt(ingest_files.id, cursor.id)),
          );
        }
      }

      const rows = await db
        .select(FILE_SELECT)
        .from(ingest_files)
        .innerJoin(ingest_jobs, eq(ingest_files.ingest_job_id, ingest_jobs.id))
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(
          and(
            eq(ingest_jobs.semester_id, semesterId),
            eq(ingest_files.status, 'unmatched'),
            cursorCondition,
          ),
        )
        .orderBy(ingest_files.created_at, ingest_files.id)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items.at(-1);
      const nextCursor =
        hasMore && lastItem !== undefined ? encodeCursor(lastItem.created_at, lastItem.id) : null;

      return c.json({
        items: items.map(formatFileSummary),
        next_cursor: nextCursor,
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /semesters/:semesterId/unmatched/:ingestFileId
  //
  // Manually attaches an unmatched file to a (student, assignment).
  // Re-runs phases 5–9: createSubmission + materialize + stats + validation +
  // heuristics. Returns the updated IngestFileSummary + any warnings.
  // -------------------------------------------------------------------------

  router.patch(
    '/semesters/:semesterId/unmatched/:ingestFileId',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const ingestFileId = c.req.param('ingestFileId')!;
      const db = getDb();
      const principal = c.var.principal!;

      // Parse body.
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json(
          Errors.validation([{ field: 'body', issue: 'Invalid JSON body' }]).toBody(),
          400,
        );
      }

      const studentId = body['student_id'];
      const assignmentIdStr = body['assignment_id_str'];

      if (typeof studentId !== 'string' || studentId.trim() === '') {
        return c.json(
          Errors.validation([
            { field: 'student_id', issue: 'Must be a non-empty UUID string' },
          ]).toBody(),
          400,
        );
      }
      if (typeof assignmentIdStr !== 'string' || assignmentIdStr.trim() === '') {
        return c.json(
          Errors.validation([
            { field: 'assignment_id_str', issue: 'Must be a non-empty string' },
          ]).toBody(),
          400,
        );
      }

      // Verify the file belongs to this semester (security: don't let an admin
      // of semester A attach files from semester B).
      const fileSemesterId = await getIngestFileSemesterId(db, ingestFileId);
      if (fileSemesterId === null) {
        return c.json(Errors.notFound().toBody(), 404);
      }
      if (fileSemesterId !== semesterId) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const boss = await getBoss();

      // Call the attach service. It throws typed ApiError on error conditions.
      const attachResult = await attachUnmatchedFile(
        { db, storageClient, boss },
        {
          ingestFileId,
          semesterId,
          studentId: studentId.trim(),
          assignmentIdStr: assignmentIdStr.trim(),
        },
      );

      // Audit log (fire-and-forget).
      const actorUserId = principal.user.id;
      const actorTokenId = principal.principal_kind === 'token' ? principal.token.id : null;
      const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null;
      const userAgent = c.req.header('user-agent') ?? null;
      void insertAuditRow({
        actorUserId,
        actorTokenId,
        semesterId,
        action: 'ingest.unmatched.attach',
        targetType: 'ingest_file',
        targetId: ingestFileId,
        detail: {
          submission_id: attachResult.submissionId,
          student_id: studentId,
          assignment_id_str: assignmentIdStr,
        },
        ip,
        userAgent,
        at: new Date(),
      }).catch(() => {
        /* non-fatal */
      });

      // Fetch the now-matched file row for the response.
      const updatedRows = await db
        .select(FILE_SELECT)
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(eq(ingest_files.id, ingestFileId))
        .limit(1);

      if (updatedRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      return c.json(
        {
          ...formatFileSummary(updatedRows[0]!),
          warnings: attachResult.warnings,
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/unmatched/:ingestFileId/discard
  //
  // Marks the file as 'discarded'. The blob remains until the retention sweep.
  // reason (if provided) is stored in the existing error jsonb column as
  // { discard_reason: string } — reuses the column rather than adding a new one
  // (the column is already defined and flexible; no migration needed).
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/unmatched/:ingestFileId/discard',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const ingestFileId = c.req.param('ingestFileId')!;
      const db = getDb();
      const principal = c.var.principal!;

      // Parse optional reason from body.
      let reason: string | undefined;
      try {
        const body = (await c.req.json()) as Record<string, unknown>;
        if (typeof body['reason'] === 'string' && body['reason'].trim() !== '') {
          reason = body['reason'].trim();
        }
      } catch {
        // Body is optional — empty body or non-JSON is fine.
      }

      // Verify the file belongs to this semester.
      const fileSemesterId = await getIngestFileSemesterId(db, ingestFileId);
      if (fileSemesterId === null) {
        return c.json(Errors.notFound().toBody(), 404);
      }
      if (fileSemesterId !== semesterId) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      // Attempt to transition the file to 'discarded'. We use a conditional
      // UPDATE that only succeeds when status='unmatched', then check rows
      // updated to detect concurrent edits.
      const updateResult = await db
        .update(ingest_files)
        .set({
          status: 'discarded',
          resolved_at: sql`now()`,
          ...(reason !== undefined && { error: { discard_reason: reason } }),
        })
        .where(and(eq(ingest_files.id, ingestFileId), eq(ingest_files.status, 'unmatched')))
        .returning({ id: ingest_files.id, status: ingest_files.status });

      if (updateResult.length === 0) {
        // Either the file was already in a non-unmatched state, or it doesn't
        // exist. Determine which to return the right error.
        const existing = await db
          .select({ status: ingest_files.status })
          .from(ingest_files)
          .where(eq(ingest_files.id, ingestFileId))
          .limit(1);
        if (existing.length === 0) {
          return c.json(Errors.notFound().toBody(), 404);
        }
        // File exists but status !== 'unmatched'.
        throw Errors.ingestFileNotUnmatched(ingestFileId);
      }

      // Audit log (fire-and-forget).
      const actorUserIdDiscard = principal.user.id;
      const actorTokenIdDiscard = principal.principal_kind === 'token' ? principal.token.id : null;
      const ipDiscard = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null;
      const userAgentDiscard = c.req.header('user-agent') ?? null;
      void insertAuditRow({
        actorUserId: actorUserIdDiscard,
        actorTokenId: actorTokenIdDiscard,
        semesterId,
        action: 'ingest.unmatched.discard',
        targetType: 'ingest_file',
        targetId: ingestFileId,
        detail: reason !== undefined ? { reason } : {},
        ip: ipDiscard,
        userAgent: userAgentDiscard,
        at: new Date(),
      }).catch(() => {
        /* non-fatal */
      });

      // Fetch the updated row for the response.
      const updatedRows = await db
        .select(FILE_SELECT)
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(eq(ingest_files.id, ingestFileId))
        .limit(1);

      if (updatedRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      return c.json(formatFileSummary(updatedRows[0]!), 200);
    },
  );

  return router;
}
