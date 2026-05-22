/**
 * Ingest routes (PRD §8.6).
 *
 * POST   /semesters/:semesterId/ingest                 — multipart upload, 202
 * GET    /semesters/:semesterId/ingest/jobs             — paginated job list
 * POST   /semesters/:semesterId/ingest/jobs/:jobId/cancel — cancel a job
 *
 * Phase 9a scope:
 *   - Stage each file to MinIO, create ingest_files rows with status='pending'.
 *   - Do NOT parse or match — that is Phase 9b.
 *   - zip-of-zips: expand the outer archive; stage each inner .zip.
 *   - Enforce INGEST_MAX_BUNDLE_BYTES, INGEST_MAX_BATCH_BYTES,
 *     INGEST_MAX_BATCH_FILES, ROSTER_REQUIRED.
 *
 * Auth:
 *   POST /ingest    — semester admin (write)
 *   GET  /jobs      — semester member (read)
 *   POST /jobs/cancel — semester admin (write)
 *
 * Audit:
 *   ingest.start   — on POST /ingest success
 *   ingest.cancel  — on POST /jobs/:jobId/cancel success
 */

import { Hono } from 'hono';
import JSZip from 'jszip';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { getConfig } from '../../../config/index.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import { ingest_jobs, ingest_files, roster_entries } from '../../../db/schema.js';
import { enqueueIngestJob, cancelIngestJob } from '../../../services/ingest/job-control.js';
import { stageBlob } from '../../../services/ingest/stage-blob.js';
import { createStorageClient, storageConfigFromEnv } from '../../../services/storage/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect zip-of-zips: a single File named *.zip whose contents are all .zip entries.
 * Returns the inner zip entries as { filename, data } pairs, or null if not a zip-of-zips.
 */
async function tryExpandZipBundle(
  file: File,
): Promise<Array<{ filename: string; data: ArrayBuffer }> | null> {
  if (!file.name.endsWith('.zip')) return null;

  let outer: JSZip;
  try {
    const bytes = await file.arrayBuffer();
    outer = await JSZip.loadAsync(bytes);
  } catch {
    // Not a valid zip — treat as a regular file.
    return null;
  }

  const entries = Object.values(outer.files).filter((f) => !f.dir);
  if (entries.length === 0) return null;

  // Check if ALL entries are .zip files (zip-of-zips convention).
  const allZips = entries.every((e) => e.name.endsWith('.zip'));
  if (!allZips) return null;

  // Extract each inner zip.
  const result: Array<{ filename: string; data: ArrayBuffer }> = [];
  for (const entry of entries) {
    const data = await entry.async('arraybuffer');
    // Use only the filename part, not path components inside the outer archive.
    const filename = entry.name.split('/').at(-1) ?? entry.name;
    result.push({ filename, data });
  }
  return result;
}

/**
 * Shape used internally for files to stage.
 */
interface FileToStage {
  filename: string;
  body: ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createIngestRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/ingest
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/ingest',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('ingest.start', 'ingest_job', (c) => c.get('auditDetail')?.['job_id'] as string ?? ''),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const cfg = getConfig();
      const db = getDb();
      const principal = c.var.principal!;

