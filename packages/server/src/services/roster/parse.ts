/**
 * Roster CSV parser (PRD §8.4).
 *
 * Wraps Papa Parse. Validates required columns (case-insensitive), collects
 * row-level errors without failing the whole parse, and maps each valid row
 * to a ParsedRow.
 *
 * Throws ApiError(ROSTER_CSV_MISSING_REQUIRED_COLUMN) if the headers don't
 * include `sid` and `display_name` (case-insensitive).
 *
 * Row-level errors (empty required fields, etc.) are collected in the returned
 * `errors` array; other rows still succeed.
 */

import Papa from 'papaparse';
import { Errors } from '../../api/v1/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedRow {
  sid: string;
  display_name: string;
  email: string | null;
  extras: Record<string, string>;
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: { row: number; message: string }[];
}

// ---------------------------------------------------------------------------
// Required / known columns
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = ['sid', 'display_name'] as const;
const KNOWN_COLUMNS = new Set(['sid', 'display_name', 'email']);

// ---------------------------------------------------------------------------
// parseRosterCsv
// ---------------------------------------------------------------------------

/**
 * Parse a roster CSV string into typed rows.
 *
 * @param input - Raw CSV string (UTF-8).
 * @returns ParseResult with valid rows and any row-level errors.
 * @throws ApiError(ROSTER_CSV_MISSING_REQUIRED_COLUMN) if required headers missing.
 */
export function parseRosterCsv(input: string): ParseResult {
  // Papa Parse with header mode and skipEmptyLines.
  // We use `dynamicTyping: false` to keep everything as strings — we do our
  // own coercion. `transform` trims whitespace from all values.
  const result = Papa.parse<Record<string, string>>(input, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transform: (value: string) => value.trim(),
  });

  const rawHeaders: string[] = result.meta.fields ?? [];

  // Build a case-insensitive header map: lowercase -> original header name.
  const headerMap = new Map<string, string>();
  for (const h of rawHeaders) {
    headerMap.set(h.toLowerCase(), h);
  }

  // Validate required columns.
  for (const required of REQUIRED_COLUMNS) {
    if (!headerMap.has(required)) {
      throw Errors.rosterCsvMissingRequiredColumn(required);
    }
  }

  // Identify extra column names (original casing).
  const extraHeaders: string[] = [];
  for (const [lower, original] of headerMap) {
    if (!KNOWN_COLUMNS.has(lower)) {
      extraHeaders.push(original);
    }
  }

  const sidHeader = headerMap.get('sid')!;
  const displayNameHeader = headerMap.get('display_name')!;
  const emailHeader = headerMap.get('email');

  const rows: ParsedRow[] = [];
  const errors: { row: number; message: string }[] = [];

  // Row index starts at 2 (1-indexed, row 1 = header).
  result.data.forEach((rawRow, idx) => {
    const rowNum = idx + 2;

    const sid = rawRow[sidHeader] ?? '';
    const displayName = rawRow[displayNameHeader] ?? '';

    if (sid === '') {
      errors.push({ row: rowNum, message: 'sid is required and cannot be empty' });
      return;
    }
    if (displayName === '') {
      errors.push({ row: rowNum, message: 'display_name is required and cannot be empty' });
      return;
    }

    const emailRaw = emailHeader !== undefined ? (rawRow[emailHeader] ?? '') : '';
    const email = emailRaw === '' ? null : emailRaw;

    const extras: Record<string, string> = {};
    for (const header of extraHeaders) {
      extras[header] = rawRow[header] ?? '';
    }

    rows.push({ sid, display_name: displayName, email, extras });
  });

  // Collect Papa Parse structural errors (e.g. wrong column count).
  for (const parseErr of result.errors) {
    const rowNum = (parseErr.row ?? 0) + 2;
    errors.push({ row: rowNum, message: parseErr.message });
  }

  return { rows, errors };
}
