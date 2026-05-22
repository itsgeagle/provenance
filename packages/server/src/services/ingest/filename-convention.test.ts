/**
 * Unit tests for filename-convention validator and parser (PRD §9.2).
 *
 * Pure functions — no I/O, no containers needed.
 */

import { describe, it, expect } from 'vitest';
import {
  validateFilenameConvention,
  parseFilenameWithConvention,
} from './filename-convention.js';

// ---------------------------------------------------------------------------
// validateFilenameConvention
// ---------------------------------------------------------------------------

describe('validateFilenameConvention', () => {
  it('accepts a valid regex with (?<sid>...) group', () => {
    const result = validateFilenameConvention(
      '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts a minimal regex with only (?<sid>...) group', () => {
    const result = validateFilenameConvention('(?<sid>[0-9]+)');
    expect(result).toEqual({ ok: true });
  });

  it('rejects a regex without (?<sid>...) group', () => {
    const result = validateFilenameConvention('^hw03_\\d+\\.zip$');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('(?<sid>');
    }
  });

  it('rejects a non-compiling regex', () => {
    const result = validateFilenameConvention('(?<sid>[unclosed');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('compile');
    }
  });

  it('rejects a regex longer than 500 characters', () => {
    const longRegex = '(?<sid>' + 'a'.repeat(500) + ')';
    expect(longRegex.length).toBeGreaterThan(500);
    const result = validateFilenameConvention(longRegex);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('500');
    }
  });

  it('accepts a regex exactly 500 characters long', () => {
    // (?<sid> = 7 chars, ) = 1 char → 8 chars overhead; fill remaining 492 with 'x'
    const at500 = '(?<sid>' + 'x'.repeat(500 - 8) + ')';
    expect(at500.length).toBe(500);
    const r = validateFilenameConvention(at500);
    expect(r).toEqual({ ok: true });
  });

  it('rejects a regex with (?<wrong_name>...) group but no sid', () => {
    const result = validateFilenameConvention('^(?<assignment_id>[a-z]+)\\.zip$');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('(?<sid>');
    }
  });
});

// ---------------------------------------------------------------------------
// parseFilenameWithConvention
// ---------------------------------------------------------------------------

describe('parseFilenameWithConvention', () => {
  const DEFAULT_CONVENTION = '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$';

  it('extracts sid and assignment_id from a matching filename', () => {
    const result = parseFilenameWithConvention(DEFAULT_CONVENTION, 'hw03-123456789.zip');
    expect(result).not.toBeNull();
    expect(result?.sid).toBe('123456789');
    expect(result?.assignment_id).toBe('hw03');
  });

  it('extracts only sid when assignment_id group is absent', () => {
    const sidOnly = '^(?<sid>\\d{6,12})\\.zip$';
    const result = parseFilenameWithConvention(sidOnly, '123456789.zip');
    expect(result).not.toBeNull();
    expect(result?.sid).toBe('123456789');
    expect(result?.assignment_id).toBeUndefined();
  });

  it('returns null when filename does not match', () => {
    const result = parseFilenameWithConvention(DEFAULT_CONVENTION, 'readme.txt');
    expect(result).toBeNull();
  });

  it('returns null when regex does not compile', () => {
    const result = parseFilenameWithConvention('(?<sid>[bad', 'anything.zip');
    expect(result).toBeNull();
  });

  it('handles underscore separator in the default convention', () => {
    const result = parseFilenameWithConvention(DEFAULT_CONVENTION, 'lab02_987654.zip');
    expect(result?.sid).toBe('987654');
    expect(result?.assignment_id).toBe('lab02');
  });

  it('returns null for a filename with sid too short (min 6 digits)', () => {
    const result = parseFilenameWithConvention(DEFAULT_CONVENTION, 'hw01-12345.zip');
    expect(result).toBeNull();
  });

  it('sid group is always required — returns null if match groups has no sid', () => {
    // A regex that compiles and matches but has no named group at all.
    const noGroupRegex = '^\\w+\\.zip$';
    // This won't match because it has no groups — but add (?<sid>...) variant
    // whose sid would be undefined after a match. Actually, a regex matching
    // without a named sid group returns no groups, and parseFilenameWithConvention
    // returns null. Test the path.
    const result = parseFilenameWithConvention(noGroupRegex, 'test.zip');
    // The regex matches but has no groups — match.groups is undefined or empty.
    expect(result).toBeNull();
  });
});
