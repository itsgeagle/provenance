/**
 * Unit tests for buildRecorderContext.
 * Asserts all PRD §5.1 required fields are present and well-typed.
 * CLAUDE.md: "test the event-to-log-entry transformation as a pure function,
 * separately from the VS Code wiring."
 */

import { describe, it, expect } from 'vitest';
import { buildRecorderContext } from './recorder-context.js';
import type { Cs61aManifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_MANIFEST: Cs61aManifest = {
  assignment_id: 'hw03',
  semester: 'fa26',
  issued_at: '2026-09-15T00:00:00Z',
  files_under_review: ['hw03.py'],
  sig: 'a'.repeat(128),
};

/** Minimal vscode.Extension mock — only the packageJSON field matters here. */
function makeExtension(pkg: {
  version?: string;
  publisher?: string;
  name?: string;
}): import('vscode').Extension<unknown> {
  return {
    id: `${pkg.publisher ?? 'test'}.${pkg.name ?? 'recorder'}`,
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: pkg,
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRecorderContext', () => {
  it('produces a context with format_version "1.0"', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.format_version).toBe('1.0');
  });

  it('generates a non-empty session_id (UUID format)', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    // UUID format: 8-4-4-4-12 hex chars
    expect(ctx.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique session_ids on each call', () => {
    const ext = makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' });
    const ctx1 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    const ctx2 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx1.session_id).not.toBe(ctx2.session_id);
  });

  it('sets prev_session_id from the argument', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: 'abc-123',
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.prev_session_id).toBe('abc-123');
  });

  it('sets prev_session_id to null when not provided', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.prev_session_id).toBeNull();
  });

  it('copies assignment id and semester from the manifest', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.assignment.id).toBe('hw03');
    expect(ctx.assignment.semester).toBe('fa26');
  });

  it('copies manifest_sig from the manifest', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.manifest_sig).toBe(TEST_MANIFEST.sig);
  });

  it('produces a machine_id that is a 64-char hex string', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.machine_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('machine_ids differ across sessions (session_id used as salt)', () => {
    const ext = makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' });
    const ctx1 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    const ctx2 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    // Different sessions → different session_ids → different machine_ids.
    expect(ctx1.machine_id).not.toBe(ctx2.machine_id);
  });

  it('sets vscode.version from the injected vscodeVersion', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.vscode.version).toBe('1.97.0');
  });

  it('sets vscode.platform from the injected platform', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'win32-x64',
    });
    expect(ctx.vscode.platform).toBe('win32-x64');
  });

  it('sets recorder.version from extension.packageJSON.version', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '2.3.4', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.recorder.version).toBe('2.3.4');
  });

  it('sets recorder.extension_id as publisher.name', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({
        version: '1.0.0',
        publisher: 'berkeley-cs61a',
        name: 'provenance-recorder',
      }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.recorder.extension_id).toBe('berkeley-cs61a.provenance-recorder');
  });

  it('falls back to extension.id when publisher/name missing from packageJSON', () => {
    const ext = makeExtension({});
    // ext.id is 'test.recorder' from the makeExtension helper
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.recorder.extension_id).toBe('test.recorder');
  });

  it('sets session_pubkey to empty string (Phase 3 placeholder)', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    // Phase 9 will replace this with a real per-session ed25519 pubkey.
    expect(ctx.session_pubkey).toBe('');
  });

  it('vscode.commit is a string (may be empty in Phase 3)', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(typeof ctx.vscode.commit).toBe('string');
  });
});
