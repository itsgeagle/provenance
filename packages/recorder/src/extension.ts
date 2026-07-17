/**
 * VS Code extension entry point.
 * activate() is a thin wrapper that constructs production dependencies and
 * calls activateImpl(), which contains the real logic and is testable in isolation.
 *
 * PRD §4.1: Activate only when a `.provenance-manifest` (or `provenance-manifest`) is present and signature-valid.
 * PRD §5.1: Emit session.start with full context; emit session.end on deactivate.
 * PRD §4.2: session.heartbeat every 30s; clock.skew on wall-clock drift.
 * PRD §4.7: Buffered, async I/O via SessionWriter (not a raw WriteStream).
 */

import * as vscode from 'vscode';
import * as fsPromises from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SystemClock,
  generateSessionKeypair,
  encryptSessionPrivkey,
  signCheckpoint,
} from '@provenance/log-core';
import type { HashedEnvelope } from '@provenance/log-core';
import { loadAndVerifyManifest } from './activation/manifest-loader.js';
import type { ActivationError } from './activation/manifest-loader.js';
import { createRecordingStatusBar } from './activation/status-bar.js';
import { buildRecorderContext } from './session/recorder-context.js';
import { createSessionHost } from './session/session-host.js';
import { SessionWriter } from './io/session-writer.js';
import { MetaWriter } from './io/meta-writer.js';
import { startHeartbeat } from './events/heartbeat.js';
import { startClockWatcher } from './events/clock-watcher.js';
import { startDocWiring } from './wiring/doc-wiring.js';
import { startPasteIntercept } from './wiring/paste-command-intercept.js';
import { startPasteReconciler } from './events/paste-reconciler.js';
import { startFsWatcher } from './wiring/fs-watcher.js';
import { ExplanationTagger } from './events/explanation-tags.js';
import { ExpectedContentRegistry } from './state/expected-content-registry.js';
import { startTerminalWiring } from './wiring/terminal-wiring.js';
import { startExtensionSnapshot } from './wiring/extension-snapshot.js';
import { startExtensionActivation } from './wiring/extension-activation.js';
import { startGitWiring } from './wiring/git-wiring.js';
import { recoverPreviousSession } from './startup/chain-recovery.js';
import { sealBundle } from './commands/seal.js';
import { computeExtensionHash } from './commands/extension-hash.js';
import { DiskFullHandler } from './failure/disk-full-handler.js';
import type { LargeInsertCounter } from './wiring/doc-wiring.js';
import type { Manifest } from '@provenance/log-core';

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
  preloadedManifest?: Manifest;
  /**
   * Heartbeat + clock-watcher VS Code subscriptions.
   * Tests inject no-op stubs; production wires to vscode.window / workspace.
   */
  heartbeatDeps?: HeartbeatVscodeDeps;
  /**
   * Path to the recorder's dist/ directory for extension-hash computation.
   * Tests can inject a tmp dir; production uses context.extensionPath + '/dist'.
   */
  extensionDistPath?: string;
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
  metaWriter: MetaWriter;
  sessionHost: ReturnType<typeof createSessionHost>;
  /** Most recent checkpoint write chain. deactivate() awaits this so the final checkpoint isn't lost. */
  getPendingCheckpoint: () => Promise<void>;
};

let activeSession: ActiveSession | null = null;

// ---------------------------------------------------------------------------
// Inactive-workspace fallback
// ---------------------------------------------------------------------------

/**
 * Human-readable guidance shown when a student runs "Prepare Submission Bundle"
 * in a folder where the recorder did not activate. Turns VS Code's opaque
 * "command not found" into an actionable message, tailored to why activation was
 * skipped. Pure so the wording is unit-testable without the VS Code runtime.
 *
 * PRD §4.1 still holds: the recorder does nothing on activation for these cases.
 * This text is only surfaced in reaction to an explicit command invocation.
 */
