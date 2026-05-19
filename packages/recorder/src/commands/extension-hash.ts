/**
 * Compute a stable, reproducible hash over the recorder extension's dist/ directory.
 *
 * PRD §6: "the bundle manifest will have an `extension_hash` field that doesn't match
 * the course-known good hash" if the extension has been modified.
 *
 * Algorithm:
 *   1. Walk `extensionDistPath` recursively; collect all file paths.
 *   2. Sort entries lexicographically by their path relative to extensionDistPath.
 *      Sorting eliminates filesystem-ordering non-determinism.
 *   3. For each file (in sorted order), concatenate:
 *        <relative-path>\0<file-bytes>
 *      (A NUL byte separates the path from the content to prevent collisions between
 *      a path ending in a byte that starts the next file's content.)
 *   4. SHA-256 the concatenated byte sequence. Return hex.
 *
 * Reproducibility guarantee: given the same file tree with the same contents and the
 * same relative paths, this function returns the same hash regardless of filesystem,
 * OS, or run order. The sort on step 2 is the critical invariant — without it, two
 * different machines with different readdir orderings would produce different hashes.
 *
 * Analyzer re-verification: the Analyzer (or course staff tooling) can reproduce this
 * hash from a known-good VSIX by extracting the dist/ directory and running the same
 * algorithm. The course maintains the expected hash out-of-band (e.g., in the .cs61a
 * manifest generator, not in the extension itself).
 *
 * Empty directory: returns the sha256 of an empty byte sequence:
 *   e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory and collect all file paths (not directories).
 * Returns absolute paths.
 */
async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let names: string[];
    try {
      names = await fsPromises.readdir(current);
    } catch {
      // If the directory doesn't exist or isn't readable, treat as empty.
      return;
    }

    for (const name of names) {
      const fullPath = path.join(current, name);
      let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
      try {
        stat = await fsPromises.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (stat.isFile()) {
        results.push(fullPath);
      }
      // Symlinks and other types are intentionally skipped.
    }
  }

  await walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a reproducible SHA-256 over all files in `extensionDistPath`.
 *
 * @param extensionDistPath  Absolute path to the recorder's dist/ directory.
 * @returns Lowercase hex SHA-256 string (64 chars).
 *
 * @see Module JSDoc for the full algorithm specification.
 */
export async function computeExtensionHash(extensionDistPath: string): Promise<string> {
  const absolutePaths = await collectFiles(extensionDistPath);

  // Sort by relative path for determinism across filesystems.
  const relativePaths = absolutePaths.map((abs) => ({
    abs,
    rel: path.relative(extensionDistPath, abs),
  }));
  relativePaths.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash('sha256');

  for (const { abs, rel } of relativePaths) {
    const bytes = await fsPromises.readFile(abs);
    // Concatenate: <relative-path bytes> + NUL + <file bytes>
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(Buffer.from([0])); // NUL separator
    hash.update(bytes);
  }

  return hash.digest('hex');
}
