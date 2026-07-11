/**
 * Filesystem usage measurement for the storage-quota-check cron
 * (`src/jobs/storage-quota-check.ts`).
 *
 * ## Directory-level usage (Provenance's own subtree)
 *
 * `measureUsedBytes` recursively sums the sizes of the regular files under
 * `root` (`BLOB_STORAGE_FS_ROOT`). It deliberately measures only what lives
 * *under* `root` — blobs, plus sibling Provenance dirs like `backups/`
 * (pg-dump) and `.uploads/` (multipart staging) that share the mount — and
 * NOT the whole filesystem.
 *
 * This matters on a shared mount. `root` is frequently a subdirectory of an
 * NFS home shared with other tenants; a filesystem-level `statfs(root)` would
 * report the entire mount's usage (every tenant + anything else on the export),
 * producing false quota alerts even when Provenance's own footprint is tiny.
 * Summing the subtree compares Provenance's usage against its logical quota
 * (`STORAGE_QUOTA_BYTES`), which is the intended semantics.
 *
 * Trade-off: this does NOT warn when *other* tenants exhaust a shared mount
 * (Provenance writes would still start failing). If you need that signal too,
 * monitor the mount's real free space separately; the quota check is about
 * Provenance's own allotment. On a dedicated mount the two coincide.
 *
 * `runStorageQuotaCheck` takes `measure` as an injected function, so this
 * implementation can be swapped (e.g. for a fileserver-native quota query)
 * without touching the cron logic.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Returns the total number of bytes used by regular files in the tree rooted
 * at `root`, computed by walking the directory and summing each file's logical
 * size. Symlinks are not followed (they are neither `isFile()` nor
 * `isDirectory()` in a `withFileTypes` listing, so they are skipped). Entries
 * that vanish mid-walk (e.g. a concurrent retention sweep or ingest) are
 * tolerated rather than throwing.
 */
export async function measureUsedBytes(root: string): Promise<number> {
  let total = 0;

  const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return; // directory removed mid-walk
      throw err;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch (err) {
          if (!isMissing(err)) throw err; // file removed mid-walk
        }
      }
    }
  };

  await walk(root);
  return total;
}
