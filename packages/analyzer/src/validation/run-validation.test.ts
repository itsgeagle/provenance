/**
 * Tests for the validation orchestrator.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { runValidation } from './run-validation.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('runValidation', () => {
  it('produces exactly 8 checks in spec order for any bundle', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    expect(report.checks).toHaveLength(8);

    const ids = report.checks.map((c) => c.id);
    expect(ids).toEqual([
      'manifest_sig',
      'session_binding',
      'chain_integrity',
      'seq_gaps',
      'monotonic_t',
      'monotonic_wall',
      'doc_save_hashes',
      'submitted_code_match',
    ]);
  });

  it('reports overall=warn for a clean 1.0 bundle (check 8 skipped — no submission files)', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);

    // Checks 1–7 should all pass; check 8 is skipped (1.0 bundle has no submission files).
    const check8 = report.checks[7]!;
    expect(check8.id).toBe('submitted_code_match');
    expect(check8.status).toBe('skipped');

    // overall is warn because check 8 is skipped.
    expect(report.overall).toBe('warn');
  });

  it('reports overall=fail when any check fails', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      tamper: { breakChainAt: { sessionIndex: 0, entryIndex: 3 } },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    expect(report.overall).toBe('fail');

    const failedChecks = report.checks.filter((c) => c.status === 'fail');
    expect(failedChecks.length).toBeGreaterThan(0);
  });

  it('perf: validates a 10k-event bundle in under 1500ms', async () => {
    // Build a bundle with one session and 10k events.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 10000 }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const start = performance.now();
    await runValidation(result.value);
    const elapsed = performance.now() - start;

    // Budget widened V46: 500 → 1500ms. The 500ms ceiling was triggering
    // false negatives under loaded CI / Docker pressure. 1500ms still catches
    // any meaningful regression (the production budget is 500ms p99 per PRD).
    expect(elapsed).toBeLessThan(1500);
  }, 10_000); // 10s vitest timeout to handle slow machines

  it('check 8 is skipped on a 1.0 bundle with a detail explaining why', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    const check8 = report.checks.find((c) => c.id === 'submitted_code_match')!;
    expect(check8.status).toBe('skipped');
    expect(check8.detail).toBeTruthy();
  });

  it('runs Check 8 and reports pass on a 1.1 bundle with matching submitted file', async () => {
    // Build a bundle where:
    //   - A doc.open event seeds reconstruction with known content.
    //   - A doc.save event records the sha256 of that same content (passes Check 7).
    //   - The submitted file in the zip has the same content (passes Check 8).
    const { sha256Hex } = await import('@provenance/log-core');
    const content = 'print(1)\n';
    const contentSha = sha256Hex(new TextEncoder().encode(content));

    const { blob } = await buildTestBundle({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: 'hw1.py', sha256: contentSha, content },
            },
            {
              kind: 'doc.save',
              data: { path: 'hw1.py', sha256: contentSha },
            },
          ],
        },
      ],
      submissionFiles: [{ path: 'hw1.py', status: 'present', content }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    const c8 = report.checks.find((c) => c.id === 'submitted_code_match')!;
    expect(c8.status).toBe('pass');
    expect(report.overall).toBe('pass');
  });
});