export function fallbackActivationMessage(error: ActivationError): string {
  switch (error.kind) {
    case 'no_manifest_file':
    case 'no_workspace':
      return (
        'No Provenance assignment was detected in this folder, so recording was ' +
        'not active and no session was captured. Open the assignment folder that ' +
        'contains a ".provenance-manifest" file (the one distributed by your course) ' +
        'and try again.'
      );
    case 'manifest_signature_invalid':
    case 'manifest_parse_error':
      return (
        'This folder\'s ".provenance-manifest" could not be verified, so Provenance ' +
        'recording did not start and no session was captured. Re-download the ' +
        'assignment from your course; if the problem persists, contact course staff.'
      );
    case 'manifest_read_error':
      return (
        'Provenance could not read the ".provenance-manifest" in this folder, so ' +
        `recording did not start and no session was captured (${error.message}). ` +
        'Re-download the assignment; if the problem persists, contact course staff.'
      );
  }
}

/**
 * Register a no-op stub for `provenance.prepareSubmissionBundle` in a workspace
 * where the recorder is inactive, so the palette command explains itself instead
 * of throwing "command not found". The stub only shows a message when invoked; it
 * creates no files and records nothing. The disposable is tracked for teardown.
 */
function registerInactiveStub(disposables: vscode.Disposable[], error: ActivationError): void {
  const message = fallbackActivationMessage(error);
  const stub = vscode.commands.registerCommand('provenance.prepareSubmissionBundle', () => {
    void vscode.window.showWarningMessage(message);
  });
  disposables.push(stub);
}

// ---------------------------------------------------------------------------
// activateImpl — testable core
// ---------------------------------------------------------------------------

/**
 * Core activation logic. Called by activate() with production deps,
 * and by integration tests with injected deps.
 *
 * Returns an ActiveSession if activation succeeded, or null if the workspace
 * is not a valid assignment workspace (callers should silently return).
 */
