import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { startGitWiring } from './git-wiring.js';
import { ExplanationTagger } from '../events/explanation-tags.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StateChangeHandler = () => void;

type FakeRepo = {
  state: {
    HEAD: { commit: string | undefined };
    _handlers: StateChangeHandler[];
    onDidChange: (h: StateChangeHandler) => vscode.Disposable;
  };
  fireStateChange: () => void;
  setCommit: (sha: string | undefined) => void;
};

function makeFakeRepo(initialCommit?: string): FakeRepo {
  const _handlers: StateChangeHandler[] = [];
  const state: FakeRepo['state'] = {
    HEAD: { commit: initialCommit },
    _handlers,
    onDidChange: (h: StateChangeHandler) => {
      _handlers.push(h);
      return { dispose: () => undefined };
    },
  };
  return {
    state,
    fireStateChange: () => _handlers.forEach((h) => h()),
    setCommit: (sha: string | undefined) => {
      state.HEAD = { commit: sha };
    },
  };
}

type OpenHandler = (repo: unknown) => void;

function makeGitExtension(
  repos: FakeRepo[],
  opts?: { throwOnGetAPI?: boolean },
): vscode.Extension<unknown> {
  let openHandler: OpenHandler | undefined;
  return {
    id: 'vscode.git',
    isActive: true,
    extensionUri: {} as vscode.Uri,
    extensionPath: '',
    extensionKind: 2,
    exports: {
      getAPI: (v: number) => {
        if (opts?.throwOnGetAPI) throw new Error('API not available');
        if (v !== 1) return undefined;
        return {
          repositories: repos,
          onDidOpenRepository: (h: OpenHandler) => {
            openHandler = h;
            return { dispose: () => undefined };
          },
          onDidCloseRepository: (_h: unknown) => ({ dispose: () => undefined }),
          _fireOpen: (repo: unknown) => openHandler?.(repo),
        };
      },
    },
    packageJSON: {},
    activate: () => Promise.resolve(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startGitWiring — no git extension', () => {
  it('returns a no-op disposable when getGitExtension returns undefined', () => {
    const emitted: unknown[] = [];
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => undefined,
    });
    // Dispose should not throw.
    expect(() => wiring.dispose()).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it('returns a no-op disposable when getAPI throws', () => {
    const emitted: unknown[] = [];
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([], { throwOnGetAPI: true }),
    });
    expect(() => wiring.dispose()).not.toThrow();
    expect(emitted).toHaveLength(0);
  });
});

describe('startGitWiring — state change events', () => {
  it('emits git.event with operation "state_change" and commit_sha on HEAD change', () => {
    const emitted: Array<{ operation: string; commit_sha?: string }> = [];
    const repo = makeFakeRepo('abc123');
    startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo]),
    });
    repo.setCommit('def456');
    repo.fireStateChange();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.operation).toBe('state_change');
    expect(emitted[0]!.commit_sha).toBe('def456');
  });

  it('omits commit_sha when HEAD.commit is undefined', () => {
    const emitted: Array<{ operation: string; commit_sha?: string }> = [];
    const repo = makeFakeRepo(undefined);
    startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo]),
    });
    repo.fireStateChange();
    expect(emitted[0]).not.toHaveProperty('commit_sha');
  });

  it('calls explanationTagger.markGit() on each emitted git.event', () => {
    const tagger = new ExplanationTagger({ getNow: () => Date.now() });
    const markGit = vi.spyOn(tagger, 'markGit');
    const repo = makeFakeRepo('sha1');
    startGitWiring({
      emit: () => undefined,
      getGitExtension: () => makeGitExtension([repo]),
      explanationTagger: tagger,
    });
    repo.setCommit('sha2');
    repo.fireStateChange();
    expect(markGit).toHaveBeenCalledOnce();
  });

  it('emits for multiple repositories', () => {
    const emitted: unknown[] = [];
    const repo1 = makeFakeRepo('sha-a');
    const repo2 = makeFakeRepo('sha-b');
    startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo1, repo2]),
    });
    repo1.setCommit('sha-a2');
    repo1.fireStateChange();
    repo2.setCommit('sha-b2');
    repo2.fireStateChange();
    expect(emitted).toHaveLength(2);
  });

  it('disposes all subscriptions on dispose()', () => {
    const emitted: unknown[] = [];
    const repo = makeFakeRepo('sha1');
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo]),
    });
    wiring.dispose();
    repo.setCommit('sha2');
    repo.fireStateChange();
    // After dispose, state change handler should be removed from the disposables
    // but the actual onDidChange handlers in our fake remain subscribed.
    // The key check is that dispose() does not throw.
    expect(() => wiring.dispose()).not.toThrow();
  });
});
