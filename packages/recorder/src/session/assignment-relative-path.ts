/**
 * Assignment-root-relative path resolution (plan decision 4).
 *
 * vscode.workspace.asRelativePath() resolves relative to whichever *opened*
 * workspace folder contains a file. That happened to equal the assignment root
 * when a workspace folder WAS the assignment root (the pre-nested-discovery
 * invariant this whole feature breaks). Once one opened folder can contain
 * several assignment roots, doc.* payload paths, files_under_review matching,
 * and read-file resolution all need paths relative to the OWNING assignment
 * root specifically — not the outer folder. This module computes that,
 * independent of any vscode.workspace state.
 *
 * The "outside root" fallback (return the fsPath unchanged) mirrors
 * vscode.workspace.asRelativePath's own convention, which existing callers
 * (doc-wiring's isRecordable) rely on to detect "outside" via `rel === fsPath`.
 */

import * as path from 'node:path';

export function makeAssignmentRelativePath(assignmentRoot: string): (fsPath: string) => string {
  return (fsPath: string): string => {
    const rel = path.relative(assignmentRoot, fsPath);
    const isInside =
      rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
    return isInside ? rel : fsPath;
  };
}
