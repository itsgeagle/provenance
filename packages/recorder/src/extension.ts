/**
 * VS Code extension entry point.
 * activate() is a thin wrapper that constructs production dependencies and
 * calls activateImpl(), which contains the real logic and is testable in isolation.
 *
 * PRD §4.1: Activate only when .cs61a is present and signature-valid.
 * PRD §5.1: Emit session.start with full context; emit session.end on deactivate.
 * PRD §4.2: session.heartbeat every 30s; clock.skew on wall-clock drift.
 * PRD §4.7: Buffered, async I/O via SessionWriter (not a raw WriteStream).
 */

import * as vscode from 'vscode';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SystemClock } from '@provenance/log-core';
import type { HashedEnvelope } from '@provenance/log-core';
import { loadAndVerifyManifest } from './activation/manifest-loader.js';
import { createRecordingStatusBar } from './activation/status-bar.js';
import { buildRecorderContext } from './session/recorder-context.js';
import { createSessionHost } from './session/session-host.js';
import { SessionWriter } from './io/session-writer.js';
import { startHeartbeat } from './events/heartbeat.js';
import { startClockWatcher } from './events/clock-watcher.js';
import { startDocWiring } from './wiring/doc-wiring.js';
import { startPasteIntercept } from './wiring/paste-command-intercept.js';
import { startPasteReconciler } from './events/paste-reconciler.js';
import { startFsWatcher } from './wiring/fs-watcher.js';
import { ExplanationTagger } from './events/explanation-tags.js';
import { ExpectedContentRegistry } from './state/expected-content-registry.js';
import type { LargeInsertCounter } from './wiring/doc-wiring.js';
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
  /** VS Code version string (vscode.version in production). */
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
  /**
   * Heartbeat + clock-watcher VS Code subscriptions.
   * Tests inject no-op stubs; production wires to vscode.window / workspace.
   */
  heartbeatDeps?: HeartbeatVscodeDeps;
};

/**
 * VS Code-specific subscriptions needed by the heartbeat.
 * Extracted so tests can stub them without touching the real vscode API.
 */
export type HeartbeatVscodeDeps = {
  windowState: { focused: boolean };
  activeTextEditor: () => string | null;
  onDidChangeFocus: (handler: () => void) => vscode.Disposable;
  onDidChangeActiveTextEditor: (handler: () => void) => vscode.Disposable;
  onDidChangeTextDocument: (handler: () => void) => vscode.Disposable;
};

// ---------------------------------------------------------------------------
// Shared session state (scoped to the activation lifetime)
// ---------------------------------------------------------------------------

type ActiveSession = {
  slogPath: string;
  writer: SessionWriter;
  sessionHost: ReturnType<typeof createSessionHost>;
};

