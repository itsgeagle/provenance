/**
 * Ingest routes (PRD §8.6).
 *
 * POST   /semesters/:semesterId/ingest                 — multipart upload, 202
 * POST   /semesters/:semesterId/ingest:gradescope       — Gradescope export upload, 202
 * GET    /semesters/:semesterId/ingest/jobs             — paginated job list
 * POST   /semesters/:semesterId/ingest/jobs/:jobId/cancel — cancel a job
 *
 * The ingest:gradescope route is the primary upload path: it accepts the ZIP
 * Gradescope produces from "Download Submissions" (a submission_metadata.yml
 * plus one already-unzipped folder per submission), upserts the roster from the
 * metadata (so no pre-existing roster is required), rebuilds a sealed bundle ZIP
 * per submission, and stages one file per submitter with a match_sid hint so the
 * worker matches by metadata rather than the filename convention.
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
import { eq, and, desc, lt, sql, count } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { getConfig } from '../../../config/index.js';
import { requireAuth } from '../../middleware/authorize.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors, ApiError } from '../errors.js';
import { ingest_jobs, ingest_files, roster_entries, assignments } from '../../../db/schema.js';
import {
  enqueueIngestJob,
  cancelIngestJob,
  failIngestJob,
} from '../../../services/ingest/job-control.js';
import { stageBlob } from '../../../services/ingest/stage-blob.js';
import { createStorageClient, storageConfigFromEnv } from '../../../services/storage/client.js';
import { getBoss, JOB_KINDS } from '../../../jobs/pg-boss.js';
import { recordPhase } from '../../../jobs/ingest-profile.js';
import { parseGradescopeExport } from '../../../services/ingest/gradescope/parse-export.js';
import { upsertRosterFromSubmitters } from '../../../services/ingest/gradescope/upsert-roster.js';
import { projectStudent, maskFilename, protectedLabel } from '../../../services/protect.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Discriminated result from tryExpandZipBundle.
 *
 * - kind='not-zip': the bytes were not a valid zip at all (use `rawBuffer` for staging).
 * - kind='single-zip': valid zip but not a zip-of-zips (use `rawBuffer` for staging).
 * - kind='zip-of-zips': expanded inner entries are in `entries`.
 */
type ExpandResult =
  | { kind: 'not-zip'; rawBuffer: ArrayBuffer }
  | { kind: 'single-zip'; rawBuffer: ArrayBuffer }
  | { kind: 'zip-of-zips'; entries: Array<{ filename: string; data: ArrayBuffer }> };

/**
 * Detect zip-of-zips: a single File named *.zip whose contents are all .zip entries.
 *
 * Accepts a pre-read `rawBuffer` so the caller can pass it to `stageBlob` on
 * the non-zip-of-zips path without a second `arrayBuffer()` call (Important 3).
 *
 * Zip-bomb guard (Critical 2): tracks `totalUncompressed` across all inner
 * entries serially. If the running total exceeds `maxBatchBytes`, throws
 * `Errors.ingestBatchTooLarge` immediately. Only one entry's worth of bytes
 * is held in memory beyond what has already been committed to `entries`.
 */
