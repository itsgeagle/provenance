/**
 * Tests for fs-watcher.ts
 * PRD §4.5: FileSystemWatcher-based external change detection.
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Capture createFileSystemWatcher calls via vi.hoisted + vi.mock
// ---------------------------------------------------------------------------

type ChangeHandler = (uri: { fsPath: string }) => void;

const { capturedWatchers, getWatchers } = vi.hoisted(() => {
  const _watchers: Array<{
    pattern: unknown;
    changeHandler: ChangeHandler | null;
    createHandler: ChangeHandler | null;
    deleteHandler: ChangeHandler | null;
    disposed: boolean;
    dispose: () => void;
  }> = [];

  return {
    capturedWatchers: _watchers,
    getWatchers: () => _watchers,
  };
});

vi.mock('vscode', () => {
  class RelativePattern {
    constructor(
      public base: unknown,
      public pattern: string,
    ) {}
  }

  return {
    RelativePattern,
    workspace: {
      createFileSystemWatcher: (pattern: unknown) => {
        const w = {
          pattern,
          changeHandler: null as ChangeHandler | null,
          createHandler: null as ChangeHandler | null,
          deleteHandler: null as ChangeHandler | null,
          disposed: false,
          onDidChange(handler: ChangeHandler) {
            this.changeHandler = handler;
            return { dispose: () => undefined };
          },
          onDidCreate(handler: ChangeHandler) {
            this.createHandler = handler;
            return { dispose: () => undefined };
          },
          onDidDelete(handler: ChangeHandler) {
            this.deleteHandler = handler;
            return { dispose: () => undefined };
          },
          dispose() {
            this.disposed = true;
          },
        };
        capturedWatchers.push(w);
        return w;
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------

import { startFsWatcher } from './fs-watcher.js';
import { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import { ExplanationTagger } from '../events/explanation-tags.js';
import { sha256Hex } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(filesUnderReview: string[]) {
  return new ExpectedContentRegistry(filesUnderReview);
}

// Flush all pending microtasks / Promises
async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startFsWatcher', () => {
  it('creates one watcher per file in filesUnderReview', () => {
    capturedWatchers.length = 0;
    const registry = makeRegistry(['hw.py', 'utils.py']);

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py', 'utils.py'],
      registry,
      emit: vi.fn(),
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(''),
    });

    expect(getWatchers().length).toBe(2);
  });

  it('disposes all watchers on dispose()', () => {
    capturedWatchers.length = 0;
    const registry = makeRegistry(['hw.py']);

    const disposable = startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit: vi.fn(),
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(''),
    });

    expect(getWatchers()[0]?.disposed).toBe(false);
    disposable.dispose();
    expect(getWatchers()[0]?.disposed).toBe(true);
  });

  it('does NOT emit when change is within tolerance of last doc.change', async () => {
    capturedWatchers.length = 0;
    const content = 'original content';
    const registry = makeRegistry(['hw.py']);
    registry.getOrCreate('hw.py', content);

    const emit = vi.fn();
    const now = 1000;

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      // Last doc.change was 100ms ago; tolerance is default 250ms → within tolerance
      getLastDocChangeAt: () => now - 100,
      getNow: () => now,
      readFile: vi.fn().mockResolvedValue('different content on disk'),
      recentDocChangeToleranceMs: 250,
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits fs.external_change when content changed outside tolerance', async () => {
    capturedWatchers.length = 0;
    const originalContent = 'def foo(): pass';
    const newContent = 'def foo(): return 42  # edited externally';
    const registry = makeRegistry(['hw.py']);
    registry.getOrCreate('hw.py', originalContent);

    const emit = vi.fn();
    const now = 10000;

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      // Last doc.change was 5 seconds ago — way outside tolerance
      getLastDocChangeAt: () => now - 5000,
      getNow: () => now,
      readFile: vi.fn().mockResolvedValue(newContent),
      recentDocChangeToleranceMs: 250,
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).toHaveBeenCalledOnce();

    const payload = emit.mock.calls[0]![0] as {
      path: string;
      old_hash: string;
      new_hash: string;
      diff_size: number;
      new_content?: string;
      new_content_size?: number;
    };
    expect(payload.path).toBe('hw.py');
    expect(payload.old_hash).toBe(sha256Hex(originalContent));
    expect(payload.new_hash).toBe(sha256Hex(newContent));
    expect(payload.diff_size).toBe(Math.abs(newContent.length - originalContent.length));
    // Recorder v1.3+: payload carries the on-disk content for analyzer replay.
    expect(payload.new_content).toBe(newContent);
    expect(payload.new_content_size).toBe(newContent.length);
  });

  it('resets registry expected content after emitting', async () => {
    capturedWatchers.length = 0;
    const originalContent = 'original';
    const newContent = 'totally changed externally';
    const registry = makeRegistry(['hw.py']);
    registry.getOrCreate('hw.py', originalContent);

    const now = 10000;

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit: vi.fn(),
      getLastDocChangeAt: () => -Infinity,
      getNow: () => now,
      readFile: vi.fn().mockResolvedValue(newContent),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();

    // Registry should now reflect on-disk content
    const ec = registry.get('hw.py');
    expect(ec?.content).toBe(newContent);
    expect(ec?.hash).toBe(sha256Hex(newContent));
  });

  it('does NOT emit when file is not in registry (never opened)', async () => {
    capturedWatchers.length = 0;
    // Registry exists but this file was never getOrCreate'd — get() returns undefined
    const registry = makeRegistry(['hw.py']);
    // Deliberately do NOT call registry.getOrCreate('hw.py', ...)

    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 10000,
      readFile: vi.fn().mockResolvedValue('some content'),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT emit when on-disk content is identical to expected (no real change)', async () => {
    capturedWatchers.length = 0;
    const content = 'same content';
    const registry = makeRegistry(['hw.py']);
    registry.getOrCreate('hw.py', content);

    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 10000,
      // Returns the same content — no real change
      readFile: vi.fn().mockResolvedValue(content),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).not.toHaveBeenCalled();
  });

  it('attaches explanation tag when tagger has a recent mark', async () => {
    capturedWatchers.length = 0;
    const originalContent = 'before';
    const newContent = 'after formatter ran';
    const registry = makeRegistry(['hw.py']);
    registry.getOrCreate('hw.py', originalContent);

    let now = 0;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });
    tagger.markFormatter();
    now = 500;

    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => now,
      readFile: vi.fn().mockResolvedValue(newContent),
      explanationTagger: tagger,
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as { explanation?: string };
    expect(payload.explanation).toBe('formatter');
  });

  it('does not attach explanation when tagger has no mark', async () => {
    capturedWatchers.length = 0;
    const originalContent = 'before';
    const newContent = 'after';
    const registry = makeRegistry(['hw.py']);
    registry.getOrCreate('hw.py', originalContent);

    const now = 10000;
    const tagger = new ExplanationTagger({ getNow: () => now, windowMs: 2000 });
    // No marks

    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => now,
      readFile: vi.fn().mockResolvedValue(newContent),
      explanationTagger: tagger,
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as { explanation?: string };
    expect(payload.explanation).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // onDidCreate / onDidDelete (recorder v1.3+, PRD §4.5)
  // -------------------------------------------------------------------------

  it('onDidCreate: file appears with no prior baseline → emits operation:create + seeds registry', async () => {
    capturedWatchers.length = 0;
    const newContent = 'def fresh(): return 1\n';
    const registry = new ExpectedContentRegistry(['hw.py']);
    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(newContent),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.createHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as {
      operation: string;
      old_hash: string;
      new_hash: string;
      diff_size: number;
      new_content?: string;
    };
    expect(payload.operation).toBe('create');
    expect(payload.old_hash).toBe('');
    expect(payload.new_hash).toBe(sha256Hex(newContent));
    expect(payload.diff_size).toBe(newContent.length);
    expect(payload.new_content).toBe(newContent);

    // Registry is seeded so subsequent edits chain from this baseline.
    const ec = registry.get('hw.py');
    expect(ec?.content).toBe(newContent);
    expect(ec?.hash).toBe(sha256Hex(newContent));
  });

  it('onDidCreate: file already in registry with same hash → no emit (race with doc.open)', async () => {
    capturedWatchers.length = 0;
    const content = 'already there\n';
    const registry = new ExpectedContentRegistry(['hw.py']);
    registry.getOrCreate('hw.py', content);
    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(content),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.createHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).not.toHaveBeenCalled();
  });

  it('onDidCreate: registry exists but disk content differs → emits operation:modify', async () => {
    capturedWatchers.length = 0;
    const seeded = 'old skeleton\n';
    const disk = 'completely different content\n';
    const registry = new ExpectedContentRegistry(['hw.py']);
    registry.getOrCreate('hw.py', seeded);
    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(disk),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.createHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as { operation: string; old_hash: string };
    expect(payload.operation).toBe('modify');
    expect(payload.old_hash).toBe(sha256Hex(seeded));
  });

  it('onDidDelete: registered file → emits operation:delete + clears registry', () => {
    capturedWatchers.length = 0;
    const content = 'about to vanish\n';
    const registry = new ExpectedContentRegistry(['hw.py']);
    registry.getOrCreate('hw.py', content);
    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(''),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.deleteHandler?.({ fsPath: '/workspace/hw.py' });

    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as {
      operation: string;
      old_hash: string;
      new_hash: string;
      diff_size: number;
      new_content?: string;
    };
    expect(payload.operation).toBe('delete');
    expect(payload.old_hash).toBe(sha256Hex(content));
    expect(payload.new_hash).toBe('');
    expect(payload.diff_size).toBe(content.length);
    expect(payload.new_content).toBeUndefined();

    // Registry entry should be gone.
    expect(registry.get('hw.py')).toBeUndefined();
  });

  it('onDidDelete: untracked file → still emits delete with empty old_hash', () => {
    capturedWatchers.length = 0;
    const registry = new ExpectedContentRegistry(['hw.py']);
    // No getOrCreate — file was never opened in VS Code.
    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile: vi.fn().mockResolvedValue(''),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.deleteHandler?.({ fsPath: '/workspace/hw.py' });

    expect(emit).toHaveBeenCalledOnce();
    const payload = emit.mock.calls[0]![0] as {
      operation: string;
      old_hash: string;
      new_hash: string;
    };
    expect(payload.operation).toBe('delete');
    expect(payload.old_hash).toBe('');
    expect(payload.new_hash).toBe('');
  });

  it('delete then create: registry is cleared by delete, then re-seeded by the subsequent create', async () => {
    capturedWatchers.length = 0;
    const original = 'original\n';
    const replacement = 'replacement\n';
    const registry = new ExpectedContentRegistry(['hw.py']);
    registry.getOrCreate('hw.py', original);
    const emit = vi.fn();

    const readFile = vi.fn().mockResolvedValue(replacement);

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 1000,
      readFile,
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );

    // 1. Delete fires.
    watcher?.deleteHandler?.({ fsPath: '/workspace/hw.py' });
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0]![0] as { operation: string }).operation).toBe('delete');
    expect(registry.get('hw.py')).toBeUndefined();

    // 2. Create fires (e.g. tool finished writing).
    watcher?.createHandler?.({ fsPath: '/workspace/hw.py' });
    await flushPromises();
    expect(emit).toHaveBeenCalledTimes(2);
    const createPayload = emit.mock.calls[1]![0] as {
      operation: string;
      old_hash: string;
      new_content?: string;
    };
    expect(createPayload.operation).toBe('create');
    expect(createPayload.old_hash).toBe('');
    expect(createPayload.new_content).toBe(replacement);
    expect(registry.get('hw.py')?.content).toBe(replacement);
  });

  it('existing modify path now emits operation:modify explicitly', async () => {
    capturedWatchers.length = 0;
    const originalContent = 'def hello(): pass\n';
    const newContent = 'def hello(): return 42\n';
    const registry = new ExpectedContentRegistry(['hw.py']);
    registry.getOrCreate('hw.py', originalContent);
    const emit = vi.fn();

    startFsWatcher({
      assignmentRoot: '/workspace',
      filesUnderReview: ['hw.py'],
      registry,
      emit,
      getLastDocChangeAt: () => -Infinity,
      getNow: () => 10_000,
      readFile: vi.fn().mockResolvedValue(newContent),
    });

    const watcher = getWatchers().find(
      (w) => (w.pattern as { pattern: string }).pattern === 'hw.py',
    );
    watcher?.changeHandler?.({ fsPath: '/workspace/hw.py' });

    await flushPromises();
    expect(emit).toHaveBeenCalledOnce();
    expect((emit.mock.calls[0]![0] as { operation: string }).operation).toBe('modify');
  });
});
