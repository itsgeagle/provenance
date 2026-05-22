/**
 * Phase 1 of the per-file ingest pipeline (PRD §9.3).
 *
 * `stageBlob` streams a file upload to `ingest-staging/{jobId}/{fileId}` in
 * the object store. It computes sha256 and size incrementally (no double-read)
 * via `putBlob`, which hashes in-flight.
 *
 * The staging key is later:
 *   - moved to `semesters/.../submissions/.../bundle.zip` on successful match (Phase 9b)
 *   - deleted on dedup / failed / discarded (Phase 9b / retention sweep)
 *
 * Design: pure-ish function with explicit deps (StorageClient injected).
 * The caller (route handler or worker) provides the already-buffered body;
 * this module has no knowledge of HTTP.
 */

import { putBlob } from '../storage/blobs.js';
import { ingestStagingKey } from '../storage/keys.js';
import type { StorageClient } from '../storage/client.js';

// ---------------------------------------------------------------------------
// StageBlobDeps
// ---------------------------------------------------------------------------

export interface StageBlobDeps {
  storageClient: StorageClient;
}

// ---------------------------------------------------------------------------
// StageBlobArgs
// ---------------------------------------------------------------------------

export interface StageBlobArgs {
  jobId: string;
  ingestFileId: string;
  /** Raw file bytes. May be a Uint8Array, ArrayBuffer, or a ReadableStream. */
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array;
}

// ---------------------------------------------------------------------------
// StageBlobResult
// ---------------------------------------------------------------------------

export interface StageBlobResult {
  /** Hex-encoded SHA-256 of the uploaded bytes. */
  blobSha256: string;
  /** Total byte count of the uploaded file. */
  sizeBytes: number;
  /** Object key where the staged file lives in the bucket. */
  stagingKey: string;
}

// ---------------------------------------------------------------------------
// stageBlob
// ---------------------------------------------------------------------------

/**
 * Stage a file to `ingest-staging/{jobId}/{ingestFileId}`.
 *
 * Returns the sha256, size, and staging key so the caller can populate the
 * `ingest_files` row before processing continues.
 *
 * @throws If the blob PUT fails.
 */
export async function stageBlob(
  deps: StageBlobDeps,
  args: StageBlobArgs,
): Promise<StageBlobResult> {
  const key = ingestStagingKey(args.jobId, args.ingestFileId);
  const { sha256, size } = await putBlob(deps.storageClient, key, args.body);

  return {
    blobSha256: sha256,
    sizeBytes: size,
    stagingKey: key,
  };
}
