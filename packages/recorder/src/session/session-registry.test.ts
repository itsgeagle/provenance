import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FixedClock, parseEntries, validateChain, canonicalize } from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';
import { startSession } from './session-registry.js';

function makeExtension(): import('vscode').Extension<unknown> {
  return {
    id: 'itsgeagle.provenance-recorder',
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: { version: '0.0.0', publisher: 'itsgeagle', name: 'provenance-recorder' },
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

async function signedManifest(fields: {
  assignment_id: string;
  semester: string;
  issued_at: string;
  files_under_review: string[];
}): Promise<Manifest> {
  const secretKey = ed.utils.randomSecretKey();
  const payload = canonicalize(fields);
  const sig = await ed.signAsync(new TextEncoder().encode(payload), secretKey);
  return { ...fields, sig: bytesToHex(sig) };
}

describe('startSession', () => {
  let tmpDir: string;
  let assignmentRoot: string;
  let provenanceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-session-'));
    assignmentRoot = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(assignmentRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates .provenance/ dir and a .slog file with a valid session.start entry', async () => {
    const manifest = await signedManifest({
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const session = await startSession({
      assignmentRoot,
      manifest,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: provenanceDir,
    });

    expect(session.slogPath).toContain('session-');
    expect(session.assignmentRoot).toBe(assignmentRoot);

    await session.dispose();

    const slogContents = await fs.readFile(session.slogPath, 'utf8');
    const parseResult = parseEntries(slogContents);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const entries = parseResult.value;
    expect(entries[0]?.kind).toBe('session.start');
    expect(entries[entries.length - 1]?.kind).toBe('session.end');

    const chainResult = validateChain(entries);
    expect(chainResult.ok).toBe(true);
  });

  it('two independent calls to startSession produce independently chained sessions', async () => {
    const manifestA = await signedManifest({
      assignment_id: 'cats',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });
    const manifestB = await signedManifest({
      assignment_id: 'hog',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });

    const rootA = path.join(tmpDir, 'cats');
    const rootB = path.join(tmpDir, 'hog');
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const sessionA = await startSession({
      assignmentRoot: rootA,
      manifest: manifestA,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: path.join(rootA, '.provenance'),
    });
    const sessionB = await startSession({
      assignmentRoot: rootB,
      manifest: manifestB,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: path.join(rootB, '.provenance'),
    });

    expect(sessionA.sessionHost.sessionId).not.toBe(sessionB.sessionHost.sessionId);
    expect(sessionA.provenanceDir).not.toBe(sessionB.provenanceDir);

    await sessionA.dispose();
    await sessionB.dispose();

    // Each session's .slog only contains ITS OWN manifest's assignment id.
    const contentsA = await fs.readFile(sessionA.slogPath, 'utf8');
    const contentsB = await fs.readFile(sessionB.slogPath, 'utf8');
    expect(contentsA).toContain('"cats"');
    expect(contentsA).not.toContain('"hog"');
    expect(contentsB).toContain('"hog"');
    expect(contentsB).not.toContain('"cats"');
  });
});
