/**
 * Gathers PRD §5.1 session.start payload fields.
 * Pure(ish) function — dependencies are injected for testability.
 * CLAUDE.md: "test the event-to-log-entry transformation as a pure function,
 * separately from the VS Code wiring."
 */

import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { Cs61aManifest, SessionStartPayload } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The full data needed to build a session.start payload.
 * All fields from PRD §5.1, with Phase 3 placeholder values where noted.
 */
export type RecorderContext = SessionStartPayload;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a machine_id as sha256Hex(hostname + ':' + username + ':' + sessionId).
 * Using the sessionId as a per-session salt prevents cross-assignment correlation
 * (per implementation-plan §0.4 decision: sha256(hostname + username + session_salt)).
 */
function computeMachineId(sessionId: string): string {
  const hostname = os.hostname();
  // os.userInfo() can throw on some platforms; fall back to process.env.USER.
  let username: string;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  }
  const input = `${hostname}:${username}:${sessionId}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a RecorderContext (= SessionStartPayload) from injected dependencies.
 *
 * @param manifest          The verified .cs61a manifest.
 * @param prevSessionId     The previous session's id if continuing after a crash, else null.
 * @param extension         The recorder's own VS Code Extension object (for version/id).
 * @param vscodeVersion     vscode.version string injected for testability.
 * @param platform          Platform string, e.g. "darwin-arm64". Callers should supply
 *                          `process.platform + '-' + process.arch`.
 * @param sessionPubkeyHex  Hex-encoded ed25519 public key for this session (Phase 9+).
 *                          Pass '' for pre-Phase-9 sessions or tests that don't need a real key.
 */
export function buildRecorderContext(args: {
  manifest: Cs61aManifest;
  prevSessionId: string | null;
  extension: vscode.Extension<unknown>;
  vscodeVersion: string;
  platform: string;
  sessionPubkeyHex?: string;
}): RecorderContext {
  const { manifest, prevSessionId, extension, vscodeVersion, platform, sessionPubkeyHex } = args;

  const sessionId = crypto.randomUUID();
  const machineId = computeMachineId(sessionId);

  // extension.packageJSON is typed as `any` in @types/vscode — this is the expected
  // FFI boundary for reading package metadata.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = extension.packageJSON as Record<string, any>;
  const recorderVersion: string =
    typeof pkg['version'] === 'string' ? (pkg['version'] as string) : '0.0.0';
  const recorderExtensionId: string =
    typeof pkg['publisher'] === 'string' && typeof pkg['name'] === 'string'
      ? `${pkg['publisher'] as string}.${pkg['name'] as string}`
      : extension.id;

  return {
    format_version: '1.0',
    session_id: sessionId,
    prev_session_id: prevSessionId,
    assignment: {
      id: manifest.assignment_id,
      semester: manifest.semester,
    },
    manifest_sig: manifest.sig,
    machine_id: machineId,
    vscode: {
      version: vscodeVersion,
      // vscode.version is the only publicly available version string in the extension API.
      // The commit hash is not exposed via the public API; we leave it as an empty string
      // in Phase 3. Phase 9 or a future phase can populate this via vscode.env if available.
      commit: '',
      platform,
    },
    recorder: {
      version: recorderVersion,
      extension_id: recorderExtensionId,
      // extension_hash: Phase 10 territory — computed over dist/ at bundle-seal time.
    },
    // Phase 9: populated from a real per-session ed25519 keypair via generateSessionKeypair().
    // Empty string only for pre-Phase-9 callers or tests that don't need a real key.
    session_pubkey: sessionPubkeyHex ?? '',
  };
}
