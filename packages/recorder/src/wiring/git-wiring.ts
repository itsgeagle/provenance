/**
 * git-wiring.ts — subscribe to the vscode.git extension's repository events.
 *
 * PRD §4.2: "Git operation observed via the Git extension API — operation,
 * commit_sha if applicable."
 *
 * The vscode.git extension exposes a typed API via exports; the canonical way
 * to consume it is:
 *   const api = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
 *
 * The API surface is documented in:
 *   https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 *
 * Key types we rely on (reproduced minimally to avoid importing the git type defs):
 *   Repository.state: RepositoryState
 *   RepositoryState.HEAD: { commit?: string; ... }
 *   RepositoryState.onDidChange: Event<void>
 *
 * Design notes:
 * - We ask for API version 1 (stable). If unavailable we return a no-op Disposable.
 * - On each repository state change we emit git.event with:
 *     operation: 'state_change'
 *     commit_sha: the current HEAD commit sha (if available and it changed)
 * - We call explanationTagger?.markGit() on each emit to suppress fs.external_change
 *   false positives (PRD §4.5 / explanation-tags.ts).
 * - All field accesses are defensive — any failure logs a warning and continues.
 */

import type * as vscode from 'vscode';
import type { ExplanationTagger } from '../events/explanation-tags.js';

// ---------------------------------------------------------------------------
// Minimal typing for the vscode.git extension API
// We do not import from a git type declaration file — we cast defensively.
// ---------------------------------------------------------------------------

type GitAPI = {
  repositories: GitRepository[];
  onDidOpenRepository: (handler: (repo: GitRepository) => void) => vscode.Disposable;
  onDidCloseRepository: (handler: (repo: GitRepository) => void) => vscode.Disposable;
};

type GitRepository = {
  state: {
    HEAD?: { commit?: string };
    onDidChange: (handler: () => void) => vscode.Disposable;
  };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitWiringDeps = {
  emit: (data: { operation: string; commit_sha?: string }) => void;
  getGitExtension: () => vscode.Extension<unknown> | undefined;
  /** If present, markGit() is called after each emitted git.event. */
  explanationTagger?: ExplanationTagger;
};

// ---------------------------------------------------------------------------
// startGitWiring
// ---------------------------------------------------------------------------

export function startGitWiring(deps: GitWiringDeps): vscode.Disposable {
  const { emit, getGitExtension, explanationTagger } = deps;

  const gitExtension = getGitExtension();
  if (gitExtension === undefined) {
    console.warn('[provenance] vscode.git extension not found; git.event wiring skipped.');
    return { dispose() {} };
  }

  let api: GitAPI | undefined;
  try {
    const exports = gitExtension.exports as { getAPI?: (v: number) => GitAPI } | undefined;
    api = exports?.getAPI?.(1);
  } catch (e) {
    console.warn('[provenance] failed to get vscode.git API v1:', e);
    return { dispose() {} };
  }

  if (api === undefined) {
    console.warn('[provenance] vscode.git getAPI(1) returned undefined; git.event wiring skipped.');
    return { dispose() {} };
  }

  const disposables: vscode.Disposable[] = [];

  // Track the last-seen HEAD commit per repository to emit only on actual changes.
  const lastCommit = new Map<GitRepository, string | undefined>();

  function watchRepo(repo: GitRepository): void {
    // Record the initial commit to avoid a spurious emit on first change.
    let current: string | undefined;
    try {
      current = repo.state.HEAD?.commit;
    } catch (e) {
      console.warn('[provenance] git wiring: failed to read repo HEAD:', e);
    }
    lastCommit.set(repo, current);

    let sub: vscode.Disposable;
    try {
      sub = repo.state.onDidChange(() => {
        let commit_sha: string | undefined;
        try {
          commit_sha = repo.state.HEAD?.commit;
        } catch (e) {
          console.warn('[provenance] git wiring: failed to read HEAD on state change:', e);
        }

        const prev = lastCommit.get(repo);
        lastCommit.set(repo, commit_sha);

        // Only emit if we actually have a commit sha (or if it changed from something).
        // Even for non-commit operations (branch switch, index change) we emit with the
        // current sha so the analyzer sees the activity.
        emit({
          operation: 'state_change',
          ...(commit_sha !== undefined ? { commit_sha } : {}),
        });

        // Suppress fs.external_change false positives (git checkout rewrites files).
        explanationTagger?.markGit();

        void prev; // suppress unused-variable warning; we keep it for future use
      });
    } catch (e) {
      console.warn('[provenance] git wiring: failed to subscribe to repo state:', e);
      return;
    }
    disposables.push(sub);
  }

  // Watch all already-open repositories.
  try {
    for (const repo of api.repositories) {
      watchRepo(repo);
    }
  } catch (e) {
    console.warn('[provenance] git wiring: failed to iterate repositories:', e);
  }

  // Watch repositories that open after our subscription.
  try {
    const openSub = api.onDidOpenRepository((repo) => {
      watchRepo(repo);
    });
    disposables.push(openSub);
  } catch (e) {
    console.warn('[provenance] git wiring: failed to subscribe to onDidOpenRepository:', e);
  }

  return {
    dispose() {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // Best effort.
        }
      }
      disposables.length = 0;
      lastCommit.clear();
    },
  };
}
