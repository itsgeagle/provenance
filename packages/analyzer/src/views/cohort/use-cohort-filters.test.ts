/**
 * use-cohort-filters tests.
 *
 * Tests URL <-> filter decoding and round-trip encoding without requiring
 * a live React component (pure functions tested directly).
 */

import { describe, it, expect } from 'vitest';
import { decodeFilters, encodeFilters } from './use-cohort-filters.js';

// ---------------------------------------------------------------------------
// decodeFilters — URL → CohortFilters
// ---------------------------------------------------------------------------

describe('decodeFilters', () => {
  it('returns empty filters for empty params', () => {
    const params = new URLSearchParams();
    const filters = decodeFilters(params);
    expect(filters).toEqual({});
  });

  it('decodes assignment_id', () => {
    const params = new URLSearchParams('assignment_id=00000000-0000-0000-0000-000000000001');
    expect(decodeFilters(params).assignmentId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('decodes flag_id multi-value (repeated key)', () => {
    const params = new URLSearchParams('flag_id=ai_ext&flag_id=large_paste');
    expect(decodeFilters(params).flagIds).toEqual(['ai_ext', 'large_paste']);
  });

  it('decodes severity_min', () => {
    const params = new URLSearchParams('severity_min=medium');
    expect(decodeFilters(params).severityMin).toBe('medium');
  });

  it('ignores invalid severity_min', () => {
    const params = new URLSearchParams('severity_min=bogus');
    expect(decodeFilters(params).severityMin).toBeUndefined();
  });

  it('decodes validation_status', () => {
    const params = new URLSearchParams('validation_status=fail');
    expect(decodeFilters(params).validationStatus).toBe('fail');
  });

  it('ignores invalid validation_status', () => {
    const params = new URLSearchParams('validation_status=unknown');
    expect(decodeFilters(params).validationStatus).toBeUndefined();
  });

  it('decodes score_min and score_max', () => {
    const params = new URLSearchParams('score_min=5&score_max=20');
    const filters = decodeFilters(params);
    expect(filters.scoreMin).toBe(5);
    expect(filters.scoreMax).toBe(20);
  });

  it('decodes boolean has_external_edits and has_large_paste', () => {
    const params = new URLSearchParams('has_external_edits=true&has_large_paste=false');
    const filters = decodeFilters(params);
    expect(filters.hasExternalEdits).toBe(true);
    expect(filters.hasLargePaste).toBe(false);
  });

  it('decodes include_superseded', () => {
    const params = new URLSearchParams('include_superseded=true');
    expect(decodeFilters(params).includeSuperseded).toBe(true);
  });

  it('decodes q (free-text search)', () => {
    const params = new URLSearchParams('q=alice');
    expect(decodeFilters(params).q).toBe('alice');
  });

  it('decodes recorder_version', () => {
    const params = new URLSearchParams('recorder_version=1.2.3');
    expect(decodeFilters(params).recorderVersion).toBe('1.2.3');
  });
});

// ---------------------------------------------------------------------------
// encodeFilters — CohortFilters → URLSearchParams
// ---------------------------------------------------------------------------

describe('encodeFilters', () => {
  it('produces empty params for empty filters + default sort', () => {
    const params = encodeFilters({}, 'score_desc');
    expect(params.toString()).toBe('');
  });

  it('includes non-default sort', () => {
    const params = encodeFilters({}, 'ingested_desc');
    expect(params.get('sort')).toBe('ingested_desc');
  });

  it('encodes flag_ids as repeated keys', () => {
    const params = encodeFilters({ flagIds: ['ai_ext', 'large_paste'] }, 'score_desc');
    expect(params.getAll('flag_id')).toEqual(['ai_ext', 'large_paste']);
  });

  it('encodes boolean false explicitly', () => {
    const params = encodeFilters({ hasExternalEdits: false }, 'score_desc');
    expect(params.get('has_external_edits')).toBe('false');
  });

  it('omits include_superseded when false (falsy default)', () => {
    // includeSuperseded: false → undefined-equivalent; only true is encoded
    const params = encodeFilters({ includeSuperseded: false }, 'score_desc');
    expect(params.get('include_superseded')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: decode(encode(filters)) === filters
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('round-trips a full filter set', () => {
    const original = {
      assignmentId: '00000000-0000-0000-0000-000000000002',
      flagIds: ['ai_ext', 'large_paste'],
      severityMin: 'medium' as const,
      validationStatus: 'fail' as const,
      scoreMin: 5,
      scoreMax: 20,
      hasExternalEdits: true,
      hasLargePaste: false,
      recorderVersion: '1.2.3',
      includeSuperseded: true,
      q: 'alice',
    };
    const encoded = encodeFilters(original, 'student_asc');
    const decoded = decodeFilters(encoded);

    expect(decoded.assignmentId).toBe(original.assignmentId);
    expect(decoded.flagIds).toEqual(original.flagIds);
    expect(decoded.severityMin).toBe(original.severityMin);
    expect(decoded.validationStatus).toBe(original.validationStatus);
    expect(decoded.scoreMin).toBe(original.scoreMin);
    expect(decoded.scoreMax).toBe(original.scoreMax);
    expect(decoded.hasExternalEdits).toBe(original.hasExternalEdits);
    expect(decoded.hasLargePaste).toBe(original.hasLargePaste);
    expect(decoded.recorderVersion).toBe(original.recorderVersion);
    expect(decoded.includeSuperseded).toBe(original.includeSuperseded);
    expect(decoded.q).toBe(original.q);
  });
});
