/**
 * Seal-time assignment selector (spec Design §4). When exactly one session is
 * active, sealing proceeds without a prompt (unchanged behavior). When more than
 * one is active, the student is prompted via QuickPick to choose which assignment
 * to bundle. Pure logic here; extension.ts supplies the real vscode.window.showQuickPick.
 */

import { resolveOwnerRoot } from '../session/session-router.js';
import type { ActiveSession } from '../session/session-registry.js';

export type SealQuickPickItem = {
  label: string;
  description: string;
  session: ActiveSession;
};

export function buildSealQuickPickItems(sessions: readonly ActiveSession[]): SealQuickPickItem[] {
  return sessions.map((session) => ({
    label: session.manifest.assignment_id,
    description: session.assignmentRoot,
    session,
  }));
}

/**
 * Choose which session to seal.
 *
 * - No sessions: returns undefined without prompting (caller shows "no session data").
 * - Exactly one session: returns it directly, no prompt (regression-preserving).
 * - More than one: prompts via showQuickPick. If activeEditorPath resolves to one
 *   of the sessions (nearest-ancestor), that session's item is sorted first so
 *   VS Code's QuickPick highlights it as the default.
 */
export async function chooseSessionForSeal(
  sessions: readonly ActiveSession[],
  showQuickPick: (
    items: SealQuickPickItem[],
    opts: { placeHolder: string },
  ) => Promise<SealQuickPickItem | undefined>,
  activeEditorPath?: string,
): Promise<ActiveSession | undefined> {
  if (sessions.length === 0) {
    return undefined;
  }
  if (sessions.length === 1) {
    return sessions[0];
  }

  let ordered = [...sessions];
  if (activeEditorPath !== undefined) {
    const owningRoot = resolveOwnerRoot(
      activeEditorPath,
      sessions.map((s) => s.assignmentRoot),
    );
    if (owningRoot !== null) {
      ordered = [
        ...ordered.filter((s) => s.assignmentRoot === owningRoot),
        ...ordered.filter((s) => s.assignmentRoot !== owningRoot),
      ];
    }
  }

  const items = buildSealQuickPickItems(ordered);
  const chosen = await showQuickPick(items, {
    placeHolder: 'Select which assignment to prepare a submission bundle for',
  });
  return chosen?.session;
}