async function tryExpandZipBundle(
  filename: string,
  rawBuffer: ArrayBuffer,
  maxBundleBytes: number,
  maxBatchBytes: number,
): Promise<ExpandResult> {
  if (!filename.endsWith('.zip')) return { kind: 'not-zip', rawBuffer };

  let outer: JSZip;
  try {
    outer = await JSZip.loadAsync(rawBuffer);
  } catch {
    // Not a valid zip — treat as a regular file.
    return { kind: 'not-zip', rawBuffer };
  }

  const entries = Object.values(outer.files).filter((f) => !f.dir);
  if (entries.length === 0) return { kind: 'single-zip', rawBuffer };

  // Check if ALL entries are .zip files (zip-of-zips convention).
  const allZips = entries.every((e) => e.name.endsWith('.zip'));
  if (!allZips) return { kind: 'single-zip', rawBuffer };

  // Extract each inner zip serially, tracking running uncompressed total.
  // At any point only ONE entry's data is held in memory beyond what's
  // already pushed to `result` — per the zip-bomb guard requirement.
  const result: Array<{ filename: string; data: ArrayBuffer }> = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    const data = await entry.async('arraybuffer');

    // Per-entry size check (kept from original).
    if (data.byteLength > maxBundleBytes) {
      throw Errors.ingestFileTooLarge(maxBundleBytes);
    }

    totalUncompressed += data.byteLength;

    // Running total cap — zip-bomb guard.
    if (totalUncompressed > maxBatchBytes) {
      throw Errors.ingestBatchTooLarge(maxBatchBytes);
    }

    // Use only the filename part, not path components inside the outer archive.
    const entryFilename = entry.name.split('/').at(-1) ?? entry.name;
    result.push({ filename: entryFilename, data });
  }

  return { kind: 'zip-of-zips', entries: result };
}

/**
 * Shape used internally for files to stage.
 */
interface FileToStage {
  filename: string;
  body: ArrayBuffer;
}

// ---------------------------------------------------------------------------
// IngestFileSummary formatter (PRD §8.6)
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
  matched_student_protected_index: number | null;
  matched_assignment_id: string | null;
  matched_assignment_id_str: string | null;
  matched_assignment_label: string | null;
  submission_id: string | null;
  filename_capture: unknown;
  error: unknown;
  created_at: Date | null;
}

/**
 * Map a raw ingest_files row (with joined roster/assignment columns) to the
 * IngestFileSummary shape from PRD §8.6.
 *
 * matched_student and matched_assignment are nested objects when the file was
 * successfully matched, per PRD §8.6.
 */
/**
 * Normalize an `ingest_jobs.summary` jsonb value to the full IngestJobSummary
 * shape required by the analyzer's Zod schema. Jobs that haven't computed
 * stats yet have `summary='{}'` in the DB (column default); the API contract
 * is to always send the 7 fields with 0 defaults so consumers don't have to
 * special-case the partial shape.
 */
function normalizeJobSummary(raw: unknown): {
  total: number;
  matched: number;
  unmatched: number;
  duplicate: number;
  failed: number;
  superseded: number;
  discarded: number;
} {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0);
  return {
    total: num('total'),
    matched: num('matched'),
    unmatched: num('unmatched'),
    duplicate: num('duplicate'),
    failed: num('failed'),
    superseded: num('superseded'),
    discarded: num('discarded'),
  };
}

