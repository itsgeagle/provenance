/**
 * Tests for atomicWriteFile.
 * Uses a real tmp dir per test; cleans up in afterEach.
 * CLAUDE.md: "Atomic writes. Write-temp-then-rename. Never partial-write the live log file."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWriteFile, AtomicWriteFs } from './atomic-write.js';

describe('atomicWriteFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trip: writes a file and reads back matching contents', async () => {
    const targetPath = path.join(tmpDir, 'output.txt');
    const content = 'hello, atomic world\n';

    await atomicWriteFile(targetPath, content);

    const read = await fsPromises.readFile(targetPath, 'utf8');
    expect(read).toBe(content);
  });

  it('idempotent re-write: second write wins', async () => {
    const targetPath = path.join(tmpDir, 'output.txt');

    await atomicWriteFile(targetPath, 'first write');
    await atomicWriteFile(targetPath, 'second write');

    const read = await fsPromises.readFile(targetPath, 'utf8');
    expect(read).toBe('second write');
  });

  it('Uint8Array contents round-trip correctly', async () => {
    const targetPath = path.join(tmpDir, 'binary.bin');
    const content = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

    await atomicWriteFile(targetPath, content);

    const read = await fsPromises.readFile(targetPath);
    expect(Buffer.from(read)).toEqual(Buffer.from(content));
  });

  it('rename failure: temp file is unlinked and original error propagates', async () => {
    const targetPath = path.join(tmpDir, 'output.txt');
    const renameError = new Error('rename failed (simulated)');

    // Inject a mock fs that throws on rename but delegates open/unlink to the real fs.
    // This avoids ESM module-property redefinition issues with vi.spyOn.
    let unlinkCalled = false;
    const mockFs: AtomicWriteFs = {
      open: fsPromises.open.bind(fsPromises),
      rename: () => Promise.reject(renameError),
      unlink: async (p) => {
        unlinkCalled = true;
        return fsPromises.unlink(p);
      },
    };

    await expect(atomicWriteFile(targetPath, 'some content', mockFs)).rejects.toThrow(
      'rename failed',
    );

    // The target file should NOT have been created (rename never succeeded).
    const targetExists = await fsPromises
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    expect(targetExists).toBe(false);

    // unlink should have been called to clean up the temp file.
    expect(unlinkCalled).toBe(true);

    // All *.tmp files in the tmp dir should have been unlinked.
    const entries = await fsPromises.readdir(tmpDir);
    const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});
