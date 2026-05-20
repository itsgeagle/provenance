/**
 * Tests for the shell_integration_disabled heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { shellIntegrationDisabledHeuristic } from './shell-integration-disabled.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../../test/helpers/build-test-bundle.js';
import { mergeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const defaultConfig = mergeConfig();

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('shell_integration_disabled — negative', () => {
  it('produces no flags when no terminal.open events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = shellIntegrationDisabledHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when terminal.open has shell_integration: true', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/zsh',
                shell_integration: true,
              },
            },
          ],
        },
      ],
    });
    const flags = shellIntegrationDisabledHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('shell_integration_disabled — positive', () => {
  it('flags a terminal.open with shell_integration: false', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: false,
              },
            },
          ],
        },
      ],
    });
    const flags = shellIntegrationDisabledHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('shell_integration_disabled');
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.confidence).toBe(1.0);
    expect(flags[0]!.detail!['shell']).toBe('/bin/bash');
    expect(flags[0]!.detail!['terminalId']).toBe('term-1');
  });

  it('emits separate flags for multiple terminals with shell_integration: false', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/bash', shell_integration: false },
            },
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-2', shell: '/bin/sh', shell_integration: false },
            },
          ],
        },
      ],
    });
    const flags = shellIntegrationDisabledHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(2);
  });

  it('only flags terminals with shell_integration: false, not true ones', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
            },
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-2', shell: '/bin/bash', shell_integration: false },
            },
          ],
        },
      ],
    });
    const flags = shellIntegrationDisabledHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['terminalId']).toBe('term-2');
  });

  it('flags have unique IDs', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'a', shell: '/bin/bash', shell_integration: false },
            },
            {
              kind: 'terminal.open',
              data: { terminal_id: 'b', shell: '/bin/sh', shell_integration: false },
            },
          ],
        },
      ],
    });
    const flags = shellIntegrationDisabledHeuristic.run(index, bundle, defaultConfig);
    const ids = flags.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
