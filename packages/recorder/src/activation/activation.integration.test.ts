/**
 * Unit-level integration test for the activation path.
 * Does NOT use @vscode/test-electron. Uses activateImpl() with injected dependencies
 * so the real VS Code runtime is not required.
 *
 * Verifies the happy path: signed .cs61a → status bar mount → session.start written
 * to a .slog file that round-trips through parseEntries + validateChain.
 *
 * CLAUDE.md: "test the event-to-log-entry transformation as a pure function,
 * separately from the VS Code wiring."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FixedClock, parseEntries, validateChain, canonicalize } from '@provenance/log-core';
import type { Cs61aManifest } from '@provenance/log-core';
import { activateImpl } from '../extension.js';

// ---------------------------------------------------------------------------
// Helpers: test keypair + manifest
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

async function generateTestKeypair(): Promise<{ pubkeyHex: string; privkeyHex: string }> {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return { pubkeyHex: bytesToHex(publicKey), privkeyHex: bytesToHex(secretKey) };
}

async function signManifest(
  fields: {
    assignment_id: string;
    semester: string;
    issued_at: string;
    files_under_review: string[];
  },
  privkeyHex: string,
): Promise<string> {
  const payload = canonicalize({
    assignment_id: fields.assignment_id,
    semester: fields.semester,
    issued_at: fields.issued_at,
    files_under_review: fields.files_under_review,
  });
  const bytes = new TextEncoder().encode(payload);
  const sig = await ed.signAsync(bytes, hexToBytes(privkeyHex));
  return bytesToHex(sig);
}

// ---------------------------------------------------------------------------
// vscode mock helpers
// ---------------------------------------------------------------------------

function makeWorkspaceFolder(fsPath: string): import('vscode').WorkspaceFolder {
  return {
    uri: { fsPath } as import('vscode').Uri,
    name: 'test',
    index: 0,
  };
}

function makeExtension(): import('vscode').Extension<unknown> {
  return {
    id: 'berkeley-cs61a.provenance-recorder',
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: {
      version: '0.0.0',
      publisher: 'berkeley-cs61a',
      name: 'provenance-recorder',
    },
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

/** Minimal vscode.StatusBarItem stub (no-op). */
function makeStatusBarItem(): import('vscode').StatusBarItem {
  return {
    id: 'test',
    alignment: 1 as import('vscode').StatusBarAlignment,
    priority: 0,
    name: 'test',
    text: '',
    tooltip: '',
    color: undefined,
    backgroundColor: undefined,
    command: undefined,
    accessibilityInformation: undefined,
    show(): void {
      /* no-op */
    },
    hide(): void {
      /* no-op */
    },
    dispose(): void {
      /* no-op */
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('activateImpl — integration', () => {
  let tmpDir: string;
  let provenanceDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-int-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when manifest file is missing', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    // Don't write any .cs61a file — simulates missing manifest.

    const disposables: import('vscode').Disposable[] = [];
    const result = await activateImpl({
      workspaceFolder: makeWorkspaceFolder(workspaceDir),
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      pubkeyHex,
      provenanceDirOverride: provenanceDir,
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      disposables,
      createStatusBar: (d) => {
        const item = makeStatusBarItem();
        d.push(item);
        return item;
      },
    });

    expect(result).toBeNull();
  });

  it('creates .provenance/ dir and a .slog file with a valid session.start entry', async () => {
    // Arrange: create a signed .cs61a in the workspace dir.
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const manifestFields = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const sig = await signManifest(manifestFields, privkeyHex);
    const manifest: Cs61aManifest = { ...manifestFields, sig };

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));
    const disposables: import('vscode').Disposable[] = [];

    // Act: run activateImpl with a preloaded manifest (skips file I/O for manifest).
    const session = await activateImpl({
      workspaceFolder: makeWorkspaceFolder(workspaceDir),
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      pubkeyHex,
      provenanceDirOverride: provenanceDir,
      clock,
      disposables,
      createStatusBar: (d) => {
        const item = makeStatusBarItem();
        d.push(item);
        return item;
      },
      preloadedManifest: manifest,
    });

    expect(session).not.toBeNull();
    expect(session!.slogPath).toContain('session-');
    expect(session!.slogPath).toContain('.slog');

    // Trigger dispose to flush session.end and close the writer. The deactivation
    // disposable returns a Thenable from writer.dispose(); await each.
    for (const d of disposables) {
      const result = d.dispose();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        await result;
      }
    }

    // Assert: the .slog file exists.
    const slogContents = await fs.readFile(session!.slogPath, 'utf8');
    expect(slogContents.trim().length).toBeGreaterThan(0);

    // Assert: parse the entries.
    const parseResult = parseEntries(slogContents);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const entries = parseResult.value;
    expect(entries.length).toBeGreaterThanOrEqual(2); // session.start + session.end

    // Assert: first entry is session.start.
    expect(entries[0]?.kind).toBe('session.start');

    // Assert: last entry is session.end.
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry?.kind).toBe('session.end');

    // Assert: session.start data has required PRD §5.1 fields.
    const startData = entries[0]?.data as {
      format_version: string;
      session_id: string;
      assignment: { id: string; semester: string };
    };
    expect(startData.format_version).toBe('1.0');
    expect(startData.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(startData.assignment.id).toBe('hw03');
    expect(startData.assignment.semester).toBe('fa26');

    // Assert: chain validates end-to-end.
    const chainResult = validateChain(entries as Parameters<typeof validateChain>[0]);
    expect(chainResult.ok).toBe(true);
  });

  it('returns null when signature is invalid (signed by different keypair)', async () => {
    // Arrange: create a manifest signed with keypair A, but pass pubkey B to activateImpl.
    const { privkeyHex: privkeyA } = await generateTestKeypair();
    const { pubkeyHex: pubkeyB } = await generateTestKeypair();

    const manifestFields = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const sig = await signManifest(manifestFields, privkeyA);

    // Write the signed manifest to disk with keypair A's signature.
    const manifestPath = path.join(workspaceDir, '.cs61a');
    const manifest: Cs61aManifest = { ...manifestFields, sig };
    await fs.writeFile(manifestPath, JSON.stringify(manifest) + '\n', 'utf8');

    const disposables: import('vscode').Disposable[] = [];

    // Act: activateImpl with pubkeyB, which doesn't match the signature.
    const result = await activateImpl({
      workspaceFolder: makeWorkspaceFolder(workspaceDir),
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      pubkeyHex: pubkeyB, // Different keypair — signature won't verify.
      provenanceDirOverride: provenanceDir,
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      disposables,
      createStatusBar: (d) => {
        const item = makeStatusBarItem();
        d.push(item);
        return item;
      },
    });

    // Assert: returns null (signature validation failed).
    expect(result).toBeNull();

    // Assert: .provenance dir was NOT created.
    const provExists = await fs
      .access(provenanceDir)
      .then(() => true)
      .catch(() => false);
    expect(provExists).toBe(false);
  });
});
