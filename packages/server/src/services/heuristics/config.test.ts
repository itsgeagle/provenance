/**
 * Unit tests for validateConfig — Phase 13a.
 *
 * Tests are pure (no DB). Integration tests for getActiveConfig and
 * listConfigHistory are in heuristic-config-integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { validateConfig, KNOWN_HEURISTIC_IDS, DEFAULT_SERVER_CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid candidate config from DEFAULT_SERVER_CONFIG for test mutation. */
function validCandidate(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_SERVER_CONFIG)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// validateConfig — positive
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('accepts a valid complete config', () => {
    const result = validateConfig(validCandidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.config_format_version).toBe(1);
      expect(Object.keys(result.config.per_flag)).toHaveLength(KNOWN_HEURISTIC_IDS.size);
      expect(result.config.severity_weights.high).toBe(8);
    }
  });

  it('accepts custom weights in range', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = 5;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  it('accepts weight = 0 (disabled-by-weight)', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['chain_broken'] as Record<string, unknown>)['weight'] = 0;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  it('accepts weight = 100 (max)', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = 100;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  it('accepts config with optional thresholds field', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['thresholds'] = { minChars: 300 };
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — wrong config_format_version
  // ---------------------------------------------------------------------------

  it('rejects config_format_version !== 1', () => {
    const candidate = validCandidate();
    candidate['config_format_version'] = 2;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('config_format_version'))).toBe(true);
    }
  });

  it('rejects missing config_format_version', () => {
    const candidate = validCandidate();
    delete candidate['config_format_version'];
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — missing heuristic ID
  // ---------------------------------------------------------------------------

  it('rejects config with a missing known heuristic ID', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    delete pf['large_paste'];
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('large_paste') && e.includes('missing'))).toBe(
        true,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // validateConfig — unknown heuristic ID
  // ---------------------------------------------------------------------------

  it('rejects config with an unknown heuristic ID', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    pf['super_fake_heuristic'] = { enabled: true, weight: 1.0 };
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes('super_fake_heuristic') && e.includes('unknown')),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // validateConfig — weight out of range
  // ---------------------------------------------------------------------------

  it('rejects weight > 100', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = 101;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('weight'))).toBe(true);
    }
  });

  it('rejects weight < 0', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = -1;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  it('rejects non-finite weight (NaN)', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = NaN;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — severity_weights issues
  // ---------------------------------------------------------------------------

  it('rejects missing severity_weights key', () => {
    const candidate = validCandidate();
    const sw = candidate['severity_weights'] as Record<string, unknown>;
    delete sw['high'];
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('severity_weights.high'))).toBe(true);
    }
  });

  it('rejects negative severity weight', () => {
    const candidate = validCandidate();
    const sw = candidate['severity_weights'] as Record<string, unknown>;
    sw['medium'] = -1;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — non-object input
  // ---------------------------------------------------------------------------

  it('rejects null input', () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('object');
    }
  });

  it('rejects array input', () => {
    const result = validateConfig([]);
    expect(result.ok).toBe(false);
  });

  it('rejects string input', () => {
    const result = validateConfig('{"config_format_version":1}');
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // KNOWN_HEURISTIC_IDS completeness check
  // ---------------------------------------------------------------------------

  it('KNOWN_HEURISTIC_IDS is non-empty', () => {
    expect(KNOWN_HEURISTIC_IDS.size).toBeGreaterThan(0);
  });

  it('DEFAULT_SERVER_CONFIG has an entry for every known ID', () => {
    for (const id of KNOWN_HEURISTIC_IDS) {
      expect(DEFAULT_SERVER_CONFIG.per_flag[id]).toBeDefined();
    }
  });
});
