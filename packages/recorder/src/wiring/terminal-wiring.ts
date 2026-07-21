/**
 * terminal-wiring.ts — subscribe to VS Code terminal lifecycle events.
 *
 * PRD §4.2: emit terminal.open (with shell_integration flag), terminal.command.
 * PRD §4.4: shell integration is optional; if unavailable we record terminal.open
 * only and note the gap via shell_integration: false.
 *
 * - Maintain a Map<Terminal, string> of terminal_id (counter-based: "term-0", "term-1", …).
 * - On open: emit terminal.open with shell_integration: terminal.shellIntegration !== undefined.
 * - On start/end of shell execution (VS Code 1.93+ API): emit terminal.command with exit_code.
 * - On close: clean up the map.
 * - If onDidStartTerminalShellExecution is absent (older VS Code), we simply don't emit
 *   terminal.command — the PRD says record the gap, not fail.
 */

import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalWiringDeps = {
  emitTerminalOpen: (data: {
    terminal_id: string;
    shell: string;
    shell_integration: boolean;
  }) => void;
  emitTerminalCommand: (data: { terminal_id: string; command: string; exit_code?: number }) => void;
  onDidOpenTerminal: (h: (t: vscode.Terminal) => void) => vscode.Disposable;
  onDidCloseTerminal: (h: (t: vscode.Terminal) => void) => vscode.Disposable;
  /**
   * VS Code 1.93+ API. If undefined, command capture is silently skipped.
   */
  onDidStartTerminalShellExecution?: (
    h: (e: vscode.TerminalShellExecutionStartEvent) => void,
  ) => vscode.Disposable;
  onDidEndTerminalShellExecution?: (
    h: (e: vscode.TerminalShellExecutionEndEvent) => void,
  ) => vscode.Disposable;
  /**
   * Ownership filter: returns true if the given absolute fsPath belongs to THIS
   * session's assignment root. Defaults to "always owned" when omitted.
   */
  isOwnedByThisRoot?: (fsPath: string) => boolean;
};

// ---------------------------------------------------------------------------
// cwd resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a terminal's current working directory, preferring shell-integration's
 * live-updated cwd (accounts for `cd`) over the static creationOptions.cwd set at
 * terminal-creation time. Returns undefined if neither is available.
 */
function resolveTerminalCwd(terminal: vscode.Terminal): string | undefined {
  const shellCwd = terminal.shellIntegration?.cwd;
  if (shellCwd !== undefined) {
    return shellCwd.fsPath;
  }
  const creationCwd = (terminal.creationOptions as { cwd?: string | vscode.Uri } | undefined)?.cwd;
  if (creationCwd === undefined) {
    return undefined;
  }
  return typeof creationCwd === 'string' ? creationCwd : creationCwd.fsPath;
}

// ---------------------------------------------------------------------------
// startTerminalWiring
// ---------------------------------------------------------------------------

export function startTerminalWiring(deps: TerminalWiringDeps): vscode.Disposable {
  const {
    emitTerminalOpen,
    emitTerminalCommand,
    onDidOpenTerminal,
    onDidCloseTerminal,
    onDidStartTerminalShellExecution,
    onDidEndTerminalShellExecution,
  } = deps;

  const isOwnedByThisRoot = deps.isOwnedByThisRoot ?? (() => true);

  function isTerminalOwned(terminal: vscode.Terminal): boolean {
    const cwd = resolveTerminalCwd(terminal);
    return cwd !== undefined && isOwnedByThisRoot(cwd);
  }

  // Map each Terminal object to its stable log-side id.
  const terminalIds = new Map<vscode.Terminal, string>();
  let counter = 0;

  function assignId(terminal: vscode.Terminal): string {
    let id = terminalIds.get(terminal);
    if (id === undefined) {
      id = `term-${counter++}`;
      terminalIds.set(terminal, id);
    }
    return id;
  }

  // Pending executions: keyed by terminal_id + command text (start may precede end).
  // We use the execution object itself as the key.
  type PendingEntry = { terminal_id: string; command: string };
  const pendingExecutions = new Map<vscode.TerminalShellExecution, PendingEntry>();

  // ---- open ----------------------------------------------------------------

  const openSub = onDidOpenTerminal((terminal) => {
    if (!isTerminalOwned(terminal)) return;
    const terminal_id = assignId(terminal);
    const creationOptions = terminal.creationOptions as { shellPath?: string } | undefined;
    const shell = creationOptions?.shellPath ?? 'unknown';
    const shell_integration = terminal.shellIntegration !== undefined;

    emitTerminalOpen({ terminal_id, shell, shell_integration });
  });

  // ---- close ---------------------------------------------------------------

  const closeSub = onDidCloseTerminal((terminal) => {
    terminalIds.delete(terminal);
  });

  // ---- shell execution (1.93+) ---------------------------------------------

  const disposables: vscode.Disposable[] = [openSub, closeSub];

  if (
    onDidStartTerminalShellExecution !== undefined &&
    onDidEndTerminalShellExecution !== undefined
  ) {
    const startSub = onDidStartTerminalShellExecution((event) => {
      if (!isTerminalOwned(event.terminal)) return;
      const terminal_id = assignId(event.terminal);
      // event.execution.commandLine may be undefined on some shell types.
      const commandLine = event.execution.commandLine;
      const command = commandLine?.value ?? '';
      pendingExecutions.set(event.execution, { terminal_id, command });
    });

    const endSub = onDidEndTerminalShellExecution((event) => {
      const pending = pendingExecutions.get(event.execution);
      if (pending === undefined) {
        // end event arrived without a matching start — skip.
        return;
      }
      // Delete before the ownership check so an unowned terminal's entry never
      // leaks in the pending-executions map.
      pendingExecutions.delete(event.execution);
      if (!isTerminalOwned(event.terminal)) return;

      // exitCode is undefined when shell integration couldn't determine it.
      const exit_code = event.exitCode;

      emitTerminalCommand({
        terminal_id: pending.terminal_id,
        command: pending.command,
        ...(exit_code !== undefined ? { exit_code } : {}),
      });
    });

    disposables.push(startSub, endSub);
  }

  return {
    dispose() {
      for (const d of disposables) {
        d.dispose();
      }
      disposables.length = 0;
      terminalIds.clear();
      pendingExecutions.clear();
    },
  };
}
