/**
 * Local-path ingest: ingest a Gradescope export ZIP that already lives on the
 * server's own disk, reading it via a random-access streaming reader so a
 * multi-GB (10 GB+) export is processed with bounded memory.
 *
 * This is the disk-side counterpart to the HTTP `:gradescope` route. The route
 * buffers the whole upload in memory (and trips a ~2 GiB FormData ceiling);
 * this path never holds more than one rebuilt bundle at a time. It otherwise
 * reuses the exact same downstream pipeline — roster upsert → stage blob →
 * `ingest_files` row → enqueue one `ingest_file` job per submitter — so the
 * worker processes locally-ingested submissions identically to uploaded ones.
 *
 * Deliberately does NOT enforce INGEST_MAX_BATCH_BYTES (the total-size cap that
 * exists to bound the in-memory HTTP path); processing arbitrarily large local
 * exports is the entire point. The per-bundle cap (INGEST_MAX_BUNDLE_BYTES) and
 * the file-count cap (INGEST_MAX_BATCH_FILES) still apply.
 */

import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/client.js';
import { ingest_files } from '../../db/schema.js';
import { enqueueIngestJob, failIngestJob } from './job-control.js';
import { stageBlob } from './stage-blob.js';
import { upsertRosterFromSubmitters } from './gradescope/upsert-roster.js';
import { openLocalExport } from './gradescope/stream-export.js';
import { getBoss, JOB_KINDS } from '../../jobs/pg-boss.js';
import type { StorageClient } from '../storage/client.js';

export interface IngestLocalPathDeps {
  db: DrizzleDb;
  storageClient: StorageClient;
}

export interface IngestLocalPathArgs {
  semesterId: string;
  /** User id recorded as `ingest_jobs.uploaded_by`. */
  userId: string;
  /** Absolute (or process-cwd-relative) path to the export ZIP on disk. */
  archivePath: string;
  maxBundleBytes: number;
  maxBatchFiles: number;
  /**
   * Optional pre-created ingest job to stage into. When set, the function does
   * NOT lazily create its own job — even a roster-only export returns this id
   * (with `submissionsQueued: 0`) so the caller can settle the job. Used by the
   * async resumable `ingest_stage_upload` path; omit it for the synchronous
   * single-request / CLI local-path callers (which keep lazy creation).
   */
  jobId?: string;
}

export interface IngestLocalPathSkipped {
  folderKey: string;
  reason: 'no_manifest' | 'no_submitters' | 'bundle_too_large';
}

export type IngestLocalPathResult =
  | {
      ok: true;
      /** Null when the export had no stageable submissions (roster-only). */
      jobId: string | null;
      roster: { added: number; updated: number };
      bundlesProcessed: number;
      submissionsQueued: number;
      skipped: IngestLocalPathSkipped[];
    }
  | {
      ok: false;
      error: 'not_a_zip' | 'missing_metadata' | 'invalid_metadata' | 'too_many_files';
      detail: string;
    };

/**
 * Ingest a Gradescope export from a local filesystem path.
 *
 * The ingest job is created lazily on the first stageable bundle, so a
 * roster-only export (or one whose folders are all skipped) upserts the roster
 * and returns `jobId: null` without creating an empty job — matching the HTTP
 * route's behavior.
 */
export async function ingestLocalPath(
  deps: IngestLocalPathDeps,
  args: IngestLocalPathArgs,
): Promise<IngestLocalPathResult> {
  const { db, storageClient } = deps;
  const { semesterId, userId, archivePath, maxBundleBytes, maxBatchFiles } = args;
  const existingJobId = args.jobId ?? null;

  const opened = await openLocalExport(archivePath);
  if (!opened.ok) {
    return { ok: false, error: opened.error, detail: opened.detail };
  }

  try {
    // Populate/upsert the roster from the metadata up front (add/update only).
    const roster = await upsertRosterFromSubmitters(db, semesterId, opened.rosterSubmitters);

    const skipped: IngestLocalPathSkipped[] = [];
    const stagedFileIds: string[] = [];
    let bundlesProcessed = 0;
    let submissionsQueued = 0;
    let jobId: string | null = existingJobId;

    try {
      for await (const sub of opened.submissions()) {
        if (sub.kind === 'skipped') {
          skipped.push({ folderKey: sub.folderKey, reason: sub.reason });
          continue;
        }

        if (sub.bundleZip.byteLength > maxBundleBytes) {
          skipped.push({ folderKey: sub.folderKey, reason: 'bundle_too_large' });
          continue;
        }

        // Enforce the file-count cap as we stream (one file per submitter).
        if (submissionsQueued + sub.submitters.length > maxBatchFiles) {
          if (jobId !== null) {
            await failIngestJob(db, jobId, `exceeded INGEST_MAX_BATCH_FILES (${maxBatchFiles})`);
          }
          return {
            ok: false,
            error: 'too_many_files',
            detail: `export exceeds the limit of ${maxBatchFiles} submission files`,
          };
        }

        // Lazily create the job on the first real bundle.
        if (jobId === null) {
          jobId = (await enqueueIngestJob(db, semesterId, userId)).jobId;
        }

        bundlesProcessed++;
        for (const submitter of sub.submitters) {
          const fileId = crypto.randomUUID();
          const { blobSha256, sizeBytes } = await stageBlob(
            { storageClient },
            { jobId, ingestFileId: fileId, body: sub.bundleZip },
          );
          await db.insert(ingest_files).values({
            id: fileId,
            ingest_job_id: jobId,
            original_filename: `${sub.folderKey}.zip`,
            size_bytes: sizeBytes,
            blob_sha256: blobSha256,
            status: 'pending',
            match_sid: submitter.sid,
          });
          stagedFileIds.push(fileId);
          submissionsQueued++;
        }
      }
    } catch (stagingErr) {
      if (jobId !== null) {
        const detail = stagingErr instanceof Error ? stagingErr.message : String(stagingErr);
        await failIngestJob(db, jobId, detail);
      }
      throw stagingErr;
    }

    // Enqueue one ingest_file job per staged file, after all staging succeeds
    // (so a pg-boss error never leaves files staged without queue entries).
    if (jobId !== null && stagedFileIds.length > 0) {
      const boss = await getBoss();
      // Read back ids defensively (mirrors the HTTP route) so we enqueue exactly
      // the rows that landed.
      const rows = await db
        .select({ id: ingest_files.id })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));
      for (const { id: ingestFileId } of rows) {
        await boss.send(
          JOB_KINDS.INGEST_FILE,
          { ingestFileId, ingestJobId: jobId },
          { retryLimit: 3 },
        );
      }
    }

    return {
      ok: true,
      jobId,
      roster: { added: roster.added, updated: roster.updated },
      bundlesProcessed,
      submissionsQueued,
      skipped,
    };
  } finally {
    await opened.close();
  }
}
