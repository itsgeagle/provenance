/**
 * VS Code extension entry point.
 * activate() is a thin wrapper that constructs production dependencies and
 * calls activateImpl(), which contains the real logic and is testable in isolation.
 *
 * PRD §4.1: Activate only when .cs61a is present and signature-valid.
 * PRD §5.1: Emit session.start with full context; emit session.end on deactivate.
 */

import * as vscode from 'vscode';
import * as fsPromises from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SystemClock, serializeEntry } from '@provenance/log-core';
import type { HashedEnvelope } from '@provenance/log-core';
import { loadAndVerifyManifest } from './activation/manifest-loader.js';
import { createRecordingStatusBar } from './activation/status-bar.js';
import { buildRecorderContext } from './session/recorder-context.js';
import { createSessionHost } from './session/session-host.js';
import type { Cs61aManifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Injected dependencies for activateImpl
// Allows tests to replace vscode, fs, and clock without the real VS Code runtime.
// ---------------------------------------------------------------------------

export type ActivateDeps = {
  /** First workspace folder. */
  workspaceFolder: vscode.WorkspaceFolder;
  /** The recorder's own Extension object (for package.json metadata). */
  extension: vscode.Extension<unknown>;
  /** vs Code version string (vscode.version in production). */
  vscodeVersion: string;
  /** Platform string (process.platform + '-' + process.arch in production). */
  platform: string;
  /** Override for manifest verification pubkey (tests inject a test keypair's pubkey). */
  pubkeyHex?: string;
  /** Override for the .provenance/ directory path (tests inject a tmp dir). */
  provenanceDirOverride?: string;
  /** Clock to inject (tests use FixedClock). */
  clock: import('@provenance/log-core').Clock;
  /** Disposable sink — items pushed here are cleaned up on deactivate. */
  disposables: vscode.Disposable[];
  /** Optional override for createStatusBar (tests can provide a no-op). */
  createStatusBar?: (disposables: vscode.Disposable[]) => vscode.StatusBarItem;
  /** Optional pre-loaded manifest (skips file I/O in tests that construct a manifest directly). */
  preloadedManifest?: Cs61aManifest;
};

// ---------------------------------------------------------------------------
// Shared write-stream state (scoped to the activation lifetime)
// ---------------------------------------------------------------------------

type ActiveSession = {
  slogPath: string;
  writeStream: fsSync.WriteStream;
  sessionHost: ReturnType<typeof createSessionHost>;
};

// ---------------------------------------------------------------------------
// activateImpl — testable core
// ---------------------------------------------------------------------------

/**
 * Core activation logic. Called by activate() with production deps,
 * and by integration tests with injected deps.
 *
 * Returns an ActiveSession if activation succeeded, or null if the workspace
 * is not a valid CS 61A assignment (callers should silently return).
 */
export async function activateImpl(deps: ActivateDeps): Promise<ActiveSession | null> {
  const { workspaceFolder, extension, vscodeVersion, platform, clock, disposables } = deps;

  // Step 1: Load and verify the .cs61a manifest.
  let manifest: Cs61aManifest;
  if (deps.preloadedManifest !== undefined) {
    manifest = deps.preloadedManifest;
  } else {
    const manifestResult = await loadAndVerifyManifest(workspaceFolder, deps.pubkeyHex);
    if (!manifestResult.ok) {
      // PRD §4.1: "If the signature doesn't verify, the extension does nothing."
      // Not an error from the user's perspective; silent exit.
      console.error(`[provenance] activation skipped: ${manifestResult.error.kind}`);
      return null;
    }
    manifest = manifestResult.value;
  }

  // Step 2: Mount the status bar.
  if (deps.createStatusBar !== undefined) {
    deps.createStatusBar(disposables);
  } else {
    createRecordingStatusBar(disposables);
  }

  // Step 3: Build recorder context (generates sessionId, machineId, etc.).
  const recorderContext = buildRecorderContext({
    manifest,
    prevSessionId: null, // Phase 9 will populate from previous session meta.
    extension,
    vscodeVersion,
    platform,
  });

  // Step 4: Set up the .provenance/ directory and .slog write stream.
  const provenanceDir =
    deps.provenanceDirOverride ?? path.join(workspaceFolder.uri.fsPath, '.provenance');

  await fsPromises.mkdir(provenanceDir, { recursive: true });

  const slogPath = path.join(provenanceDir, `session-${randomUUID()}.slog`);
  const writeStream = fsSync.createWriteStream(slogPath, { flags: 'a', encoding: 'utf8' });

  // Helper: synchronously append a serialized entry to the write stream.
  // Phase 4 will replace this with a buffered SessionWriter class.
  function appendEntry(entry: HashedEnvelope): void {
    writeStream.write(serializeEntry(entry));
  }

  // Step 5: Create the session host.
  const sessionHost = createSessionHost({
    sessionId: recorderContext.session_id,
    clock,
    onEntry: appendEntry,
  });

  // Step 6: Emit session.start.
  sessionHost.emit('session.start', recorderContext);

  // Step 7: Register deactivation hook.
  // Emits session.end and closes the write stream synchronously (best-effort).
  disposables.push({
    dispose(): void {
      sessionHost.emit('session.end', { reason: 'deactivate' });
      // writeStream.end() is async but we call it synchronously in dispose.
      // VS Code gives extensions a short window to clean up; a flush is best-effort.
      writeStream.end();
    },
  });

  return { slogPath, writeStream, sessionHost };
}

// ---------------------------------------------------------------------------
// VS Code extension hooks
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Find the first workspace folder.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }
  const workspaceFolder = workspaceFolders[0];
  if (workspaceFolder === undefined) {
    return;
  }

  // The recorder's own Extension object.
  const ownExtension = vscode.extensions.getExtension('berkeley-cs61a.provenance-recorder');
  if (ownExtension === undefined) {
    // Fallback: build a minimal extension-like object from context.
    // This happens in the Extension Host sandbox during development.
    console.error(
      '[provenance] WARNING: could not locate own extension via getExtension; using context fallback.',
    );
  }

  // Use a sentinel extension object if getExtension returned undefined.
  const extension: vscode.Extension<unknown> =
    ownExtension ??
    ({
      id: 'berkeley-cs61a.provenance-recorder',
      extensionUri: context.extensionUri,
      extensionPath: context.extensionPath,
      isActive: true,
      packageJSON: { version: '0.0.0', publisher: 'berkeley-cs61a', name: 'provenance-recorder' },
      exports: undefined,
      activate: () => Promise.resolve(undefined),
      extensionKind: vscode.ExtensionKind.Workspace,
    } as vscode.Extension<unknown>);

  try {
    await activateImpl({
      workspaceFolder,
      extension,
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      clock: new SystemClock(),
      disposables: context.subscriptions,
    });
  } catch (e) {
    console.error('[provenance] unexpected error during activation:', e);
  }
}

export function deactivate(): void {
  // Dispose hooks registered in context.subscriptions handle cleanup.
  // VS Code calls these automatically on deactivation.
}