      // -----------------------------------------------------------------------
      // Content-Length pre-check (V20 lesson: reject before buffering).
      // -----------------------------------------------------------------------
      const contentLengthHeader = c.req.header('content-length');
      if (contentLengthHeader !== undefined) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > cfg.INGEST_MAX_BATCH_BYTES) {
          return c.json(
            Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(),
            413,
          );
        }
      }

      // -----------------------------------------------------------------------
      // ROSTER_REQUIRED: reject if semester has no roster entries yet.
      // -----------------------------------------------------------------------
      const rosterCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(roster_entries)
        .where(eq(roster_entries.semester_id, semesterId));

      if ((rosterCount[0]?.count ?? 0) === 0) {
        return c.json(Errors.rosterRequired().toBody(), 422);
      }

      // -----------------------------------------------------------------------
      // Parse multipart body.
      // -----------------------------------------------------------------------
      let formData: Record<string, unknown>;
      try {
        formData = await c.req.parseBody({ all: true });
      } catch {
        return c.json(Errors.validation([{ field: 'multipart', issue: 'Failed to parse multipart body' }]).toBody(), 400);
      }

      // Collect files: either `files[]` (array) or a single `archive`.
      const rawFiles: File[] = [];

      const archive = formData['archive'];
      const filesField = formData['files[]'];

      if (archive instanceof File) {
        rawFiles.push(archive);
      } else if (Array.isArray(filesField)) {
        for (const f of filesField) {
          if (f instanceof File) rawFiles.push(f);
        }
      } else if (filesField instanceof File) {
        rawFiles.push(filesField);
      }

      if (rawFiles.length === 0) {
        return c.json(
          Errors.validation([{ field: 'files', issue: 'No files provided. Use `archive` or `files[]` field.' }]).toBody(),
          400,
        );
      }

      // -----------------------------------------------------------------------
      // Expand zip-of-zips OR collect individual files.
      // -----------------------------------------------------------------------
      const filesToStage: FileToStage[] = [];

      for (const raw of rawFiles) {
        // Per-file size check.
        if (raw.size > cfg.INGEST_MAX_BUNDLE_BYTES) {
          return c.json(Errors.ingestFileTooLarge(cfg.INGEST_MAX_BUNDLE_BYTES).toBody(), 413);
        }

        // Try to expand as zip-of-zips.
        const expanded = await tryExpandZipBundle(raw);
        if (expanded !== null) {
          for (const inner of expanded) {
            if (inner.data.byteLength > cfg.INGEST_MAX_BUNDLE_BYTES) {
              return c.json(Errors.ingestFileTooLarge(cfg.INGEST_MAX_BUNDLE_BYTES).toBody(), 413);
            }
            filesToStage.push({ filename: inner.filename, body: inner.data });
          }
        } else {
          filesToStage.push({ filename: raw.name, body: await raw.arrayBuffer() });
        }
      }

      // File count check (after expansion).
      if (filesToStage.length > cfg.INGEST_MAX_BATCH_FILES) {
        return c.json(
          Errors.ingestTooManyFiles(filesToStage.length, cfg.INGEST_MAX_BATCH_FILES).toBody(),
          400,
        );
      }

      // Batch size check (after expansion, summing sizes).
      const totalBytes = filesToStage.reduce((acc, f) => acc + f.body.byteLength, 0);
      if (totalBytes > cfg.INGEST_MAX_BATCH_BYTES) {
        return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(), 413);
      }

      // -----------------------------------------------------------------------
      // Create the ingest_jobs row.
      // -----------------------------------------------------------------------
      const { jobId } = await enqueueIngestJob(db, semesterId, principal.user.id);

      // -----------------------------------------------------------------------
      // Stage each file and create ingest_files rows.
      // -----------------------------------------------------------------------
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));

      for (const file of filesToStage) {
        // Pre-allocate a UUID for the ingest_files row so we can build the
        // staging key before the DB insert.
        const fileId = crypto.randomUUID();

        const { blobSha256, sizeBytes } = await stageBlob(
          { storageClient },
          {
            jobId,
            ingestFileId: fileId,
            body: file.body,
          },
        );

        // Insert the ingest_files row with status='pending'.
        await db.insert(ingest_files).values({
          id: fileId,
          ingest_job_id: jobId,
          original_filename: file.filename,
          size_bytes: sizeBytes,
          blob_sha256: blobSha256,
          status: 'pending',
        });
      }

      // Set auditDetail so the audit middleware can log job_id as target_id.
      c.set('auditDetail', { job_id: jobId, file_count: filesToStage.length });

      return c.json({ job_id: jobId }, 202);
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/ingest/jobs
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/ingest/jobs',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const rawLimit = parseInt(c.req.query('limit') ?? '20', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 || rawLimit > 100 ? 20 : rawLimit;

      const statusFilter = c.req.query('status');
      const cursorStr = c.req.query('cursor');

      // Decode cursor: ISO timestamp for keyset pagination on created_at DESC.
      let cursorDate: Date | null = null;
      if (cursorStr !== undefined) {
        const parsed = new Date(cursorStr);
        if (!isNaN(parsed.getTime())) {
          cursorDate = parsed;
        }
      }

      // Build query with keyset pagination.
      const rows = await db
        .select({
          id: ingest_jobs.id,
          semester_id: ingest_jobs.semester_id,
          status: ingest_jobs.status,
          summary: ingest_jobs.summary,
          created_at: ingest_jobs.created_at,
          started_at: ingest_jobs.started_at,
          completed_at: ingest_jobs.completed_at,
          uploaded_by: ingest_jobs.uploaded_by,
        })
        .from(ingest_jobs)
        .where(
          and(
            eq(ingest_jobs.semester_id, semesterId),
            statusFilter !== undefined
              ? eq(ingest_jobs.status, statusFilter)
              : undefined,
            cursorDate !== null ? lt(ingest_jobs.created_at, cursorDate) : undefined,
          ),
        )
        .orderBy(desc(ingest_jobs.created_at))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items.at(-1)?.created_at?.toISOString() ?? null : null;

      return c.json({
        items: items.map((r) => ({
          id: r.id,
          semester_id: r.semester_id,
          status: r.status,
          summary: r.summary,
          created_at: r.created_at?.toISOString() ?? null,
          started_at: r.started_at?.toISOString() ?? null,
          completed_at: r.completed_at?.toISOString() ?? null,
        })),
        next_cursor: nextCursor,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/ingest/jobs/:jobId/cancel
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/ingest/jobs/:jobId/cancel',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('ingest.cancel', 'ingest_job', (c) => c.req.param('jobId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const jobId = c.req.param('jobId')!;
      const db = getDb();

      await cancelIngestJob(db, jobId, semesterId);

      return c.json({ ok: true }, 202);
    },
  );

  return router;
}
