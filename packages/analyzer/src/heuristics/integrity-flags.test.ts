/**
 * Tests for the integrity-flags adapter (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { integrityFlagsFromReport } from './integrity-flags.js';
import type { ValidationReport } from '../validation/check-types.js';

// ---------------------------------------------------------------------------
// Helpers to build ValidationReport fixtures
// ---------------------------------------------------------------------------

function makePassReport(): ValidationReport {
  return {
    overall: 'pass',
    checks: [
      { id: 'manifest_sig', label: 'Manifest signature', status: 'pass' },
      { id: 'session_binding', label: 'Session binding', status: 'pass' },
      { id: 'chain_integrity', label: 'Hash chain integrity', status: 'pass' },
      { id: 'seq_gaps', label: 'Sequence gaps', status: 'pass' },
      { id: 'monotonic_t', label: 'Monotonic t', status: 'pass' },
      { id: 'monotonic_wall', label: 'Monotonic wall', status: 'pass' },
      { id: 'doc_save_hashes', label: 'Doc save hashes', status: 'pass' },
      {
        id: 'submitted_code_match',
        label: 'Submitted code match',
        status: 'skipped',
        detail: 'v1 skip',
      },
    ],
  };
}

function makeChainFailReport(
  supportingSeqs?: Array<{ sessionId: string; seq: number }>,
): ValidationReport {
  const base = makePassReport();
  return {
    overall: 'fail',
    checks: base.checks.map((c) =>
      c.id === 'chain_integrity'
        ? {
            id: 'chain_integrity',
            label: 'Hash chain integrity',
            status: 'fail',
            detail: 'Chain broken at entry 5 of session abc.',
            supportingSeqs: supportingSeqs ?? [{ sessionId: 'abc', seq: 5 }],
          }
        : c,
    ),
  };
}

// ---------------------------------------------------------------------------
// Negative: no fail on chain_integrity → no flags
// ---------------------------------------------------------------------------

describe('integrityFlagsFromReport — negative', () => {
  it('produces no flags when all checks pass', () => {
    const report = makePassReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when only non-chain checks fail', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'manifest_sig' ? { ...c, status: 'fail', detail: 'Bad sig' } : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when chain_integrity is skipped', () => {
    const report: ValidationReport = {
      overall: 'warn',
      checks: makePassReport().checks.map((c) =>
        c.id === 'chain_integrity' ? { ...c, status: 'skipped' } : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: chain_integrity fail → one Flag
// ---------------------------------------------------------------------------

describe('integrityFlagsFromReport — positive', () => {
  it('produces one Flag when chain_integrity fails', () => {
    const report = makeChainFailReport([{ sessionId: 'abc', seq: 5 }]);
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
  });

  it('sets heuristic to "chain_broken"', () => {
    const report = makeChainFailReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.heuristic).toBe('chain_broken');
  });

  it('sets severity to "high"', () => {
    const report = makeChainFailReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.severity).toBe('high');
  });

  it('sets confidence to 1.0', () => {
    const report = makeChainFailReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.confidence).toBe(1.0);
  });

  it('copies the check detail as the flag description', () => {
    const report = makeChainFailReport([{ sessionId: 'abc', seq: 5 }]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.description).toBe('Chain broken at entry 5 of session abc.');
  });

  it('converts supportingSeqs to ${sessionId}:${seq} format', () => {
    const report = makeChainFailReport([
      { sessionId: 'session-abc', seq: 5 },
      { sessionId: 'session-abc', seq: 6 },
    ]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.supportingSeqs).toEqual(['session-abc:5', 'session-abc:6']);
  });

  it('produces a deterministic id from the first seq', () => {
    const report = makeChainFailReport([{ sessionId: 'ses', seq: 7 }]);
    const flags1 = integrityFlagsFromReport(report);
    const flags2 = integrityFlagsFromReport(report);
    expect(flags1[0]!.id).toBe(flags2[0]!.id);
    expect(flags1[0]!.id).toBe('chain_broken-ses:7');
  });

  it('uses "no-seq" in id when supportingSeqs is empty', () => {
    const report = makeChainFailReport([]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.id).toBe('chain_broken-no-seq');
    expect(flags[0]!.supportingSeqs).toHaveLength(0);
  });

  it('uses a fallback description when check.detail is absent', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'chain_integrity'
          ? { id: 'chain_integrity', label: 'Hash chain integrity', status: 'fail' }
          : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.description).toContain('tampered');
  });

  it('includes check metadata in detail', () => {
    const report = makeChainFailReport([{ sessionId: 'abc', seq: 5 }]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.detail!['checkId']).toBe('chain_integrity');
    expect(flags[0]!.detail!['entryCount']).toBe(1);
  });
});
