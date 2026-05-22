/**
 * Tests for computeScore — PRD §10.3 scoring formula.
 *
 * Pure function; no DB, no I/O.
 */

import { describe, it, expect } from 'vitest';
import { computeScore } from './compute.js';

describe('computeScore', () => {
  it('empty flags list → { score_total: 0, score_max_severity: "info" }', () => {
    const result = computeScore([]);
    expect(result.score_total).toBe(0);
    expect(result.score_max_severity).toBe('info');
  });

  it('single flag: score_total equals its score_contribution', () => {
    const result = computeScore([{ severity: 'medium', score_contribution: 2.4 }]);
    expect(result.score_total).toBeCloseTo(2.4);
    expect(result.score_max_severity).toBe('medium');
  });

  it('score_max_severity is the highest severity among flags (high > medium > low > info)', () => {
    const flags = [
      { severity: 'low', score_contribution: 1.0 },
      { severity: 'high', score_contribution: 6.4 },
      { severity: 'medium', score_contribution: 2.4 },
    ];
    const result = computeScore(flags);
    expect(result.score_max_severity).toBe('high');
  });

  it('score_total is the sum of all score_contributions', () => {
    const flags = [
      { severity: 'low', score_contribution: 1.0 },
      { severity: 'medium', score_contribution: 2.4 },
      { severity: 'high', score_contribution: 6.4 },
    ];
    const result = computeScore(flags);
    expect(result.score_total).toBeCloseTo(9.8);
  });

  it('single info flag → score_max_severity is "info"', () => {
    const result = computeScore([{ severity: 'info', score_contribution: 0 }]);
    expect(result.score_max_severity).toBe('info');
  });

  it('multiple flags with same severity → correct sum and max', () => {
    const flags = [
      { severity: 'medium', score_contribution: 1.2 },
      { severity: 'medium', score_contribution: 1.2 },
      { severity: 'medium', score_contribution: 1.2 },
    ];
    const result = computeScore(flags);
    expect(result.score_total).toBeCloseTo(3.6);
    expect(result.score_max_severity).toBe('medium');
  });
});
