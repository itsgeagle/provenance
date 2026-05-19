/**
 * Tests for MetaWriter.
 *
 * Key properties tested:
 * 1. create() writes the initial meta file to disk.
 * 2. appendCheckpoint() persists to disk; subsequent calls append.
 * 3. File content is valid JSON matching SlogMeta shape.
 * 4. dispose() is a no-op (doesn't error).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateMetaShape } from '@provenance/log-core';
import { MetaWriter } from './meta-writer.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FAKE_SESSION_ID = '00000000-0000-0000-0000-000000000001';
const FAKE_PUBKEY = 'a'.repeat(64);
const FAKE_ENCRYPTED_PRIVKEY = {
  algorithm: 'xchacha20-poly1305-hkdf-sha256-v1' as const,
  nonce: 'b'.repeat(48),
  ciphertext: 'c'.repeat(96),
  salt: 'd'.repeat(32),
  info: 'provenance-session-key-v1',
};
const FAKE_CHECKPOINT = {
  seq: 0,
  hash: 'e'.repeat(64),
  sig: 'f'.repeat(128),
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MetaWriter', () => {
  let tmpDir: string;
  let metaPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-writer-test-'));
    metaPath = path.join(tmpDir, 'session-test.slog.meta');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('create() writes the meta file to disk', async () => {
    await MetaWriter.create({
      metaPath,
      sessionId: FAKE_SESSION_ID,
      sessionPubkeyHex: FAKE_PUBKEY,
      encryptedPrivkey: FAKE_ENCRYPTED_PRIVKEY,
    });

    const contents = await fs.readFile(metaPath, 'utf8');
    expect(contents.length).toBeGreaterThan(0);

    const parsed: unknown = JSON.parse(contents);
    const result = validateMetaShape(parsed);
    expect(result.ok).toBe(true);
  });

  it('create() produces a meta file with empty checkpoints initially', async () => {
    await MetaWriter.create({
      metaPath,
      sessionId: FAKE_SESSION_ID,
      sessionPubkeyHex: FAKE_PUBKEY,
      encryptedPrivkey: FAKE_ENCRYPTED_PRIVKEY,
    });

    const contents = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(contents) as { checkpoints: unknown[] };
    expect(parsed.checkpoints).toEqual([]);
  });

  it('appendCheckpoint() writes checkpoint to disk', async () => {
    const writer = await MetaWriter.create({
      metaPath,
      sessionId: FAKE_SESSION_ID,
      sessionPubkeyHex: FAKE_PUBKEY,
      encryptedPrivkey: FAKE_ENCRYPTED_PRIVKEY,
    });

    await writer.appendCheckpoint(FAKE_CHECKPOINT);

    const contents = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(contents) as { checkpoints: unknown[] };
    expect(parsed.checkpoints).toHaveLength(1);
    expect(parsed.checkpoints[0]).toMatchObject({
      seq: 0,
      hash: 'e'.repeat(64),
      sig: 'f'.repeat(128),
    });
  });

  it('second appendCheckpoint() adds to the list (both present on disk)', async () => {
    const writer = await MetaWriter.create({
      metaPath,
      sessionId: FAKE_SESSION_ID,
      sessionPubkeyHex: FAKE_PUBKEY,
      encryptedPrivkey: FAKE_ENCRYPTED_PRIVKEY,
    });

    const cp1 = { seq: 0, hash: 'a'.repeat(64), sig: 'b'.repeat(128) };
    const cp2 = { seq: 100, hash: 'c'.repeat(64), sig: 'd'.repeat(128) };

    await writer.appendCheckpoint(cp1);
    await writer.appendCheckpoint(cp2);

    const contents = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(contents) as { checkpoints: unknown[] };
    expect(parsed.checkpoints).toHaveLength(2);
  });

  it('dispose() resolves without error', async () => {
    const writer = await MetaWriter.create({
      metaPath,
      sessionId: FAKE_SESSION_ID,
      sessionPubkeyHex: FAKE_PUBKEY,
      encryptedPrivkey: FAKE_ENCRYPTED_PRIVKEY,
    });

    await expect(writer.dispose()).resolves.toBeUndefined();
  });

  it('file content is valid SlogMeta after appendCheckpoint', async () => {
    const writer = await MetaWriter.create({
      metaPath,
      sessionId: FAKE_SESSION_ID,
      sessionPubkeyHex: FAKE_PUBKEY,
      encryptedPrivkey: FAKE_ENCRYPTED_PRIVKEY,
    });

    await writer.appendCheckpoint(FAKE_CHECKPOINT);

    const contents = await fs.readFile(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(contents);
    const result = validateMetaShape(parsed);
    expect(result.ok).toBe(true);
  });
});
