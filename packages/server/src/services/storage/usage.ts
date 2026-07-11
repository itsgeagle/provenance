/**
 * Filesystem usage measurement for the storage-quota-check cron
 * (`src/jobs/storage-quota-check.ts`).
 *
 * ## Caveat: this is FILESYSTEM-level usage, not directory-level
 *
 * `measureUsedBytes` uses `node:fs/promises` `statfs(root)`, which reports
 * usage for the whole filesystem/mount that `root` lives on — not the byte
 * count of files under `root` specifically. This is the right measure when
 * `root` (`BLOB_STORAGE_FS_ROOT`) is the entire NFS mount dedicated to
 * Provenance (the EECS apphost setup: a single 1TB-quota'd mount bind-mounted
 * in whole). It is the WRONG measure if:
 *   - `root` is a subdirectory that shares a filesystem/mount with other
 *     tenants (statfs will report the whole mount's usage, not just this
 *     subtree's), or
 *   - the fileserver enforces a quota that isn't reflected in `statfs` at all
 *     (e.g. some NFS quota implementations meter usage server-side without
 *     exposing it through the client-side statfs syscall).
 *
 * In either case, swap this implementation for a directory-walk byte sum (or
 * whatever quota-reporting mechanism the fileserver exposes) — the caller
 * (`runStorageQuotaCheck`) takes `measure` as an injected function precisely
 * so this can be swapped without touching the cron logic.
 */

import { statfs } from 'node:fs/promises';

/**
 * Returns the number of bytes used on the filesystem containing `root`,
 * computed as `(blocks - bavail) * bsize` (total space minus space available
 * to unprivileged processes, i.e. what statfs considers "used").
 */
export async function measureUsedBytes(root: string): Promise<number> {
  const stats = await statfs(root);
  return (stats.blocks - stats.bavail) * stats.bsize;
}
