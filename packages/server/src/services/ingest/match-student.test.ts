/**
 * Unit tests for matchStudent (PRD §9.3 phase 4).
 *
 * matchStudent is a pure function: the roster lookup is injected, so tests
 * do not need a database connection. No testcontainers required.
 */

import { describe, it, expect } from 'vitest';
import { matchStudent } from './match-student.js';
import type { RosterResolver } from './match-student.js';
import type { BundleManifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal BundleManifest with only the fields matchStudent cares about. */
function makeManifest(assignmentId = 'hw01'): BundleManifest {
  return {
    format_version: '1.0',
    assignment_id: assignmentId,
    semester: 'fa2024',
    extension_hash: 'a'.repeat(64),
    sessions: [],
  };
}

/**
 * A roster resolver that returns the given studentId for any (semesterId, sid)
 * pair where the sid matches `knownSid`, and null otherwise.
 */
function makeRoster(knownSid: string, studentId: string): RosterResolver {
  return async (_semesterId, sid) => (sid === knownSid ? studentId : null);
}

/** Empty roster: all lookups return null. */
const emptyRoster: RosterResolver = async () => null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SEMESTER_ID = 'sem-uuid-001';

describe('matchStudent', () => {
  // -------------------------------------------------------------------------
  // Happy path: filename match + known sid
  // -------------------------------------------------------------------------

  it('returns matched:true with studentId for a known sid', async () => {
    const studentId = crypto.randomUUID();
    const roster = makeRoster('123456', studentId);

    const result = await matchStudent(
      SEMESTER_ID,
      '^(?<sid>\\d{6})\\.zip$',
      '123456.zip',
      makeManifest('hw01'),
      roster,
    );

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.studentId).toBe(studentId);
  });

  it('uses manifest assignment_id when filename has no assignment_id group', async () => {
    const studentId = crypto.randomUUID();
    const roster = makeRoster('123456', studentId);

    const result = await matchStudent(
      SEMESTER_ID,
      '^(?<sid>\\d{6})\\.zip$',
      '123456.zip',
      makeManifest('hw03'),
      roster,
    );

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.assignmentIdStr).toBe('hw03'); // from manifest
  });

  it('uses filename assignment_id when the pattern captures it (takes precedence over manifest)', async () => {
    const studentId = crypto.randomUUID();
    const roster = makeRoster('123456', studentId);

    const result = await matchStudent(
      SEMESTER_ID,
      '^(?<assignment_id>[a-z0-9]+)-(?<sid>\\d{6})\\.zip$',
      'hw02-123456.zip',
      makeManifest('hw01'), // manifest says hw01 but filename says hw02
      roster,
    );

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.assignmentIdStr).toBe('hw02'); // filename wins
  });

  it('includes sid and assignment_id in filenameCapture', async () => {
    const studentId = crypto.randomUUID();
    const roster = makeRoster('987654', studentId);

    const result = await matchStudent(
      SEMESTER_ID,
      '^(?<assignment_id>[a-z0-9]+)[-_](?<sid>\\d{6})\\.zip$',
      'hw05-987654.zip',
      makeManifest('hw05'),
      roster,
    );

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.filenameCapture).toEqual({ sid: '987654', assignment_id: 'hw05' });
  });

  it('only includes sid in filenameCapture when no assignment_id group in filename', async () => {
    const studentId = crypto.randomUUID();
    const roster = makeRoster('111111', studentId);

    const result = await matchStudent(
      SEMESTER_ID,
      '^(?<sid>\\d{6})\\.zip$',
      '111111.zip',
      makeManifest('hw01'),
      roster,
    );

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.filenameCapture).toEqual({ sid: '111111' });
  });

  // -------------------------------------------------------------------------
  // Unknown sid
  // -------------------------------------------------------------------------

  it('returns matched:false with reason=unknown_sid when sid not in roster', async () => {
    const result = await matchStudent(
      SEMESTER_ID,
      '^(?<sid>\\d{6})\\.zip$',
      '999999.zip',
      makeManifest('hw01'),
      emptyRoster,
    );

    expect(result.matched).toBe(false);
    if (result.matched) return;
    expect(result.reason).toBe('unknown_sid');
    expect(result.sid).toBe('999999');
  });

  // -------------------------------------------------------------------------
  // No filename match
  // -------------------------------------------------------------------------

  it('returns matched:false with reason=no_filename_match when regex does not match', async () => {
    const result = await matchStudent(
      SEMESTER_ID,
      '^(?<sid>\\d{6})\\.zip$',
      'not-matching-pattern.zip',
      makeManifest('hw01'),
      emptyRoster,
    );

    expect(result.matched).toBe(false);
    if (result.matched) return;
    expect(result.reason).toBe('no_filename_match');
  });

  it('returns matched:false when filename_convention regex is invalid (safety valve)', async () => {
    // An invalid regex should not throw — parseFilenameWithConvention returns null.
    const result = await matchStudent(
      SEMESTER_ID,
      '(?<sid>[invalid regex(', // malformed regex
      '123456.zip',
      makeManifest('hw01'),
      emptyRoster,
    );

    expect(result.matched).toBe(false);
    if (result.matched) return;
    expect(result.reason).toBe('no_filename_match');
  });

  it('roster resolver is called with the correct semesterId', async () => {
    const calls: Array<{ semesterId: string; sid: string }> = [];
    const trackingRoster: RosterResolver = async (semesterId, sid) => {
      calls.push({ semesterId, sid });
      return null;
    };

    const targetSemesterId = 'specific-semester-id';
    await matchStudent(
      targetSemesterId,
      '^(?<sid>\\d{6})\\.zip$',
      '123456.zip',
      makeManifest('hw01'),
      trackingRoster,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.semesterId).toBe(targetSemesterId);
    expect(calls[0]!.sid).toBe('123456');
  });

  it('filename match with no sid group returns no_filename_match (malformed regex without sid)', async () => {
    // A convention that compiles and matches but has no (?<sid>...) group.
    // parseFilenameWithConvention returns null on missing sid.
    const result = await matchStudent(
      SEMESTER_ID,
      '^(\\d{6})\\.zip$', // valid regex, matches, but no named sid group
      '123456.zip',
      makeManifest('hw01'),
      emptyRoster,
    );

    expect(result.matched).toBe(false);
    if (result.matched) return;
    expect(result.reason).toBe('no_filename_match');
  });
});