export async function activateImpl(deps: ActivateDeps): Promise<ActiveSession | null> {
  const { workspaceFolder, extension, vscodeVersion, platform, clock, disposables } = deps;

  // Initialize activeSession to null before we begin (in case we early-return or error).
  activeSession = null;

  // Step 1: Load and verify the `.provenance-manifest`/`provenance-manifest` file.
  let manifest: Manifest;
  if (deps.preloadedManifest !== undefined) {
    manifest = deps.preloadedManifest;
  } else {
    const manifestResult = await loadAndVerifyManifest(workspaceFolder, deps.pubkeyHex);
    if (!manifestResult.ok) {
      // PRD §4.1: "If the signature doesn't verify, the extension does nothing."
      // Not an error from the user's perspective; silent exit — no session, no files.
      console.error(`[provenance] activation skipped: ${manifestResult.error.kind}`);
      // ...but VS Code statically contributes the "Prepare Submission Bundle" palette
      // entry. Without a registered handler it fails with an opaque "command not found"
      // when a student runs it here (e.g. they opened just the assignment file, not the
      // folder holding `.provenance-manifest`). Register a lightweight stub that only
      // reacts to that explicit invocation and explains what to do. It records nothing
      // and creates no files, so the "does nothing" guarantee above still holds.
      registerInactiveStub(disposables, manifestResult.error);
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

  // Step 3a: Determine .provenance/ dir early (needed by chain recovery + session writer).
  const provenanceDir =
    deps.provenanceDirOverride ?? path.join(workspaceFolder.uri.fsPath, '.provenance');
  await fsPromises.mkdir(provenanceDir, { recursive: true });

  // Step 3b: Chain recovery — inspect the provenanceDir for a previous session.
  // PRD §4.8: on extension crash → set prev_session_id. On corrupt log → quarantine.
  const recovery = await recoverPreviousSession({
    provenanceDir,
    readSlogFile: async (p) => {
      try {
        const text = await fsPromises.readFile(p, 'utf8');
        return { ok: true, text };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === 'ENOENT' ? 'not_found' : 'read_error' };
      }
    },
    rename: fsPromises.rename,
    listSlogFiles: async (dir) => {
      try {
        const entries = await fsPromises.readdir(dir);
        return entries.filter((f) => f.endsWith('.slog'));
      } catch {
        return [];
      }
    },
    now: () => new Date(),
  });

  // Determine prev_session_id from recovery result.
  // Only set for dangling sessions (crashes) — not for cleanly ended sessions.
  const prevSessionId: string | null =
    recovery.kind === 'previous_session_dangling' ? recovery.prevSessionId : null;

  // Step 3c: Generate the session keypair (Phase 9).
  const keypair = await generateSessionKeypair();

  // Step 3d: Build recorder context (generates sessionId, machineId, etc.).
  const recorderContext = buildRecorderContext({
    manifest,
    prevSessionId,
    extension,
    vscodeVersion,
    platform,
    sessionPubkeyHex: keypair.publicKeyHex,
  });

  // Step 4: Open a SessionWriter (.provenance/ dir already created in Step 3a).
  const slogPath = path.join(provenanceDir, `session-${randomUUID()}.slog`);

  // Phase 11: DiskFullHandler — intercepts write errors, switches to ring buffer on ENOSPC.
  // Constructed before the writer so we can pass handleWriteError as the onError hook.
  // onDegraded emits recorder.degraded through the sessionHost; that event re-enters
  // enqueue() which accepts it (CRITICAL_KINDS) — no infinite loop.
  // handleWriteError is idempotent, so the second call from that re-entry is a no-op.
  //
  // sessionHostEmit is a forward reference populated in Step 5 after sessionHost is created.
  // It is guaranteed to be set before any write error can occur (the writer isn't used
  // until session.start is emitted in Step 6).
  let sessionHostEmit: ((kind: 'recorder.degraded', data: { reason: string }) => void) | null =
    null;

  const diskFullHandler = new DiskFullHandler({
    onDegraded: (data) => {
      // Emit through sessionHost — this will call the onEntry callback below, which
      // will route back through diskFullHandler.enqueue(). The entry is critical and
      // gets stored in the ring. The writer.append() call is skipped because degraded=true.
      sessionHostEmit?.('recorder.degraded', { reason: data.reason });
    },
    notify: (msg) => {
      void vscode.window.showErrorMessage(msg);
    },
  });

  const writer = await SessionWriter.open({
    slogPath,
    clock,
    onError: (e) => diskFullHandler.handleWriteError(e),
  });

  // Step 4b: Encrypt the private key and create the MetaWriter.
  // Encrypt under the manifest sig so it can't be recovered without the course manifest.
  const encryptedPrivkey = await encryptSessionPrivkey(
    keypair.privateKey,
    manifest.sig,
    recorderContext.session_id,
  );
  const metaPath = `${slogPath}.meta`;
  const metaWriter = await MetaWriter.create({
    metaPath,
    sessionId: recorderContext.session_id,
    sessionPubkeyHex: keypair.publicKeyHex,
    encryptedPrivkey,
  });

  // Step 5: Create the session host.
  // Hook checkpoints: every CHECKPOINT_INTERVAL entries, sign + write.
  // Fire-and-forget on the append path; tracked via pendingCheckpoint so deactivate()
  // can drain the last in-flight sign before closing the meta file.
  const CHECKPOINT_INTERVAL = 100;
  let entryCountSinceLastCheckpoint = 0;
  let pendingCheckpoint: Promise<void> = Promise.resolve();

  const sessionHost = createSessionHost({
    sessionId: recorderContext.session_id,
    clock,
    onEntry: (entry: HashedEnvelope) => {
      // Phase 11: route through disk-full handler.
      // If degraded: critical entries go to the ring; non-critical are dropped.
      // If not degraded: write to disk as normal.
      if (diskFullHandler.degraded) {
        diskFullHandler.enqueue(entry);
        return;
      }

      writer.append(entry);
      entryCountSinceLastCheckpoint++;
      if (entryCountSinceLastCheckpoint >= CHECKPOINT_INTERVAL) {
        entryCountSinceLastCheckpoint = 0;
        // Chain onto pendingCheckpoint so deactivate() awaits the most recent one,
        // and so concurrent checkpoint writes are serialized.
        pendingCheckpoint = pendingCheckpoint
          .then(() => signCheckpoint(entry.seq, entry.hash, keypair.privateKey))
          .then((cp) => metaWriter.appendCheckpoint(cp))
          .catch((e: unknown) => {
            console.error('[provenance] checkpoint sign/write error:', e);
          });
      }
    },
  });

  // Populate the forward reference for onDegraded so it can emit through sessionHost.
  sessionHostEmit = (kind, data) => sessionHost.emit(kind, data);

  // Step 6: Emit session.start.
  sessionHost.emit('session.start', recorderContext);

  // Step 6b: If we recovered from corruption, emit the recovery event now (after session.start).
  if (recovery.kind === 'previous_session_corrupt') {
    sessionHost.emit('recorder.recovered_from_corruption', {
      quarantined_path: recovery.quarantinedPath,
    });
  }

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
  // Sync read for the reload-from-disk discriminator (doc-wiring.ts). Only invoked on the
  // first content change after a buffer goes clean, never on the keystroke firehose.
  const prodReadFileSync = (relativePath: string): string =>
    readFileSync(path.join(workspaceRoot, relativePath), 'utf8');

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
    provenanceDir,
    expectedContent: expectedContentRegistry,
    pasteIntercept,
    largeInsertCounter,
    getNow: () => clock.now(),
    readFile: prodReadFile,
    readFileSync: prodReadFileSync,
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

  // Step 13: Terminal wiring (PRD §4.2 + §4.4).
  // The onDidStartTerminalShellExecution / onDidEndTerminalShellExecution APIs are
  // VS Code 1.93+ additions. We cast window to check for their presence at runtime,
  // and only pass them if they exist. exactOptionalPropertyTypes requires we not pass
  // `undefined` for optional properties — so we build the object conditionally.
  type VscodeWindowExt = typeof vscode.window & {
    onDidStartTerminalShellExecution?: (
      h: (e: import('vscode').TerminalShellExecutionStartEvent) => void,
    ) => import('vscode').Disposable;
    onDidEndTerminalShellExecution?: (
      h: (e: import('vscode').TerminalShellExecutionEndEvent) => void,
    ) => import('vscode').Disposable;
  };
  const windowExt = vscode.window as VscodeWindowExt;
  const terminalWiringDeps = {
    emitTerminalOpen: (d: { terminal_id: string; shell: string; shell_integration: boolean }) =>
      sessionHost.emit('terminal.open', d),
    emitTerminalCommand: (d: { terminal_id: string; command: string; exit_code?: number }) =>
      sessionHost.emit('terminal.command', d),
    onDidOpenTerminal: (h: (t: import('vscode').Terminal) => void) =>
      vscode.window.onDidOpenTerminal(h),
    onDidCloseTerminal: (h: (t: import('vscode').Terminal) => void) =>
      vscode.window.onDidCloseTerminal(h),
    ...(windowExt.onDidStartTerminalShellExecution !== undefined
      ? {
          onDidStartTerminalShellExecution: (
            h: (e: import('vscode').TerminalShellExecutionStartEvent) => void,
          ) => windowExt.onDidStartTerminalShellExecution!(h),
        }
      : {}),
    ...(windowExt.onDidEndTerminalShellExecution !== undefined
      ? {
          onDidEndTerminalShellExecution: (
            h: (e: import('vscode').TerminalShellExecutionEndEvent) => void,
          ) => windowExt.onDidEndTerminalShellExecution!(h),
        }
      : {}),
  };
  const terminalWiring = startTerminalWiring(terminalWiringDeps);
  disposables.push(terminalWiring);

  // Step 14: Extension snapshot (PRD §4.2 — ext.snapshot every 5 min + at start).
  const snap = startExtensionSnapshot({
    emit: (d) => sessionHost.emit('ext.snapshot', d),
    getExtensions: () => vscode.extensions.all,
  });
  disposables.push(snap);

  // Step 15: Extension activation poller (PRD §4.2 — ext.activate).
  const extAct = startExtensionActivation({
    emit: (d) => sessionHost.emit('ext.activate', d),
    getExtensions: () => vscode.extensions.all,
  });
  disposables.push(extAct);

  // Step 16: Git wiring (PRD §4.2 — git.event; also feeds explanationTagger for §4.5).
  const gitW = startGitWiring({
    emit: (d) => sessionHost.emit('git.event', d),
    getGitExtension: () => vscode.extensions.getExtension('vscode.git'),
    explanationTagger,
  });
  disposables.push(gitW);

  // Step 17: Register the "Prepare Submission Bundle" command (PRD §4.6 + §5.3).
  // The extensionDistPath for extension-hash is derived from context.extensionPath in production;
  // tests inject an override via deps.extensionDistPath.
  const extensionDistPath = deps.extensionDistPath ?? path.join(extension.extensionPath, 'dist');

  const sealCmd = vscode.commands.registerCommand(
    'provenance.prepareSubmissionBundle',
    async () => {
      // Flush the writer so any pending events land in the .slog before we read it.
      await activeSession?.writer.flush();

      const result = await sealBundle({
        workspaceFolder,
        provenanceDir,
        assignmentId: manifest.assignment_id,
        semester: manifest.semester,
        filesUnderReview: manifest.files_under_review,
        sessionPrivkey: keypair.privateKey,
        sessionPubkeyHex: keypair.publicKeyHex,
        computeExtensionHash: () => computeExtensionHash(extensionDistPath),
        now: () => new Date(),
      });

      if (result.kind === 'ok') {
        void vscode.window.showInformationMessage(
          `Provenance bundle saved to ${result.bundlePath}`,
        );
        if (result.warnings.chainBroken || result.warnings.unreadableSession) {
          void vscode.window.showWarningMessage(
            'Provenance bundle produced. Integrity issues were detected in the recording and will be reviewed by course staff.',
          );
        }
      } else if (result.kind === 'no_sessions') {
        void vscode.window.showWarningMessage('No session data to seal.');
      } else if (result.kind === 'write_error') {
        void vscode.window.showErrorMessage(`Bundle write error: ${result.message}`);
      }
    },
  );
  disposables.push(sealCmd);

  // VS Code disposes context.subscriptions in LIFO order. We pushed the status bar disposable
  // (Step 2), then heartbeat (Step 7), then clock watcher (Step 8), then doc wiring (Step 9).
  // On teardown: doc wiring disposes first, then clock watcher, heartbeat, status bar.
  // After all subscriptions are disposed, deactivate() runs and is awaited,
  // ensuring session.end is emitted and the writer flushes.

  // Store the active session so deactivate() can access it.
  activeSession = {
    slogPath,
    writer,
    metaWriter,
    sessionHost,
    getPendingCheckpoint: () => pendingCheckpoint,
  };
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
  const ownExtension = vscode.extensions.getExtension('itsgeagle.provenance-recorder');
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
      id: 'itsgeagle.provenance-recorder',
      extensionUri: context.extensionUri,
      extensionPath: context.extensionPath,
      isActive: true,
      packageJSON: { version: '0.0.0', publisher: 'itsgeagle', name: 'provenance-recorder' },
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
      // Derive extensionDistPath from the resolved extensionPath (context.extensionPath
      // is the same as extension.extensionPath, but is always available from context).
      extensionDistPath: path.join(context.extensionPath, 'dist'),
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

  // Drain any in-flight checkpoint sign+write before closing the meta file.
  // Without this, a checkpoint that was kicked off in the last 100 entries can
  // race and never land in the .meta file.
  try {
    await session.getPendingCheckpoint();
  } catch {
    // Ignore — best effort.
  }

  // Dispose the meta writer (no-op today; here for symmetry and future proofing).
  try {
    await session.metaWriter.dispose();
  } catch {
    // Ignore — best effort.
  }
}
