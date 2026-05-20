/**
 * Tests for the terminal_active_during_external_change heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { terminalActiveDuringExternalChangeHeuristic } from './terminal-active-during-external-change.js';
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

describe('terminal_active_during_external_change — negative', () => {
  it('produces no flags when no fs.external_change events', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when fs.external_change occurs but no terminal is open', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 100,
              },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when terminal opens AFTER the external change', async () => {
    // terminal.open at t=2000, external change at t=1000 → terminal not yet open
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 100,
              },
              t: 1000,
            },
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
              t: 2000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('terminal_active_during_external_change — positive', () => {
  it('flags when terminal is open before fs.external_change', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
              t: 500,
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/hw.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 200,
              },
              t: 1500,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('terminal_active_during_external_change');
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.confidence).toBe(0.6);
    expect(flags[0]!.detail!['filePath']).toBe('/test/hw.py');
    expect(flags[0]!.detail!['diffSize']).toBe(200);
  });

  it('flags at exact same t (terminal open t === change t)', async () => {
    // Same t: terminal opens at t=1000, change at t=1000 → open.t <= change.t → flag
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/bash', shell_integration: true },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 50,
              },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('emits one flag per external change event (not per terminal)', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
              t: 100,
            },
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-2', shell: '/bin/bash', shell_integration: true },
              t: 200,
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 50,
              },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    // Two terminals open, one external change → one flag (per change, not per terminal)
    expect(flags).toHaveLength(1);
  });
});
