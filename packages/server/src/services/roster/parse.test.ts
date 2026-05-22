/**
 * Unit tests for parseRosterCsv.
 * Pure function; no DB or HTTP involved.
 */

import { describe, it, expect } from 'vitest';
import { parseRosterCsv } from './parse.js';

describe('parseRosterCsv', () => {
  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('parses a minimal CSV with sid and display_name', () => {
    const csv = `sid,display_name\n12345,Alice Smith\n67890,Bob Jones`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      sid: '12345',
      display_name: 'Alice Smith',
      email: null,
      extras: {},
    });
    expect(result.rows[1]).toEqual({
      sid: '67890',
      display_name: 'Bob Jones',
      email: null,
      extras: {},
    });
  });

  it('parses CSV with email column', () => {
    const csv = `sid,display_name,email\n12345,Alice Smith,alice@berkeley.edu`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]?.email).toBe('alice@berkeley.edu');
  });

  it('treats empty email cell as null', () => {
    const csv = `sid,display_name,email\n12345,Alice Smith,`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]?.email).toBeNull();
  });

  it('stores extra columns in extras object', () => {
    const csv = `sid,display_name,section,lab_ta\n12345,Alice Smith,101,Dr. Kim`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]?.extras).toEqual({ section: '101', lab_ta: 'Dr. Kim' });
  });

  it('is case-insensitive for required column names (SID, Display_Name)', () => {
    const csv = `SID,Display_Name\n12345,Alice Smith`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]?.sid).toBe('12345');
    expect(result.rows[0]?.display_name).toBe('Alice Smith');
  });

  it('trims whitespace from values', () => {
    const csv = `sid,display_name\n  12345  ,  Alice Smith  `;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]?.sid).toBe('12345');
    expect(result.rows[0]?.display_name).toBe('Alice Smith');
  });

  // ---------------------------------------------------------------------------
  // Missing required columns → throws
  // ---------------------------------------------------------------------------

  it('throws ROSTER_CSV_MISSING_REQUIRED_COLUMN for missing sid', () => {
    const csv = `display_name\nAlice Smith`;
    expect(() => parseRosterCsv(csv)).toThrowError(
      expect.objectContaining({ code: 'ROSTER_CSV_MISSING_REQUIRED_COLUMN' }),
    );
  });

  it('throws ROSTER_CSV_MISSING_REQUIRED_COLUMN for missing display_name', () => {
    const csv = `sid\n12345`;
    expect(() => parseRosterCsv(csv)).toThrowError(
      expect.objectContaining({ code: 'ROSTER_CSV_MISSING_REQUIRED_COLUMN' }),
    );
  });

  it('throws for completely empty CSV', () => {
    expect(() => parseRosterCsv('')).toThrowError(
      expect.objectContaining({ code: 'ROSTER_CSV_MISSING_REQUIRED_COLUMN' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Row-level errors
  // ---------------------------------------------------------------------------

  it('collects error for row with empty sid, still parses other rows', () => {
    const csv = `sid,display_name\n,Alice Smith\n12345,Bob Jones`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.row).toBe(2);
    expect(result.errors[0]?.message).toMatch(/sid/i);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sid).toBe('12345');
  });

  it('collects error for row with empty display_name, still parses other rows', () => {
    const csv = `sid,display_name\n12345,\n67890,Bob Jones`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.row).toBe(2);
    expect(result.errors[0]?.message).toMatch(/display_name/i);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sid).toBe('67890');
  });

  it('returns empty rows and no errors for header-only CSV', () => {
    const csv = `sid,display_name`;
    const result = parseRosterCsv(csv);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // UTF-8 BOM handling
  // ---------------------------------------------------------------------------

  it('strips UTF-8 BOM and parses successfully', () => {
    // U+FEFF prepended (as produced by Excel "Save As CSV UTF-8 with BOM").
    const csv = `﻿sid,display_name\n12345,Alice Smith`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sid).toBe('12345');
    expect(result.rows[0]?.display_name).toBe('Alice Smith');
  });

  // ---------------------------------------------------------------------------
  // Duplicate sid detection
  // ---------------------------------------------------------------------------

  it('reports row-level error for duplicate sid and excludes second occurrence', () => {
    const csv = `sid,display_name\n12345,Alice Smith\n67890,Bob Jones\n12345,Alice Duplicate`;
    const result = parseRosterCsv(csv);
    // Only one error: the duplicate at row 4.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.row).toBe(4);
    expect(result.errors[0]?.message).toMatch(/duplicate sid/i);
    expect(result.errors[0]?.message).toContain('12345');
    expect(result.errors[0]?.message).toContain('row 2'); // first seen at row 2
    // Only valid (non-duplicate) rows are in the output.
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.sid)).toEqual(['12345', '67890']);
  });

  it('duplicate sid check is case-insensitive', () => {
    const csv = `sid,display_name\nSTU001,Alice Smith\nstu001,Alice Dupe`;
    const result = parseRosterCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.row).toBe(3);
    expect(result.errors[0]?.message).toMatch(/duplicate sid/i);
    // Only the first occurrence is kept.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sid).toBe('STU001');
  });
});
