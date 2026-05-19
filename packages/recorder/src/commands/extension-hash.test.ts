/**
 * Tests for computeExtensionHash.
 *
 * Coverage:
 * 1. Stable hash on the same directory across multiple calls.
 * 2. Different file content → different hash.
 * 3. Different file path (same content) → different hash (path is part of input).
 * 4. Empty directory → sha256 of empty bytes (known constant).
 * 5. Single file → deterministic hash.
 * 6. Ordering invariant: hash is the same regardless of readdir order (simulated by
 *    having two files and verifying the hash matches when we verify our own algorithm
 *    manually).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { computeExtensionHash } from './extension-hash.js';

// sha256 of empty bytes (known constant — also in log-core hash-chain.test.ts)
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkTmpDir(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), 'provenance-ext-hash-test-'));
}

async function writeFile(dir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(dir, relativePath);
  await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
  await fsPromises.writeFile(fullPath, content, 'utf8');
}

/**
 * Manually compute the expected hash using the documented algorithm.
 * This is the reference implementation for test assertions.
 */
function manualHash(files: { rel: string; content: Buffer }[]): string {
  // Sort by relative path (same as the implementation).
  const sorted = [...files].sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = createHash('sha256');
  for (const { rel, content } of sorted) {
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(content);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeExtensionHash', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTmpDir();
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns sha256 of empty bytes for an empty directory', async () => {
    const result = await computeExtensionHash(tmpDir);
    expect(result).toBe(SHA256_EMPTY);
  });

  it('returns the same hash across multiple calls on the same directory', async () => {
    await writeFile(tmpDir, 'extension.js', 'console.log("hello");');
    await writeFile(tmpDir, 'extension.js.map', '{}');

    const first = await computeExtensionHash(tmpDir);
    const second = await computeExtensionHash(tmpDir);

    expect(first).toBe(second);
  });

  it('returns a different hash when file content changes', async () => {
    await writeFile(tmpDir, 'extension.js', 'console.log("hello");');
    const before = await computeExtensionHash(tmpDir);

    // Overwrite with different content.
    await writeFile(tmpDir, 'extension.js', 'console.log("MODIFIED");');
    const after = await computeExtensionHash(tmpDir);

    expect(before).not.toBe(after);
  });

  it('returns a different hash when file path changes (same content)', async () => {
    await writeFile(tmpDir, 'fileA.js', 'same content');
    const hashA = await computeExtensionHash(tmpDir);

    // Remove fileA and add fileB with same content.
    await fsPromises.unlink(path.join(tmpDir, 'fileA.js'));
    await writeFile(tmpDir, 'fileB.js', 'same content');
    const hashB = await computeExtensionHash(tmpDir);

    expect(hashA).not.toBe(hashB);
  });

  it('produces a 64-char lowercase hex string', async () => {
    await writeFile(tmpDir, 'extension.js', 'test content');
    const result = await computeExtensionHash(tmpDir);

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches manual algorithm for a single file', async () => {
    const content = 'export function activate() {}';
    await writeFile(tmpDir, 'extension.js', content);

    const result = await computeExtensionHash(tmpDir);
    const expected = manualHash([{ rel: 'extension.js', content: Buffer.from(content, 'utf8') }]);

    expect(result).toBe(expected);
  });

  it('matches manual algorithm for multiple files', async () => {
    const files = [
      { rel: 'extension.js', content: Buffer.from('main module', 'utf8') },
      { rel: 'utils.js', content: Buffer.from('helpers', 'utf8') },
      { rel: 'sub/nested.js', content: Buffer.from('nested', 'utf8') },
    ];

    for (const { rel, content } of files) {
      await writeFile(tmpDir, rel, content.toString('utf8'));
    }

    const result = await computeExtensionHash(tmpDir);
    const expected = manualHash(files);

    expect(result).toBe(expected);
  });

  it('handles binary file content correctly', async () => {
    // Write a file with arbitrary binary bytes.
    const binaryContent = Buffer.from([0x00, 0xff, 0x42, 0x80, 0x10]);
    const filePath = path.join(tmpDir, 'binary.bin');
    await fsPromises.writeFile(filePath, binaryContent);

    const result = await computeExtensionHash(tmpDir);
    const expected = manualHash([{ rel: 'binary.bin', content: binaryContent }]);

    expect(result).toBe(expected);
  });

  it('returns sha256 of empty bytes for a non-existent directory', async () => {
    // computeExtensionHash is defensive: if the dir doesn't exist, collectFiles
    // catches the error and returns [], yielding sha256 of empty bytes.
    const nonExistent = path.join(tmpDir, 'does-not-exist');
    const result = await computeExtensionHash(nonExistent);
    expect(result).toBe(SHA256_EMPTY);
  });
});
