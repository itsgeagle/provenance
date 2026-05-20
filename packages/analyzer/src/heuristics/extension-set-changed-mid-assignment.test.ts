/**
 * Tests for the extension_set_changed_mid_assignment heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { extensionSetChangedMidAssignmentHeuristic } from './extension-set-changed-mid-assignment.js';
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

describe('extension_set_changed_mid_assignment — negative', () => {
  it('produces no flags when no ext.activate events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = extensionSetChangedMidAssignmentHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when AI extension activates but was already in snapshot', async () => {
    // Copilot is in the snapshot → activate does NOT trigger this heuristic
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
    const flags = extensionSetChangedMidAssignmentHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when non-AI extension activates mid-session', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.activate',
              data: { id: 'ms-python.python', version: '2023.1.0' },
            },
          ],
        },
      ],
    });
    const flags = extensionSetChangedMidAssignmentHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('extension_set_changed_mid_assignment — positive', () => {
  it('flags an AI extension activated mid-session with no snapshot', async () => {
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
    const flags = extensionSetChangedMidAssignmentHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('extension_set_changed_mid_assignment');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.confidence).toBe(0.85);
    expect(flags[0]!.detail!['extensionId']).toBe('GitHub.copilot');
    expect(flags[0]!.detail!['wasInSnapshot']).toBe(false);
  });

  it('flags an AI extension activated mid-session when snapshot existed but lacked it', async () => {
    // Snapshot exists but only lists a different extension
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.snapshot',
              data: {
                extensions: [{ id: 'ms-python.python', version: '1.0.0', enabled: true }],
              },
            },
            {
              kind: 'ext.activate',
              data: { id: 'Codeium.codeium', version: '3.0.0' },
            },
          ],
        },
      ],
    });
    const flags = extensionSetChangedMidAssignmentHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['extensionId']).toBe('Codeium.codeium');
  });

  it('flags have deterministic IDs', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'ext.activate',
              data: { id: 'GitHub.copilot', version: '1.0.0' },
            },
          ],
        },
      ],
    });
    const flags1 = extensionSetChangedMidAssignmentHeuristic.run(index, bundle, testConfig);
    const flags2 = extensionSetChangedMidAssignmentHeuristic.run(index, bundle, testConfig);
    expect(flags1[0]!.id).toBe(flags2[0]!.id);
  });
});
