/**
 * extension-snapshot.ts — periodic ext.snapshot emitter.
 *
 * PRD §4.2: "At session start and every 5 min — list of {id, version, enabled}
 * for all installed extensions."
 *
 * "enabled" is approximated by vscode.Extension.isActive — the closest public
 * API signal. An extension is listed in vscode.extensions.all regardless of
 * whether it is active; isActive reflects whether its activate() has run.
 */

import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtensionSnapshotDeps = {
  /** Override the periodic interval in ms. Default: 5 * 60 * 1000 (5 min). */
  intervalMs?: number;
  emit: (data: { extensions: Array<{ id: string; version: string; enabled: boolean }> }) => void;
  /** Returns the current extension list (injected so tests can control it). */
  getExtensions: () => readonly vscode.Extension<unknown>[];
  /** If true (default), call snapshot() immediately at startup. */
  emitImmediately?: boolean;
};

// ---------------------------------------------------------------------------
// startExtensionSnapshot
// ---------------------------------------------------------------------------

export function startExtensionSnapshot(deps: ExtensionSnapshotDeps): vscode.Disposable {
  const { emit, getExtensions } = deps;
  const intervalMs = deps.intervalMs ?? 5 * 60 * 1000;
  const emitImmediately = deps.emitImmediately ?? true;

  function snapshot(): void {
    const extensions = getExtensions().map((e) => {
      // packageJSON is typed as unknown; version lives at packageJSON.version.
      const pkg = e.packageJSON as Record<string, unknown> | null | undefined;
      const version = typeof pkg?.['version'] === 'string' ? pkg['version'] : 'unknown';
      return { id: e.id, version, enabled: e.isActive };
    });
    emit({ extensions });
  }

  if (emitImmediately) {
    snapshot();
  }

  const handle = setInterval(snapshot, intervalMs);
  // Allow Node.js to exit without waiting for this timer.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref(): void }).unref();
  }

  return {
    dispose() {
      clearInterval(handle);
    },
  };
}
