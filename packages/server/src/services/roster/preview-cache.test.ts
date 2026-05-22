/**
 * Unit tests for preview-cache.
 * All pure; no DB involved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { putPreview, getPreview, _resetPreviewCacheForTest } from './preview-cache.js';
import type { CachedPreview } from './preview-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreview(createdAt: number = Date.now()): CachedPreview {
  return {
    semesterId: 'sem-1',
    toAdd: [],
    toUpdate: [],
    toDelete: [],
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetPreviewCacheForTest();
});

describe('putPreview / getPreview', () => {
  it('round-trips a preview', () => {
    const preview = makePreview();
    putPreview('upload-1', preview);
    const result = getPreview('upload-1');
    expect(result).not.toBeNull();
    expect(result?.semesterId).toBe('sem-1');
  });

  it('returns null for unknown upload_id', () => {
    expect(getPreview('does-not-exist')).toBeNull();
  });

  it('returns null after TTL expires (injected clock)', () => {
    const base = 1_000_000;
    putPreview('upload-1', makePreview(base));

    // Not yet expired: 29 min later.
    expect(getPreview('upload-1', () => base + 29 * 60 * 1000)).not.toBeNull();

    // Expired: exactly 30 min later.
    expect(getPreview('upload-1', () => base + 30 * 60 * 1000)).toBeNull();
  });

  it('sweeps expired entries from cache', () => {
    const base = 1_000_000;
    putPreview('upload-expired', makePreview(base));
    putPreview('upload-fresh', makePreview(base + 29 * 60 * 1000));

    // Query 31 min after the first entry was inserted: expired should be swept.
    const ts = base + 31 * 60 * 1000;
    expect(getPreview('upload-expired', () => ts)).toBeNull();
    // fresh entry was created only 2 min before ts, so it should still be present
    expect(getPreview('upload-fresh', () => ts)).not.toBeNull();
  });

  it('_resetPreviewCacheForTest clears all entries', () => {
    putPreview('upload-1', makePreview());
    putPreview('upload-2', makePreview());
    _resetPreviewCacheForTest();
    expect(getPreview('upload-1')).toBeNull();
    expect(getPreview('upload-2')).toBeNull();
  });
});
