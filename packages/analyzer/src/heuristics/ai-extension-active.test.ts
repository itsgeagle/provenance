/**
 * Tests for the ai_extension_active heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { aiExtensionActiveHeuristic, DEFAULT_AI_EXTENSION_IDS } from './ai-extension-active.js';
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

const testConfig = mergeConfig({
  aiExtensionActive: { knownAiExtensions: ['GitHub.copilot', 'Codeium.codeium'] },
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('ai_extension_active — negative', () => {
  it('produces no flags when no ext.snapshot or ext.activate events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when snapshot has non-AI extensions only', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [
                  { id: 'ms-python.python', version: '2023.1.0', enabled: true },
                  { id: 'esbenp.prettier-vscode', version: '10.0.0', enabled: true },
                ],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when AI extension is in snapshot but disabled', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'GitHub.copilot', version: '1.0.0', enabled: false }],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('still flags built-in known AI extensions when the course list is empty', async () => {
    // The course list is additive on top of the built-in classifier; emptying
    // it does not disable detection of a recognized AI extension.
    const emptyConfig = mergeConfig({ aiExtensionActive: { knownAiExtensions: [] } });
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'GitHub.copilot', version: '1.0.0', enabled: true }],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, emptyConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(0.9);
    expect(flags[0]!.detail!['matchTier']).toBe('curated');
  });

  it('does not flag a non-AI extension even when the course list is empty', async () => {
    const emptyConfig = mergeConfig({ aiExtensionActive: { knownAiExtensions: [] } });
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'esbenp.prettier-vscode', version: '10.0.0', enabled: true }],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, emptyConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('ai_extension_active — positive (ext.snapshot)', () => {
  it('flags an enabled AI extension in ext.snapshot', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'GitHub.copilot', version: '1.155.0', enabled: true }],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('ai_extension_active');
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.confidence).toBe(0.9);
    expect(flags[0]!.detail!['extensionId']).toBe('GitHub.copilot');
    expect(flags[0]!.detail!['detectedVia']).toBe('ext.snapshot');
  });

  it('flags multiple different AI extensions in one snapshot', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [
                  { id: 'GitHub.copilot', version: '1.0.0', enabled: true },
                  { id: 'Codeium.codeium', version: '1.2.0', enabled: true },
                ],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(2);
    const extIds = flags.map((f) => f.detail!['extensionId']);
    expect(extIds).toContain('GitHub.copilot');
    expect(extIds).toContain('Codeium.codeium');
  });
});

describe('ai_extension_active — confidence tiers', () => {
  it('flags a curated id (not on the course list) at 0.9 with curated tier', async () => {
    // Claude Code is in the built-in curated set but not in testConfig's list.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'anthropic.claude-code', version: '1.0.0', enabled: true }],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(0.9);
    expect(flags[0]!.detail!['matchTier']).toBe('curated');
    expect(flags[0]!.detail!['aiReason']).toBe('known AI extension');
  });

  it('flags a token-only match at reduced confidence 0.6 with token tier', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'somevendor.gpt-helper', version: '0.1.0', enabled: true }],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(0.6);
    expect(flags[0]!.detail!['matchTier']).toBe('token');
    expect(flags[0]!.detail!['aiReason']).toBe("id contains 'gpt'");
  });

  it('flags a course-list id at 0.9 with reason "on course AI-tool list"', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'GitHub.copilot', version: '1.0.0', enabled: true }],
              },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(0.9);
    expect(flags[0]!.detail!['aiReason']).toBe('on course AI-tool list');
  });
});

describe('ai_extension_active — positive (ext.activate)', () => {
  it('flags an AI extension via ext.activate', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.activate',
              data: { id: 'GitHub.copilot', version: '1.155.0' },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['detectedVia']).toBe('ext.activate');
  });
});

describe('ai_extension_active — deduplication', () => {
  it('emits only one flag when the same AI extension appears in both snapshot and activate', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'GitHub.copilot', version: '1.0.0', enabled: true }],
              },
            },
            {
              kind: 'ext.activate',
              data: { id: 'GitHub.copilot', version: '1.0.0' },
            },
          ],
        },
      ],
    });
    const flags = aiExtensionActiveHeuristic.run(index, bundle, testConfig);
    // Only one flag — snapshot is processed first and marks the extension as flagged.
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['detectedVia']).toBe('ext.snapshot');
  });
});

describe('ai_extension_active — config JSON defaults', () => {
  it('DEFAULT_AI_EXTENSION_IDS includes the major known AI tools', () => {
    expect(DEFAULT_AI_EXTENSION_IDS).toContain('GitHub.copilot');
    expect(DEFAULT_AI_EXTENSION_IDS).toContain('Codeium.codeium');
    expect(DEFAULT_AI_EXTENSION_IDS).toContain('Continue.continue');
    expect(DEFAULT_AI_EXTENSION_IDS).toContain('TabNine.tabnine-vscode');
  });

  it('DEFAULT_AI_EXTENSION_IDS is a non-empty array', () => {
    expect(DEFAULT_AI_EXTENSION_IDS.length).toBeGreaterThan(0);
  });
});
