/**
 * Pure nearest-ancestor ownership resolution (spec Design §3, Locked decision 5:
 * "A file belongs to the session of the nearest ancestor directory that has a
 * verified manifest"). No VS Code imports — testable in complete isolation.
 *
 * This is the single source of truth "given a path, which assignment root owns
 * it?" answer that every wiring module (doc, fs-watcher, terminal, git) consults
 * to build its own isOwnedByThisRoot filter (plan decision 2).
 */

import * as path from 'node:path';

/**
 * Resolve which of `assignmentRoots` is the nearest ancestor of `filePath`, or
 * null if none of them contain it.
 *
 * "Nearest ancestor" = the longest matching root path (a root nested inside
 * another root wins for paths beneath it, per spec Locked decision 5).
 *
 * A path equal to a root itself is considered owned by that root (path.relative
 * returns '' in that case).
 */
export function resolveOwnerRoot(
  filePath: string,
  assignmentRoots: readonly string[],
): string | null {
  let best: string | null = null;

  for (const root of assignmentRoots) {
    const rel = path.relative(root, filePath);
    const isInside =
      rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
    if (!isInside) continue;

    if (best === null || root.length > best.length) {
      best = root;
    }
  }

  return best;
}
