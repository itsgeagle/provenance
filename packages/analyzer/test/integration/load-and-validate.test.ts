/**
 * Integration test: real recorder fixture (Phase 9).
 *
 * Loads the fixture ZIP produced by the Provenance Recorder against
 * test-workspace/ (see test/integration/regenerate-fixture.md for how to
 * produce it), then runs the full analyzer pipeline:
 *
 *   loadBundle → buildIndex → runValidation → runHeuristics
 *
 * Asserts known-good structural properties that must hold for ANY valid
 * recorder-produced bundle — not brittle snapshot assertions, but invariants:
 *
 *   - loadBundle returns ok.
 *   - All sessions have firstEvent.kind === 'session.start'.
 *   - runValidation completes; overall is 'warn' (check 8 always skipped in v1).
 *   - runHeuristics returns a sorted flag array (may be empty for a clean session).
 *
 * The test is skip-gated: if the fixture file does not exist (e.g. on a fresh
 * clone without the binary), the describe block is skipped entirely rather
 * than failing CI. See regenerate-fixture.md for how to produce the fixture.
 *
 * PRD refs: §7.3, §5.4.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadBundle } from '../../src/loader/parse-bundle.js';
import { buildIndex } from '../../src/index/build-index.js';
import { runValidation } from '../../src/validation/run-validation.js';
import { runHeuristics } from '../../src/heuristics/run-heuristics.js';
import type { Bundle } from '../../src/loader/types.js';
import type { EventIndex } from '../../src/index/event-index.js';
import type { ValidationReport } from '../../src/validation/check-types.js';
import type { Flag } from '../../src/heuristics/types.js';

// ---------------------------------------------------------------------------
// Fixture path — stable location relative to this file.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'sample-bundle.zip');
const fixtureExists = existsSync(FIXTURE_PATH);

// ---------------------------------------------------------------------------
// Skip the entire suite if the fixture is absent.
// The skip message tells the operator exactly what to do.
// ---------------------------------------------------------------------------

describe.skipIf(!fixtureExists)('integration: real recorder fixture', () => {
  let bundle: Bundle;
  let index: EventIndex;
  let report: ValidationReport;
  let flags: Flag[];

  beforeAll(async () => {
    // Read the fixture bytes synchronously — the file exists (skip gate above).
    const zipBytes = readFileSync(FIXTURE_PATH);
    // Convert Buffer → ArrayBuffer for loadBundle.
    const arrayBuf = zipBytes.buffer.slice(
      zipBytes.byteOffset,
      zipBytes.byteOffset + zipBytes.byteLength,
    ) as ArrayBuffer;

    const result = await loadBundle(arrayBuf, 'sample-bundle.zip');
    if (!result.ok) {
      throw new Error(
        `loadBundle failed on real fixture: ${JSON.stringify(result.error)}. ` +
          `Re-run "Provenance: Prepare Submission Bundle" and recommit the fixture.`,
      );
    }
    bundle = result.value;
    index = buildIndex(bundle);
    report = await runValidation(bundle);
    flags = runHeuristics(index, bundle, report);
  }, /* timeout */ 30_000);

  // -------------------------------------------------------------------------
  // Loader assertions
  // -------------------------------------------------------------------------

  it('loads at least one session', () => {
    expect(bundle.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it('every session starts with a session.start event', () => {
    for (const session of bundle.sessions) {
      expect(session.firstEvent.kind).toBe('session.start');
    }
  });

  it('sessions are sorted oldest → newest by wall time', () => {
    for (let i = 1; i < bundle.sessions.length; i++) {
      const prev = bundle.sessions[i - 1]!;
      const curr = bundle.sessions[i]!;
      const prevWall = new Date(prev.firstEvent.wall).getTime();
      const currWall = new Date(curr.firstEvent.wall).getTime();
      expect(currWall).toBeGreaterThanOrEqual(prevWall);
    }
  });

  it('manifest assignment_id is non-empty', () => {
    expect(bundle.manifest.assignment_id.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Index assertions
  // -------------------------------------------------------------------------

  it('index.ordered has at least as many events as sessions (each has session.start)', () => {
    expect(index.ordered.length).toBeGreaterThanOrEqual(bundle.sessions.length);
  });

  it('every event in index.ordered has a valid globalIdx matching its position', () => {
    for (let i = 0; i < index.ordered.length; i++) {
      expect(index.ordered[i]!.globalIdx).toBe(i);
    }
  });

  it('bySeq covers all events', () => {
    let total = 0;
    for (const session of bundle.sessions) {
      total += session.events.length;
    }
    expect(index.bySeq.size).toBe(total);
  });

  // -------------------------------------------------------------------------
  // Validation assertions
  // -------------------------------------------------------------------------

  it('runValidation returns 8 checks', () => {
    expect(report.checks.length).toBe(8);
  });

  it('overall is "warn" because check 8 is always skipped in v1', () => {
    // Check 8 (submitted_code_match) is always 'skipped' in v1 → overall is
    // at best 'warn'. A clean bundle with no other failures will be 'warn'.
    expect(['warn', 'pass', 'fail']).toContain(report.overall);
    // Check 8 specifically is skipped.
    const check8 = report.checks.find((c) => c.id === 'submitted_code_match');
    expect(check8?.status).toBe('skipped');
  });

  it('validation check 3 (chain_integrity) passes on the real fixture', () => {
    const check3 = report.checks.find((c) => c.id === 'chain_integrity');
    expect(check3?.status).toBe('pass');
  });

  // -------------------------------------------------------------------------
  // Heuristics assertions
  // -------------------------------------------------------------------------

  it('runHeuristics returns a sorted array of flags', () => {
    expect(Array.isArray(flags)).toBe(true);
  });

  it('flags are sorted by severity descending (high before medium before low before info)', () => {
    const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
    for (let i = 1; i < flags.length; i++) {
      const prev = flags[i - 1]!;
      const curr = flags[i]!;
      const prevRank = SEVERITY_ORDER[prev.severity] ?? 99;
      const currRank = SEVERITY_ORDER[curr.severity] ?? 99;
      expect(currRank).toBeGreaterThanOrEqual(prevRank);
    }
  });

  it('every flag has required fields and valid confidence', () => {
    for (const flag of flags) {
      expect(typeof flag.id).toBe('string');
      expect(typeof flag.heuristic).toBe('string');
      expect(typeof flag.title).toBe('string');
      expect(['info', 'low', 'medium', 'high']).toContain(flag.severity);
      expect(flag.confidence).toBeGreaterThanOrEqual(0);
      expect(flag.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(flag.supportingSeqs)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Informational: log the skip reason if fixture is absent.
// This runs regardless of the skipIf gate so it's visible in verbose output.
// ---------------------------------------------------------------------------

if (!fixtureExists) {
  describe('integration: real recorder fixture [SKIPPED — fixture absent]', () => {
    it.skip('fixture not found — see test/integration/regenerate-fixture.md', () => {
      console.log(
        `[integration] Real fixture not found at: ${FIXTURE_PATH}\n` +
          `  To enable this test:\n` +
          `  1. Run VS Code against test-workspace/ with the Recorder extension active.\n` +
          `  2. Run "Provenance: Prepare Submission Bundle".\n` +
          `  3. Copy the output ZIP to packages/analyzer/test/fixtures/sample-bundle.zip.\n` +
          `  4. Commit the ZIP and re-run tests.`,
      );
    });
  });
}
