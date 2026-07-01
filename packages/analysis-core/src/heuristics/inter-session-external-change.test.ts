/**
 * Tests for the inter_session_external_change heuristic.
 */

import { describe, it, expect } from 'vitest';
import { interSessionExternalChangeHeuristic } from './inter-session-external-change.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';

const cfg = DEFAULT_HEURISTIC_CONFIG;

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

// Convenience: build a session that opens `file` at `content`, types one
// `appended` chunk at the end, then saves.
function sessionThat(file: string, openContent: string, appended: string): EventSpec[] {
  return [
    { kind: 'doc.open', data: { path: file, content: openContent } },
    {
      kind: 'doc.change',
      data: {
        path: file,
        source: 'typed',
        deltas: [
          {
            range: {
              start: { line: 0, character: openContent.length },
              end: { line: 0, character: openContent.length },
            },
            text: appended,
          },
        ],
      },
    },
    { kind: 'doc.save', data: { path: file, sha256: 'unused-in-this-test' } },
  ];
}

describe('inter_session_external_change', () => {
  it('emits no flags for a single-session bundle', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: sessionThat('hw1.py', '', 'def foo():\n    return 1\n') }],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('emits no flags when the file is unchanged across the gap', async () => {
    const finalA = 'def foo():\n    return 1\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', 'def foo():\n    return 1\n') },
        { events: sessionThat('hw1.py', finalA, '    # comment\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('flags a file that diverged between sessions', async () => {
    const finalA = 'def foo():\n    return 1\n';
    // Simulated external edit: someone added a print between sessions.
    const externallyEdited = finalA + 'print("oops")\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        { events: sessionThat('hw1.py', externallyEdited, '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);

    const f = flags[0]!;
    expect(f.heuristic).toBe('inter_session_external_change');
    expect(f.title).toContain('hw1.py');
    // |26 - 38| = 12, below default highSeverityCharsChanged (100) → medium.
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBeCloseTo(0.85);
    expect(f.supportingSeqs).toHaveLength(1);
    const detail = f.detail as Record<string, unknown>;
    expect(detail['file']).toBe('hw1.py');
    expect(detail['prev_length']).toBe(finalA.length);
    expect(detail['next_length']).toBe(externallyEdited.length);
  });

  it('marks divergence above the threshold as high severity', async () => {
    const finalA = 'x = 1\n';
    // Massive divergence.
    const externallyEdited = finalA + 'y = 2\n'.repeat(40); // 240 chars added
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        { events: sessionThat('hw1.py', externallyEdited, '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('does not flag files that the prior session never touched', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', 'a = 1\n') },
        // Session 2 opens a different file. We have no prior reconstruction
        // for utils.py from session 1, so we skip.
        { events: sessionThat('utils.py', 'def helper():\n    pass\n', '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag when the second session uses pre-v1.1 doc.open without content', async () => {
    const finalA = 'def foo():\n    return 1\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        {
          events: [
            // No content field → pre-v1.1 recorder. Cannot detect divergence.
            { kind: 'doc.open', data: { path: 'hw1.py' } },
            { kind: 'doc.save', data: { path: 'hw1.py', sha256: 'unused' } },
          ],
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});
