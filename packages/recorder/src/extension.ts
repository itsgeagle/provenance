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
import * as path from 'node:path';
import { SystemClock } from '@provenance/log-core';
import { loadAndVerifyManifest } from './activation/manifest-loader.js';
import type { ActivationError } from './activation/manifest-loader.js';
import { createRecordingStatusBar } from './activation/status-bar.js';
import { sealBundle } from './commands/seal.js';
import { computeExtensionHash } from './commands/extension-hash.js';
import { startSession } from './session/session-registry.js';
import type { ActiveSession, HeartbeatVscodeDeps } from './session/session-registry.js';
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

// ---------------------------------------------------------------------------
// Shared session state (scoped to the activation lifetime)
// ---------------------------------------------------------------------------

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

  // Step 2: Mount the status bar. extension.ts owns the single global status bar;
  // startSession() does not mount its own (its createStatusBar dep is left unset).
  if (deps.createStatusBar !== undefined) {
    deps.createStatusBar(disposables);
  } else {
    createRecordingStatusBar(disposables);
  }

  // Step 3: Delegate the per-assignment-root session lifecycle to startSession().
  // For the single-root case, the assignment root IS the opened workspace folder,
  // so this preserves today's behavior exactly.
  const session = await startSession({
    assignmentRoot: workspaceFolder.uri.fsPath,
    manifest,
    extension,
    vscodeVersion,
    platform,
    clock,
    ...(deps.provenanceDirOverride !== undefined
      ? { provenanceDirOverride: deps.provenanceDirOverride }
      : {}),
    ...(deps.heartbeatDeps !== undefined ? { heartbeatDeps: deps.heartbeatDeps } : {}),
    ...(deps.extensionDistPath !== undefined ? { extensionDistPath: deps.extensionDistPath } : {}),
  });

  // Hand this session's subscriptions to VS Code's context.subscriptions so they are
  // disposed in LIFO order BEFORE deactivate() runs — matching the historical teardown
  // ordering. Emptying ownDisposables afterward prevents session.dispose() from
  // double-disposing them.
  disposables.push(...session.ownDisposables);
  session.ownDisposables.length = 0;

  // Step 4: Register the "Prepare Submission Bundle" command (PRD §4.6 + §5.3).
  // The extensionDistPath for extension-hash is derived from context.extensionPath in
  // production; tests inject an override via deps.extensionDistPath.
  const extensionDistPath = deps.extensionDistPath ?? path.join(extension.extensionPath, 'dist');

  const sealCmd = vscode.commands.registerCommand(
    'provenance.prepareSubmissionBundle',
    async () => {
      // Flush the writer so any pending events land in the .slog before we read it.
      await activeSession?.writer.flush();

      const result = await sealBundle({
        workspaceFolder,
        provenanceDir: session.provenanceDir,
        assignmentId: session.manifest.assignment_id,
        semester: session.manifest.semester,
        filesUnderReview: session.manifest.files_under_review,
        sessionPrivkey: session.sessionKeypair.privateKey,
        sessionPubkeyHex: session.sessionKeypair.publicKeyHex,
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

  activeSession = session;
  return session;
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
  // session.dispose() emits session.end, flushes the writer, drains the pending
  // checkpoint, and disposes the metaWriter (its ownDisposables were already handed
  // to context.subscriptions in activateImpl and disposed by VS Code before now).
  if (activeSession === null) {
    return;
  }
  const session = activeSession;
  activeSession = null;
  await session.dispose();
}
