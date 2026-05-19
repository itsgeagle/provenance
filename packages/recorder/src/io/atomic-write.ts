/**
 * Atomic file write: write-temp → fsync → rename.
 *
 * CLAUDE.md: "Atomic writes. Write-temp-then-rename. Never partial-write the live log file."
 * PRD §4.6: "Both files are written atomically (write to `.tmp`, fsync, rename)."
 *
 * Used for `.meta` file updates and any other single-write files.
 * The `.slog` itself is append-only (SessionWriter); this helper is for whole-file writes.
 */

import * as fsPromises from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Injectable fs seam (for testing rename-failure cleanup)
// ---------------------------------------------------------------------------

/**
 * Subset of `node:fs/promises` needed by atomicWriteFile.
 * Production callers pass nothing (defaults to the real fs).
 * Tests can inject a mock to simulate rename/unlink failures.
 */
export type AtomicWriteFs = {
  open: typeof fsPromises.open;
  rename: typeof fsPromises.rename;
  unlink: typeof fsPromises.unlink;
};

/**
 * Write `contents` to `targetPath` atomically.
 *
 * Algorithm:
 *   1. Write to `<targetPath>.<pid>.<randomHex>.tmp`.
 *   2. fsync the file handle to flush to disk.
 *   3. Rename the temp file to `targetPath` (atomic on POSIX).
 *   4. On any error: silently attempt to unlink the temp file, then re-throw
 *      the original error (never mask the original error).
 *
 * @param _fs  Injectable fs operations; defaults to the real `node:fs/promises`.
 *             Tests inject a mock to simulate rename failures without ESM-spy issues.
 *
 * Throws on error (callers that use this for meta-file writes want to know).
 */
export async function atomicWriteFile(
  targetPath: string,
  contents: string | Uint8Array,
  _fs: AtomicWriteFs = fsPromises,
): Promise<void> {
  const randomHex = randomBytes(8).toString('hex');
  const tmpPath = `${targetPath}.${process.pid}.${randomHex}.tmp`;

  let fh: fsPromises.FileHandle | undefined;
  try {
    // Open with 'w' to create/truncate and get a FileHandle for fsync.
    fh = await _fs.open(tmpPath, 'w');
    // Narrow the union so TypeScript can pick the right FileHandle.write overload.
    if (typeof contents === 'string') {
      await fh.write(contents, null, 'utf8');
    } else {
      await fh.write(contents);
    }
    await fh.sync();
    await fh.close();
    fh = undefined; // Successfully closed; don't close again in finally.

    await _fs.rename(tmpPath, targetPath);
  } catch (originalError) {
    // Best-effort unlink of the temp file. Do not mask the original error.
    try {
      await _fs.unlink(tmpPath);
    } catch {
      // Silently ignore — the temp file may not exist (e.g., open() itself failed).
    }

    // Re-close the handle if close() above didn't happen (e.g., rename failed).
    if (fh !== undefined) {
      try {
        await fh.close();
      } catch {
        // Silently ignore secondary close error.
      }
    }

    throw originalError;
  }
}
