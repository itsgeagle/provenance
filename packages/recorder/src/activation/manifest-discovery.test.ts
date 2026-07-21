import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from '@provenance/log-core';
import { discoverManifests } from './manifest-discovery.js';

async function generateTestKeypair(): Promise<{ pubkeyHex: string; privkeyHex: string }> {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return { pubkeyHex: bytesToHex(publicKey), privkeyHex: Buffer.from(secretKey).toString('hex') };
}

async function writeSignedManifest(
  dir: string,
  fields: {
    assignment_id: string;
    semester: string;
    issued_at: string;
    files_under_review: string[];
  },
  privkeyHex: string,
): Promise<void> {
  const payload = canonicalize(fields);
  const sig = await ed.signAsync(new TextEncoder().encode(payload), Buffer.from(privkeyHex, 'hex'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, '.provenance-manifest'),
    JSON.stringify({ ...fields, sig: bytesToHex(sig) }),
    'utf8',
  );
}

describe('discoverManifests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-discovery-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('verifies a manifest at each discovered directory and skips invalid ones', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const { privkeyHex: wrongPrivkey } = await generateTestKeypair();

    const catsDir = path.join(tmpDir, 'cats');
    const hogDir = path.join(tmpDir, 'hog');
    await writeSignedManifest(
      catsDir,
      {
        assignment_id: 'cats',
        semester: 'fa26',
        issued_at: '2026-01-01T00:00:00Z',
        files_under_review: ['hw.py'],
      },
      privkeyHex,
    );
    await writeSignedManifest(
      hogDir,
      // signed with a DIFFERENT key than pubkeyHex below — verification must fail for this one
      {
        assignment_id: 'hog',
        semester: 'fa26',
        issued_at: '2026-01-01T00:00:00Z',
        files_under_review: ['hw.py'],
      },
      wrongPrivkey,
    );

    const result = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: tmpDir } }],
      findFiles: async () => [
        { fsPath: path.join(catsDir, '.provenance-manifest') },
        { fsPath: path.join(hogDir, '.provenance-manifest') },
      ],
      pubkeyHex,
    });

    expect(result.found.map((f) => f.root)).toEqual([catsDir]);
    expect(result.skipped.map((s) => s.root)).toEqual([hogDir]);
    expect(result.skipped[0]?.error.kind).toBe('manifest_signature_invalid');
  });

  it('returns no sessions for a folder with no manifest anywhere', async () => {
    const result = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: tmpDir } }],
      findFiles: async () => [],
    });
    expect(result.found).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('discovers a manifest at the opened root itself (regression: single-assignment case)', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    await writeSignedManifest(
      tmpDir,
      {
        assignment_id: 'hw03',
        semester: 'fa26',
        issued_at: '2026-01-01T00:00:00Z',
        files_under_review: ['hw.py'],
      },
      privkeyHex,
    );
    const result = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: tmpDir } }],
      findFiles: async () => [{ fsPath: path.join(tmpDir, '.provenance-manifest') }],
      pubkeyHex,
    });
    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.root).toBe(tmpDir);
  });
});