let activeSession: ActiveSession | null = null;

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

  // Initialize activeSession to null before we begin (in case we early-return or error).
  activeSession = null;

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

  // Step 4: Set up the .provenance/ directory and open a SessionWriter.
  const provenanceDir =
    deps.provenanceDirOverride ?? path.join(workspaceFolder.uri.fsPath, '.provenance');

  await fsPromises.mkdir(provenanceDir, { recursive: true });

  const slogPath = path.join(provenanceDir, `session-${randomUUID()}.slog`);
  const writer = await SessionWriter.open({
    slogPath,
    clock,
    onError: (e) => console.error('[provenance] writer error:', e),
  });

  // Step 5: Create the session host.
  const sessionHost = createSessionHost({
    sessionId: recorderContext.session_id,
    clock,
    onEntry: (entry: HashedEnvelope) => writer.append(entry),
  });

  // Step 6: Emit session.start.
  sessionHost.emit('session.start', recorderContext);

  // Step 7: Start heartbeat (PRD §4.2: session.heartbeat every 30s).
  const hbDeps = deps.heartbeatDeps ?? defaultHeartbeatDeps();
  const heartbeat = startHeartbeat({
    ...hbDeps,
    getNow: () => clock.now(),
    emit: (data) => sessionHost.emit('session.heartbeat', data),
  });
  disposables.push(heartbeat);

  // Step 8: Start clock-skew watcher (PRD §4.2: clock.skew on wall drift).
  const clockWatcher = startClockWatcher({
    getMonotonicMs: () => clock.now(),
    getWallMs: () => Date.now(),
    emit: (data) => sessionHost.emit('clock.skew', data),
  });
  disposables.push(clockWatcher);

  // Step 9: Start paste intercept command (PRD §4.3 signal 2).
  const pasteIntercept = startPasteIntercept({
    registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler),
    executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    getNow: () => clock.now(),
  });
  disposables.push(pasteIntercept.disposable);

  // Step 10: Large-insert counter shared between doc-wiring and the reconciler.
  let _largeInsertCount = 0;
  const largeInsertCounter: LargeInsertCounter = {
    increment() {
      _largeInsertCount++;
    },
    count() {
      return _largeInsertCount;
    },
  };

  // Step 11: Start doc-event wiring (PRD §4.2 + §4.3 paste detection + Phase 7).
  const expectedContentRegistry = new ExpectedContentRegistry(manifest.files_under_review);

  // Phase 7: ExplanationTagger for formatter/git explanation of external changes.
  // Phase 8 will hook markFormatter()/markGit() calls into terminal/git events.
  const explanationTagger = new ExplanationTagger({ getNow: () => clock.now() });

  // Production readFile: resolve relative path against workspace root + read UTF-8.
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const prodReadFile = (relativePath: string): Promise<string> =>
    fsPromises.readFile(path.join(workspaceRoot, relativePath), 'utf8');

  const docWiring = startDocWiring({
    workspace: { asRelativePath: vscode.workspace.asRelativePath.bind(vscode.workspace) },
    emitDocOpen: (data) => sessionHost.emit('doc.open', data),
    emitDocChange: (data) => sessionHost.emit('doc.change', data),
    emitDocSave: (data) => sessionHost.emit('doc.save', data),
    emitDocClose: (data) => sessionHost.emit('doc.close', data),
    emitPaste: (data) => sessionHost.emit('paste', data),
    emitSelectionChange: (data) => sessionHost.emit('selection.change', data),
    emitFocusChange: (data) => sessionHost.emit('focus.change', data),
    emitFsExternalChange: (data) => sessionHost.emit('fs.external_change', data),
    filesUnderReview: manifest.files_under_review,
    expectedContent: expectedContentRegistry,
    pasteIntercept,
    largeInsertCounter,
    getNow: () => clock.now(),
    readFile: prodReadFile,
    explanationTagger,
  });
  disposables.push(docWiring);

  // Step 11b: Start FileSystemWatcher for external changes (PRD §4.5 — "file edited
  // while VS Code unfocused" path). Must come after docWiring so getLastDocChangeAt works.
  const fsWatcher = startFsWatcher({
    workspaceFolder,
    filesUnderReview: manifest.files_under_review,
    registry: expectedContentRegistry,
    emit: (data) => sessionHost.emit('fs.external_change', data),
    getLastDocChangeAt: (p) => docWiring.getLastDocChangeAt(p),
    getNow: () => clock.now(),
    readFile: prodReadFile,
    explanationTagger,
  });
  disposables.push(fsWatcher);

  // Step 12: Start paste reconciler (PRD §4.3 signal 3).
  const reconciler = startPasteReconciler({
    emit: (data) => sessionHost.emit('paste.anomaly', data),
    getInterceptedCount: () => pasteIntercept.interceptCount,
    getLargeInsertCount: () => largeInsertCounter.count(),
  });
  disposables.push(reconciler);

  // VS Code disposes context.subscriptions in LIFO order. We pushed the status bar disposable
  // (Step 2), then heartbeat (Step 7), then clock watcher (Step 8), then doc wiring (Step 9).
  // On teardown: doc wiring disposes first, then clock watcher, heartbeat, status bar.
  // After all subscriptions are disposed, deactivate() runs and is awaited,
  // ensuring session.end is emitted and the writer flushes.

  // Store the active session so deactivate() can access it.
  activeSession = { slogPath, writer, sessionHost };
  return activeSession;
}

// ---------------------------------------------------------------------------
// Production heartbeat deps
// ---------------------------------------------------------------------------

function defaultHeartbeatDeps(): HeartbeatVscodeDeps {
  return {
    windowState: vscode.window.state,
    activeTextEditor: () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? vscode.workspace.asRelativePath(editor.document.uri) : null;
    },
    onDidChangeFocus: (h) => vscode.window.onDidChangeWindowState(h),
    onDidChangeActiveTextEditor: (h) => vscode.window.onDidChangeActiveTextEditor(h),
    onDidChangeTextDocument: (h) => vscode.workspace.onDidChangeTextDocument(h),
  };
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
    const session = await activateImpl({
      workspaceFolder,
      extension,
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      clock: new SystemClock(),
      disposables: context.subscriptions,
    });
    // activateImpl sets activeSession internally, so we don't need to do it here.
    // But we verify it was set correctly (for code clarity).
    if (session !== null && activeSession === null) {
      console.error(
        '[provenance] WARNING: activateImpl returned a session but activeSession is null',
      );
    }
  } catch (e) {
    console.error('[provenance] unexpected error during activation:', e);
  }
}

export async function deactivate(): Promise<void> {
  // VS Code awaits a Thenable<void> returned from deactivate().
  // This guarantees the writer's pending entries are flushed before shutdown.
  if (activeSession === null) {
    return;
  }

  const session = activeSession;
  activeSession = null;

  // Emit session.end event.
  try {
    session.sessionHost.emit('session.end', { reason: 'deactivate' });
  } catch {
    // Ignore — best effort.
  }

  // Flush pending entries and close the file handle. Await this to ensure
  // the writer is fully disposed before VS Code shuts down.
  try {
    await session.writer.dispose();
  } catch {
    // Ignore — best effort.
  }
}
