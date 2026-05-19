/**
 * extension-activation.ts — poll vscode.extensions.all for newly-active extensions.
 *
 * PRD §4.2: "Another extension activates while we're recording — ext.activate."
 *
 * VS Code has no public onDidActivateExtension event. The pragmatic v1 approach:
 * poll every 1s, diff against the last-known active set, emit ext.activate for
 * transitions from inactive → active.
 *
 * This catches activation reliably at up to 1s latency, which is sufficient for
 * the analyzer's "new AI extension activated mid-session" signal (PRD §7.3).
 */

import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtensionActivationDeps = {
  /** Override poll interval in ms. Default: 1000. */
  intervalMs?: number;
  emit: (data: { id: string; version: string }) => void;
  getExtensions: () => readonly vscode.Extension<unknown>[];
};

// ---------------------------------------------------------------------------
// startExtensionActivation
// ---------------------------------------------------------------------------

export function startExtensionActivation(deps: ExtensionActivationDeps): vscode.Disposable {
  const { emit, getExtensions } = deps;
  const intervalMs = deps.intervalMs ?? 1000;

  // Seed the initial active set so we only emit transitions, not the initial state.
  const activeIds = new Set<string>(
    getExtensions()
      .filter((e) => e.isActive)
      .map((e) => e.id),
  );

  function poll(): void {
    for (const ext of getExtensions()) {
      if (ext.isActive && !activeIds.has(ext.id)) {
        // New activation since last poll.
        activeIds.add(ext.id);
        const pkg = ext.packageJSON as Record<string, unknown> | null | undefined;
        const version = typeof pkg?.['version'] === 'string' ? pkg['version'] : 'unknown';
        emit({ id: ext.id, version });
      }
    }
  }

  const handle = setInterval(poll, intervalMs);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref(): void }).unref();
  }

  return {
    dispose() {
      clearInterval(handle);
    },
  };
}