function formatFileSummary(row: RawFileRow, protectedMode: boolean): Record<string, unknown> {
  const idxLabel =
    row.matched_student_id !== null
      ? protectedLabel(row.matched_student_protected_index, row.matched_student_id)
      : null;
  const out: Record<string, unknown> = {
    id: row.id,
    original_filename: maskFilename(
      row.original_filename,
      protectedMode,
      idxLabel !== null ? `${idxLabel} — file` : `(unmatched file ${row.id.slice(0, 8)})`,
    ),
    size_bytes: row.size_bytes,
    blob_sha256: row.blob_sha256,
    status: row.status,
  };

  if (row.matched_student_id !== null) {
    out['matched_student'] = projectStudent(
      {
        id: row.matched_student_id,
        sid: row.matched_student_sid ?? '',
        display_name: row.matched_student_display_name ?? '',
        protected_index: row.matched_student_protected_index,
      },
      protectedMode,
    );
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
  if (!protectedMode && row.filename_capture !== null && row.filename_capture !== undefined) {
    out['filename_capture'] = row.filename_capture;
  }
  if (row.error !== null && row.error !== undefined) {
    out['error'] = row.error;
  }

  return out;
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
    audit('ingest.start', 'ingest_job', (c) => (c.get('auditDetail')?.['job_id'] as string) ?? ''),
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
          return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(), 413);
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
        return c.json(
          Errors.validation([
            { field: 'multipart', issue: 'Failed to parse multipart body' },
          ]).toBody(),
          400,
        );
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
          Errors.validation([
            { field: 'files', issue: 'No files provided. Use `archive` or `files[]` field.' },
          ]).toBody(),
          400,
        );
      }

      // -----------------------------------------------------------------------
      // Expand zip-of-zips OR collect individual files.
      // Pre-read each File's buffer exactly once (Important 3: no double-buffer).
      // tryExpandZipBundle receives the already-read buffer and returns it on
      // non-zip-of-zips paths so we reuse it for stageBlob.
      // -----------------------------------------------------------------------
      const filesToStage: FileToStage[] = [];

      for (const raw of rawFiles) {
        // Per-file size check (before reading, to fail fast on obvious over-size).
        if (raw.size > cfg.INGEST_MAX_BUNDLE_BYTES) {
          return c.json(Errors.ingestFileTooLarge(cfg.INGEST_MAX_BUNDLE_BYTES).toBody(), 413);
        }

        // Read the buffer exactly once.
        const rawBuffer = await raw.arrayBuffer();

        // Try to expand as zip-of-zips.
        // tryExpandZipBundle enforces per-entry and running-total caps internally
        // (Critical 2 zip-bomb guard). May throw ApiError on violation.
        let expandResult: Awaited<ReturnType<typeof tryExpandZipBundle>>;
        try {
          expandResult = await tryExpandZipBundle(
            raw.name,
            rawBuffer,
            cfg.INGEST_MAX_BUNDLE_BYTES,
            cfg.INGEST_MAX_BATCH_BYTES,
          );
        } catch (err) {
          if (err instanceof ApiError) {
            return c.json(err.toBody(), err.status as 413 | 400);
          }
          throw err;
        }

        if (expandResult.kind === 'zip-of-zips') {
          for (const inner of expandResult.entries) {
            filesToStage.push({ filename: inner.filename, body: inner.data });
          }
        } else {
          // 'not-zip' or 'single-zip': reuse the already-read buffer.
          filesToStage.push({ filename: raw.name, body: expandResult.rawBuffer });
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
      //
      // Critical 1: if staging fails mid-batch, mark the job 'failed' before
      // re-throwing so the row is never left permanently in 'queued'.
      // Any blobs already staged to MinIO on prior iterations become orphans;
      // the retention sweep (Phase 9c) will clean them up.
      // -----------------------------------------------------------------------
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));

      try {
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
      } catch (stagingErr) {
        // Compensation: mark the job failed so it is not permanently 'queued'.
        const detail = stagingErr instanceof Error ? stagingErr.message : String(stagingErr);
        await failIngestJob(db, jobId, detail);
        throw stagingErr;
      }

      // -----------------------------------------------------------------------
      // Enqueue one ingest_file job per staged file.
      //
      // We get the boss after all staging succeeds so any pg-boss connection
      // error doesn't leave files staged without queue entries.
      // -----------------------------------------------------------------------
      const boss = await getBoss();
      const stagedFileIds = await db
        .select({ id: ingest_files.id })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));

      for (const { id: ingestFileId } of stagedFileIds) {
        // PRD §12.3: ingest_file retries up to 3 times on transient failure.
        await boss.send(
          JOB_KINDS.INGEST_FILE,
          { ingestFileId, ingestJobId: jobId },
          { retryLimit: 3 },
        );
      }

      // Set auditDetail so the audit middleware can log job_id as target_id.
      c.set('auditDetail', { job_id: jobId, file_count: filesToStage.length });

      return c.json({ job_id: jobId }, 202);
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/ingest:gradescope
  //
  // Primary upload path. Accepts the ZIP that Gradescope produces from
  // "Download Submissions": a single archive with a submission_metadata.yml and
  // one (already-unzipped) folder per submission. Unlike POST /ingest this does
  // NOT require a pre-existing roster — it populates/upserts the roster from the
  // metadata, then rebuilds and stages one bundle per submitter (group projects
  // → one submission per co-submitter via the match_sid hint).
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/ingest:gradescope',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('ingest.start', 'ingest_job', (c) => (c.get('auditDetail')?.['job_id'] as string) ?? ''),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const cfg = getConfig();
      const db = getDb();
      const principal = c.var.principal!;

      // Content-Length pre-check (reject before buffering).
      const contentLengthHeader = c.req.header('content-length');
      if (contentLengthHeader !== undefined) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > cfg.INGEST_MAX_BATCH_BYTES) {
          return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(), 413);
        }
      }

      // Parse multipart body — expect a single `archive` = the export ZIP.
      let formData: Record<string, unknown>;
      try {
        formData = await c.req.parseBody();
      } catch {
        return c.json(
          Errors.validation([
            { field: 'multipart', issue: 'Failed to parse multipart body' },
          ]).toBody(),
          400,
        );
      }

      const archive = formData['archive'];
      if (!(archive instanceof File)) {
        return c.json(
          Errors.validation([
            { field: 'archive', issue: 'Missing Gradescope export ZIP in `archive` field.' },
          ]).toBody(),
          400,
        );
      }
      if (archive.size > cfg.INGEST_MAX_BATCH_BYTES) {
        return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(), 413);
      }

      // Parse the export: roster submitters + rebuilt bundles + skipped folders.
      const buffer = await archive.arrayBuffer();
      const parseExportStart = performance.now();
      const parsed = await parseGradescopeExport(buffer);
      recordPhase('upload:parse_export', performance.now() - parseExportStart);
      if (!parsed.ok) {
        return c.json(
          Errors.validation([
            {
              field: 'archive',
              issue: `Invalid Gradescope export (${parsed.error}): ${parsed.detail}`,
            },
          ]).toBody(),
          400,
        );
      }

      const { rosterSubmitters, bundles, skipped } = parsed.value;

      // Fan out: one staged file per submitter (co-submitters share blob bytes).
      const toStage: Array<{ folderKey: string; sid: string; body: ArrayBuffer }> = [];
      for (const b of bundles) {
        if (b.bundleZip.byteLength > cfg.INGEST_MAX_BUNDLE_BYTES) {
          return c.json(Errors.ingestFileTooLarge(cfg.INGEST_MAX_BUNDLE_BYTES).toBody(), 413);
        }
        for (const s of b.submitters) {
          toStage.push({ folderKey: b.folderKey, sid: s.sid, body: b.bundleZip });
        }
      }

      if (toStage.length > cfg.INGEST_MAX_BATCH_FILES) {
        return c.json(
          Errors.ingestTooManyFiles(toStage.length, cfg.INGEST_MAX_BATCH_FILES).toBody(),
          400,
        );
      }
      const totalBytes = toStage.reduce((acc, f) => acc + f.body.byteLength, 0);
      if (totalBytes > cfg.INGEST_MAX_BATCH_BYTES) {
        return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(), 413);
      }

      // Populate/upsert the roster from the metadata (add/update, never delete).
      const roster = await upsertRosterFromSubmitters(db, semesterId, rosterSubmitters);

      const skippedSummary = skipped.map((s) => ({ folder_key: s.folderKey, reason: s.reason }));

      // No bundles to process (roster-only export, or all folders skipped):
      // the roster is upserted but there is no ingest job to create.
      if (toStage.length === 0) {
        c.set('auditDetail', { roster_added: roster.added, roster_updated: roster.updated });
        return c.json(
          {
            job_id: null,
            roster,
            bundles_processed: 0,
            submissions_queued: 0,
            skipped: skippedSummary,
          },
          200,
        );
      }

      // Create the ingest job and stage one bundle per submitter.
      const { jobId } = await enqueueIngestJob(db, semesterId, principal.user.id);
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));

      const stageBlobsStart = performance.now();
      try {
        for (const f of toStage) {
          const fileId = crypto.randomUUID();
          const { blobSha256, sizeBytes } = await stageBlob(
            { storageClient },
            { jobId, ingestFileId: fileId, body: f.body },
          );
          await db.insert(ingest_files).values({
            id: fileId,
            ingest_job_id: jobId,
            original_filename: `${f.folderKey}.zip`,
            size_bytes: sizeBytes,
            blob_sha256: blobSha256,
            status: 'pending',
            match_sid: f.sid,
          });
        }
      } catch (stagingErr) {
        const detail = stagingErr instanceof Error ? stagingErr.message : String(stagingErr);
        await failIngestJob(db, jobId, detail);
        throw stagingErr;
      }

      recordPhase('upload:stage_blobs', performance.now() - stageBlobsStart);

      const boss = await getBoss();
      const stagedFileIds = await db
        .select({ id: ingest_files.id })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));

      const enqueueStart = performance.now();
      for (const { id: ingestFileId } of stagedFileIds) {
        await boss.send(
          JOB_KINDS.INGEST_FILE,
          { ingestFileId, ingestJobId: jobId },
          { retryLimit: 3 },
        );
      }
      recordPhase('upload:enqueue', performance.now() - enqueueStart);

      c.set('auditDetail', { job_id: jobId, file_count: toStage.length });

      return c.json(
        {
          job_id: jobId,
          roster,
          bundles_processed: bundles.length,
          submissions_queued: toStage.length,
          skipped: skippedSummary,
        },
        202,
      );
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
            statusFilter !== undefined ? eq(ingest_jobs.status, statusFilter) : undefined,
            cursorDate !== null ? lt(ingest_jobs.created_at, cursorDate) : undefined,
          ),
        )
        .orderBy(desc(ingest_jobs.created_at))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? (items.at(-1)?.created_at?.toISOString() ?? null) : null;

      return c.json({
        items: items.map((r) => ({
          id: r.id,
          semester_id: r.semester_id,
          status: r.status,
          summary: normalizeJobSummary(r.summary),
          created_at: r.created_at?.toISOString() ?? null,
          started_at: r.started_at?.toISOString() ?? null,
          completed_at: r.completed_at?.toISOString() ?? null,
        })),
        next_cursor: nextCursor,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/ingest/jobs/:jobId
  // -------------------------------------------------------------------------
  // PRD §8.6: returns job detail with summary counts + first 200 files inline.

  router.get(
    '/semesters/:semesterId/ingest/jobs/:jobId',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const jobId = c.req.param('jobId')!;
      const db = getDb();

      const jobRows = await db
        .select()
        .from(ingest_jobs)
        .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.semester_id, semesterId)));

      if (jobRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const job = jobRows[0]!;

      // Compute summary counts from ingest_files.
      const fileStatusCounts = await db
        .select({ status: ingest_files.status, cnt: count() })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId))
        .groupBy(ingest_files.status);

      const summary: {
        total: number;
        matched: number;
        unmatched: number;
        duplicate: number;
        failed: number;
        superseded: number;
        discarded: number;
      } = {
        total: 0,
        matched: 0,
        unmatched: 0,
        duplicate: 0,
        failed: 0,
        superseded: 0,
        discarded: 0,
      };

      for (const row of fileStatusCounts) {
        const s = row.status as keyof typeof summary;
        if (s in summary && s !== 'total') {
          (summary as Record<string, number>)[s] = row.cnt;
        }
        summary.total += row.cnt;
      }

      // Fetch first 200 files inline, joining roster_entries and assignments for
      // the nested matched_student / matched_assignment objects (PRD §8.6).
      const fileRows = await db
        .select({
          id: ingest_files.id,
          original_filename: ingest_files.original_filename,
          size_bytes: ingest_files.size_bytes,
          blob_sha256: ingest_files.blob_sha256,
          status: ingest_files.status,
          matched_student_id: ingest_files.matched_student_id,
          matched_student_sid: roster_entries.sid,
          matched_student_display_name: roster_entries.display_name,
          matched_student_protected_index: roster_entries.protected_index,
          matched_assignment_id: ingest_files.matched_assignment_id,
          matched_assignment_id_str: assignments.assignment_id_str,
          matched_assignment_label: assignments.label,
          submission_id: ingest_files.submission_id,
          filename_capture: ingest_files.filename_capture,
          error: ingest_files.error,
          created_at: ingest_files.created_at,
        })
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(eq(ingest_files.ingest_job_id, jobId))
        .orderBy(ingest_files.created_at)
        .limit(200);

      const jobDetailProtectedMode = requirePrincipal(c).user.protected;
      return c.json({
        id: job.id,
        semester_id: job.semester_id,
        status: job.status,
        created_at: job.created_at?.toISOString() ?? null,
        started_at: job.started_at?.toISOString() ?? null,
        completed_at: job.completed_at?.toISOString() ?? null,
        summary,
        files: fileRows.map((row) => formatFileSummary(row, jobDetailProtectedMode)),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/ingest/jobs/:jobId/files
  // -------------------------------------------------------------------------
  // PRD §8.6: paginated full file list.

  router.get(
    '/semesters/:semesterId/ingest/jobs/:jobId/files',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const jobId = c.req.param('jobId')!;
      const db = getDb();

      // Verify job exists in this semester.
      const jobRows = await db
        .select({ id: ingest_jobs.id })
        .from(ingest_jobs)
        .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.semester_id, semesterId)));

      if (jobRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 || rawLimit > 200 ? 50 : rawLimit;

      const cursorStr = c.req.query('cursor');
      let cursorDate: Date | null = null;
      if (cursorStr !== undefined) {
        const parsed = new Date(cursorStr);
        if (!isNaN(parsed.getTime())) {
          cursorDate = parsed;
        }
      }

      const fileRows = await db
        .select({
          id: ingest_files.id,
          original_filename: ingest_files.original_filename,
          size_bytes: ingest_files.size_bytes,
          blob_sha256: ingest_files.blob_sha256,
          status: ingest_files.status,
          matched_student_id: ingest_files.matched_student_id,
          matched_student_sid: roster_entries.sid,
          matched_student_display_name: roster_entries.display_name,
          matched_student_protected_index: roster_entries.protected_index,
          matched_assignment_id: ingest_files.matched_assignment_id,
          matched_assignment_id_str: assignments.assignment_id_str,
          matched_assignment_label: assignments.label,
          submission_id: ingest_files.submission_id,
          filename_capture: ingest_files.filename_capture,
          error: ingest_files.error,
          created_at: ingest_files.created_at,
        })
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(
          and(
            eq(ingest_files.ingest_job_id, jobId),
            cursorDate !== null ? lt(ingest_files.created_at, cursorDate) : undefined,
          ),
        )
        .orderBy(ingest_files.created_at)
        .limit(limit + 1);

      const hasMore = fileRows.length > limit;
      const items = hasMore ? fileRows.slice(0, limit) : fileRows;
      const nextCursor = hasMore ? (items.at(-1)?.created_at?.toISOString() ?? null) : null;

      const filesListProtectedMode = requirePrincipal(c).user.protected;
      return c.json({
        items: items.map((row) => formatFileSummary(row, filesListProtectedMode)),
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

      const result = await cancelIngestJob(db, jobId, semesterId);

      // Return 202 for both real cancellations and idempotent no-ops (already
      // cancelled). Include the discriminated fields so callers can tell them
      // apart without a follow-up GET.
      return c.json(
        {
          ok: true,
          cancelled: result.cancelled,
          previous_status: result.previous_status,
        },
        202,
      );
    },
  );

  return router;
}
