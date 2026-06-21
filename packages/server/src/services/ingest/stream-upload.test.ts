/**
 * Unit tests for streamUploadToTempFile — multipart body → temp file, no buffer.
 *
 * Builds real multipart requests with FormData/Request (the same shape the
 * analyzer's XHR upload produces) and asserts the helper writes the file to disk
 * and reports the right discriminated errors.
 */

import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { streamUploadToTempFile } from './stream-upload.js';

function multipartRequest(parts: Record<string, Blob>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(parts)) fd.append(k, v, 'upload.zip');
  return new Request('http://localhost/x', { method: 'POST', body: fd });
}

describe('streamUploadToTempFile', () => {
  it('writes the archive field to a temp file with exact bytes', async () => {
    const payload = new Uint8Array(50_000).map((_, i) => i % 256);
    const req = multipartRequest({ archive: new Blob([payload]) });

    const res = await streamUploadToTempFile({
      fieldName: 'archive',
      maxBytes: 1_000_000,
      headers: req.headers,
      body: req.body!,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    try {
      expect(res.bytes).toBe(payload.length);
      expect((await stat(res.path)).size).toBe(payload.length);
      expect(new Uint8Array(await readFile(res.path))).toEqual(payload);
    } finally {
      await res.cleanup();
    }
  });

  it('reports missing_file when the archive field is absent', async () => {
    const req = multipartRequest({ other: new Blob([new Uint8Array([1, 2, 3])]) });
    const res = await streamUploadToTempFile({
      fieldName: 'archive',
      maxBytes: 1_000_000,
      headers: req.headers,
      body: req.body!,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('missing_file');
  });

  it('reports too_large when the file exceeds maxBytes', async () => {
    const payload = new Uint8Array(20_000);
    const req = multipartRequest({ archive: new Blob([payload]) });
    const res = await streamUploadToTempFile({
      fieldName: 'archive',
      maxBytes: 10_000,
      headers: req.headers,
      body: req.body!,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('too_large');
  });

  it('reports malformed for a non-multipart body', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const res = await streamUploadToTempFile({
      fieldName: 'archive',
      maxBytes: 1_000_000,
      headers: req.headers,
      body: req.body!,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('malformed');
  });
});
