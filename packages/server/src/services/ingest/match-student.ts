/**
 * Phase 4 of the per-file ingest pipeline: match student (PRD §9.3).
 *
 * Applies the semester's `filename_convention` regex to the original filename
 * to extract the student id (`sid`) and optionally an `assignment_id`.
 *
 * If the regex matches and the extracted `sid` is found in the roster, the
 * file is matched. The `assignment_id` is taken from the filename capture
 * group if present, falling back to the bundle manifest's `assignment.id`.
 *
 * Unmatched conditions:
 *   - Filename does not match the convention regex.
 *   - `sid` captured but not found in the roster.
 *
 * This module is pure with respect to business logic — the DB lookup is
 * injected as a roster resolver function so callers control the query.
 *
 * Design: pure function that takes explicit inputs and returns a discriminated
 * result. The worker persists the result to the DB.
 */

import { parseFilenameWithConvention } from './filename-convention.js';
import type { BundleManifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchStudentSuccess = {
  matched: true;
  /** UUID of the matched roster_entries row. */
  studentId: string;
  /** String assignment id (from filename capture or manifest). */
  assignmentIdStr: string;
  /** Raw named-group captures from the filename regex, for auditing. */
  filenameCapture: Record<string, string>;
};

export type MatchStudentFailure = {
  matched: false;
  /** Reason for the unmatched result. */
  reason: 'no_filename_match' | 'unknown_sid';
  /** The captured sid (present when reason='unknown_sid'). */
  sid?: string;
};

export type MatchStudentResult = MatchStudentSuccess | MatchStudentFailure;

/**
 * Roster lookup function injected by the worker.
 *
 * Given a `(semesterId, sid)` pair, resolves to the roster_entries.id UUID
 * or `null` if the student is not in the roster.
 */
export type RosterResolver = (semesterId: string, sid: string) => Promise<string | null>;

// ---------------------------------------------------------------------------
// matchStudent
// ---------------------------------------------------------------------------

/**
 * Apply the semester's filename convention to an uploaded file and attempt to
 * match the student to the roster.
 *
 * @param semesterId           UUID of the semester (for roster lookup).
 * @param filenameConvention   The semester's regex string (from `semesters.filename_convention`).
 * @param originalFilename     The original filename of the uploaded file.
 * @param manifest             Parsed bundle manifest (fallback for assignment_id).
 * @param resolveRoster        Async function returning the roster_entries.id for a (semester, sid)
 *                             pair, or `null` if not found.
 *
 * Returns:
 *   - `{ matched: true, studentId, assignmentIdStr, filenameCapture }` on success.
 *   - `{ matched: false, reason }` when no match is possible.
 */
export async function matchStudent(
  semesterId: string,
  filenameConvention: string,
  originalFilename: string,
  manifest: BundleManifest,
  resolveRoster: RosterResolver,
): Promise<MatchStudentResult> {
  // -------------------------------------------------------------------------
  // Step 1: Apply the filename convention regex.
  // -------------------------------------------------------------------------
  const parsed = parseFilenameWithConvention(filenameConvention, originalFilename);

  if (parsed === null) {
    // Regex didn't compile or didn't match — unmatched.
    return { matched: false, reason: 'no_filename_match' };
  }

  const { sid, assignment_id: filenameAssignmentId } = parsed;

  if (sid === undefined) {
    // Should not happen after regex validation, but be safe.
    return { matched: false, reason: 'no_filename_match' };
  }

  // -------------------------------------------------------------------------
  // Step 2: Look up the sid in the roster.
  // -------------------------------------------------------------------------
  const studentId = await resolveRoster(semesterId, sid);

  if (studentId === null) {
    return { matched: false, reason: 'unknown_sid', sid };
  }

  // -------------------------------------------------------------------------
  // Step 3: Determine assignment_id — filename capture takes precedence,
  //         fall back to bundle manifest's assignment_id.
  // -------------------------------------------------------------------------
  const assignmentIdStr = filenameAssignmentId ?? manifest.assignment_id;

  // -------------------------------------------------------------------------
  // Step 4: Build the filename capture record for auditing.
  // -------------------------------------------------------------------------
  const filenameCapture: Record<string, string> = { sid };
  if (filenameAssignmentId !== undefined) {
    filenameCapture['assignment_id'] = filenameAssignmentId;
  }

  return {
    matched: true,
    studentId,
    assignmentIdStr,
    filenameCapture,
  };
}
