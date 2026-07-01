/**
 * Tests for the no_intermediate_errors heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { noIntermediateErrorsHeuristic } from './no-intermediate-errors.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const cfg = DEFAULT_HEURISTIC_CONFIG;

// ---------------------------------------------------------------------------
// Degraded: shell_integration: false → skipped info flag
// ---------------------------------------------------------------------------

describe('no_intermediate_errors — shell integration disabled', () => {
  it('emits an info skipped flag when terminal.open has shell_integration: false', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: false, // disabled
              },
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 hw1.py', exit_code: 0 },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('no_intermediate_errors');
    expect(flag.severity).toBe('info');
    expect(flag.detail!['reason']).toBe('shell_integration_disabled');
  });

  it('does not emit a skipped flag when shell_integration: true', async () => {
    // shell_integration: true AND all exits 0 → medium flag (not skipped)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: true,
              },
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 hw1.py', exit_code: 0 },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    const infoFlags = flags.filter(
      (f) => f.severity === 'info' && f.detail!['reason'] === 'shell_integration_disabled',
    );
    expect(infoFlags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: all commands exit 0 (no intermediate errors)
// ---------------------------------------------------------------------------

describe('no_intermediate_errors — positive (all exits succeed)', () => {
  it('flags a session where all commands exit with code 0', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: true,
              },
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 hw1.py', exit_code: 0 },
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 test.py', exit_code: 0 },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    const mediumFlags = flags.filter(
      (f) => f.heuristic === 'no_intermediate_errors' && f.severity === 'medium',
    );
    expect(mediumFlags.length).toBeGreaterThanOrEqual(1);
    expect(mediumFlags[0]!.confidence).toBe(0.65);
  });
});

// ---------------------------------------------------------------------------
// Negative: at least one command exits non-zero → no flag
// ---------------------------------------------------------------------------

describe('no_intermediate_errors — negative (has errors)', () => {
  it('does not flag a session where at least one command exits non-zero', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: true,
              },
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 hw1.py', exit_code: 1 }, // error
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 hw1.py', exit_code: 0 }, // later succeeds
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    const mediumFlags = flags.filter(
      (f) => f.heuristic === 'no_intermediate_errors' && f.severity === 'medium',
    );
    expect(mediumFlags).toHaveLength(0);
  });

  it('does not flag a session with no terminal activity', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    const anyNoErrorFlags = flags.filter((f) => f.heuristic === 'no_intermediate_errors');
    expect(anyNoErrorFlags).toHaveLength(0);
  });
});
