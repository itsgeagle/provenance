/**
 * Unit tests for uploadGradescopeResumable — chunking, resume, and completion.
 * apiFetch is mocked so we assert the request sequence without a server.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { uploadGradescopeResumable } from './resumable-upload.js';

vi.mock('./client.js', () => ({ apiFetch: vi.fn() }));
const { apiFetch } = (await import('./client.js')) as unknown as { apiFetch: Mock };

const CREATE = {
  upload_id: '11111111-1111-4111-8111-111111111111',
  s3_upload_id: 's3-upload-abc',
  chunk_size: 10,
  total_parts: 3,
};
const INGEST = {
  job_id: '22222222-2222-4222-8222-222222222222',
  roster: { added: 1, updated: 0 },
  bundles_processed: 1,
  submissions_queued: 1,
  skipped: [],
};

function makeFile(size: number): File {
  return new File([new Uint8Array(size)], 'export.zip', { lastModified: 1000 });
}

/** Route apiFetch(path, init) to canned responses; record the calls. */
function wireApiFetch(received: number[] = []): void {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.endsWith('/ingest/uploads') && method === 'POST') return Promise.resolve(CREATE);
    if (path.includes('/parts?') && method === 'GET') {
      return Promise.resolve({ received_parts: received });
    }
    if (path.includes('/parts/') && method === 'PUT') {
      const n = Number(/\/parts\/(\d+)/.exec(path)![1]);
      return Promise.resolve({ part_number: n, received: true });
    }
    if (path.endsWith('/complete') && method === 'POST') return Promise.resolve(INGEST);
    throw new Error(`unexpected apiFetch ${method} ${path}`);
  });
}

describe('uploadGradescopeResumable', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
  });

  it('creates, uploads all parts, completes, and clears the handle', async () => {
    wireApiFetch();
    const progress: number[] = [];
    const res = await uploadGradescopeResumable('sem-1', makeFile(25), (p) => progress.push(p));

    expect(res.job_id).toBe(INGEST.job_id);

    const puts = apiFetch.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PUT',
    );
    expect(puts.map((c) => /\/parts\/(\d+)/.exec(c[0] as string)![1])).toEqual(['1', '2', '3']);
    expect(progress.at(-1)).toBe(100);
    // Handle cleared after completion.
    expect(localStorage.getItem('prov-upload:sem-1:export.zip:25:1000')).toBeNull();
  });

  it('resumes by skipping already-received parts', async () => {
    // Pre-seed a stored handle so the function resumes instead of creating.
    localStorage.setItem('prov-upload:sem-1:export.zip:25:1000', JSON.stringify(CREATE));
    wireApiFetch([1, 2]); // server already has parts 1 and 2

    await uploadGradescopeResumable('sem-1', makeFile(25));

    const puts = apiFetch.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PUT',
    );
    // Only the missing part (3) is uploaded.
    expect(puts.map((c) => /\/parts\/(\d+)/.exec(c[0] as string)![1])).toEqual(['3']);
    // No create call when resuming.
    const creates = apiFetch.mock.calls.filter(
      (c) =>
        (c[0] as string).endsWith('/ingest/uploads') && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(creates).toHaveLength(0);
  });
});
