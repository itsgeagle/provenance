/**
 * Resumable (chunked) Gradescope upload for very large exports.
 *
 * A single multi-GB upload over one request is fragile: a dropped connection
 * loses the whole transfer. This splits the file into parts backed by a server
 * multipart upload, uploads them with per-part retry, and — if the page is
 * reloaded or the upload is retried — resumes by asking the server which parts
 * it already has (persisted handle in localStorage), re-sending only the rest.
 *
 * Used automatically for files above RESUMABLE_THRESHOLD_BYTES; smaller exports
 * take the single-request path (which the server streams to disk anyway).
 */

import { apiFetch } from './client.js';
import {
  CreateUploadResponseSchema,
  UploadStatusResponseSchema,
  UploadPartResponseSchema,
  GradescopeIngestResponseSchema,
  type CreateUploadResponse,
  type GradescopeIngestResponse,
} from '@provenance/shared/api-schemas';

/**
 * Chunk size we ask the server for. The server's own default is 64 MiB, but the
 * apphost deploy sits behind IT's nginx, whose `client_max_body_size` is ~20 MiB
 * — a 64 MiB part PUT is rejected with 413 before it reaches the app. 16 MiB
 * keeps each part comfortably under that limit (and over the 5 MiB multipart
 * floor). Sent as the `chunk_size` hint on create; the server clamps it to
 * [5 MiB, 512 MiB]. If nginx's limit is raised, this can go back up.
 */
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Files at/above this size use the chunked/resumable path; smaller ones take the
 * single-request path. Pinned to one chunk so that the same ~20 MiB nginx
 * `client_max_body_size` that forces small chunks (see UPLOAD_CHUNK_BYTES) can
 * never be tripped by a single-shot upload either: any file larger than one
 * chunk is split into ≤16 MiB parts, and any file that still takes the
 * single-request path is itself under 16 MiB. Without this, files between the
 * nginx limit and the old 1 GiB threshold (a normal 50–500 MB export) would POST
 * their whole body in one request and 413. Raise this once nginx's limit is
 * lifted — the server streams single-shot uploads to disk and handles far larger.
 */
export const RESUMABLE_THRESHOLD_BYTES = UPLOAD_CHUNK_BYTES;

const MAX_PART_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// localStorage handle (enables resume across reloads/retries)
// ---------------------------------------------------------------------------

function storeKey(semesterId: string, file: File): string {
  return `prov-upload:${semesterId}:${file.name}:${file.size}:${file.lastModified}`;
}

function readHandle(key: string): CreateUploadResponse | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return CreateUploadResponseSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeHandle(key: string, handle: CreateUploadResponse): void {
  try {
    localStorage.setItem(key, JSON.stringify(handle));
  } catch {
    // Storage unavailable/quota — resume-across-reload is best-effort.
  }
}

function clearHandle(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Part upload (with retry)
// ---------------------------------------------------------------------------

async function putPart(
  semesterId: string,
  uploadId: string,
  s3UploadId: string,
  partNumber: number,
  blob: Blob,
): Promise<void> {
  const q = `?s3_upload_id=${encodeURIComponent(s3UploadId)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
    try {
      await apiFetch(
        `/semesters/${semesterId}/ingest/uploads/${uploadId}/parts/${partNumber}${q}`,
        { method: 'PUT', body: blob },
        UploadPartResponseSchema,
      );
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_PART_ATTEMPTS - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to upload part ${partNumber}`);
}

// ---------------------------------------------------------------------------
// uploadGradescopeResumable
// ---------------------------------------------------------------------------

export async function uploadGradescopeResumable(
  semesterId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<GradescopeIngestResponse> {
  const key = storeKey(semesterId, file);

  // Resume an existing upload if we have a stored handle the server still knows.
  let handle = readHandle(key);
  let received = new Set<number>();
  if (handle !== null) {
    try {
      const status = await apiFetch(
        `/semesters/${semesterId}/ingest/uploads/${handle.upload_id}/parts?s3_upload_id=${encodeURIComponent(handle.s3_upload_id)}`,
        { method: 'GET' },
        UploadStatusResponseSchema,
      );
      received = new Set(status.received_parts);
    } catch {
      handle = null; // stale/expired upload — start fresh
    }
  }

  if (handle === null) {
    handle = await apiFetch(
      `/semesters/${semesterId}/ingest/uploads`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          total_bytes: file.size,
          chunk_size: UPLOAD_CHUNK_BYTES,
        }),
      },
      CreateUploadResponseSchema,
    );
    received = new Set();
    writeHandle(key, handle);
  }

  const { upload_id, s3_upload_id, chunk_size, total_parts } = handle;

  for (let n = 1; n <= total_parts; n++) {
    if (!received.has(n)) {
      const start = (n - 1) * chunk_size;
      const end = Math.min(start + chunk_size, file.size);
      await putPart(semesterId, upload_id, s3_upload_id, n, file.slice(start, end));
    }
    onProgress?.(Math.round((n / total_parts) * 100));
  }

  const result = await apiFetch(
    `/semesters/${semesterId}/ingest/uploads/${upload_id}/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ s3_upload_id }),
    },
    GradescopeIngestResponseSchema,
  );

  clearHandle(key);
  return result;
}
