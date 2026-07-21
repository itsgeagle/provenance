import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { startTerminalWiring } from './terminal-wiring.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTerminal(opts: {
  shellPath?: string;
  hasShellIntegration?: boolean;
}): vscode.Terminal {
  return {
    // cwd is always present (VS Code resolves a default even when the caller
    // didn't request one) so pre-existing tests, which don't exercise cwd
    // resolution, keep emitting under the default "owns everything" filter.
    creationOptions: { shellPath: opts.shellPath, cwd: '/ws/default' },
    shellIntegration: opts.hasShellIntegration ? { executeCommand: vi.fn() } : undefined,
  } as unknown as vscode.Terminal;
}

function makeExecution(commandValue: string): vscode.TerminalShellExecution {
  return {
    commandLine: { value: commandValue },
  } as unknown as vscode.TerminalShellExecution;
}

type Deps = ReturnType<typeof makeDeps>['deps'];

function makeDeps() {
  const emittedOpen: Array<{ terminal_id: string; shell: string; shell_integration: boolean }> = [];
  const emittedCommand: Array<{ terminal_id: string; command: string; exit_code?: number }> = [];

  // Capture handlers registered via the subscription functions.
  let openHandler: ((t: vscode.Terminal) => void) | undefined;
  let closeHandler: ((t: vscode.Terminal) => void) | undefined;
  let startHandler: ((e: vscode.TerminalShellExecutionStartEvent) => void) | undefined;
  let endHandler: ((e: vscode.TerminalShellExecutionEndEvent) => void) | undefined;

  const deps = {
    emitTerminalOpen: (d: { terminal_id: string; shell: string; shell_integration: boolean }) => {
      emittedOpen.push(d);
    },
    emitTerminalCommand: (d: { terminal_id: string; command: string; exit_code?: number }) => {
      emittedCommand.push(d);
    },
    onDidOpenTerminal: (h: (t: vscode.Terminal) => void) => {
      openHandler = h;
      return { dispose: () => undefined };
    },
    onDidCloseTerminal: (h: (t: vscode.Terminal) => void) => {
      closeHandler = h;
      return { dispose: () => undefined };
    },
    onDidStartTerminalShellExecution: (h: (e: vscode.TerminalShellExecutionStartEvent) => void) => {
      startHandler = h;
      return { dispose: () => undefined };
    },
    onDidEndTerminalShellExecution: (h: (e: vscode.TerminalShellExecutionEndEvent) => void) => {
      endHandler = h;
      return { dispose: () => undefined };
    },
  };

  const fire = {
    open: (t: vscode.Terminal) => openHandler!(t),
    close: (t: vscode.Terminal) => closeHandler!(t),
    start: (e: vscode.TerminalShellExecutionStartEvent) => startHandler!(e),
    end: (e: vscode.TerminalShellExecutionEndEvent) => endHandler!(e),
  };

  return { deps, fire, emittedOpen, emittedCommand };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startTerminalWiring — terminal.open', () => {
  it('emits terminal.open with shell from creationOptions.shellPath', () => {
    const { deps, fire, emittedOpen } = makeDeps();
    startTerminalWiring(deps);
    fire.open(makeTerminal({ shellPath: '/bin/zsh', hasShellIntegration: false }));
    expect(emittedOpen).toHaveLength(1);
    expect(emittedOpen[0]!.shell).toBe('/bin/zsh');
  });

  it('emits terminal.open with shell "unknown" when shellPath absent', () => {
    const { deps, fire, emittedOpen } = makeDeps();
    startTerminalWiring(deps);
    fire.open(makeTerminal({}));
    expect(emittedOpen[0]!.shell).toBe('unknown');
  });

  it('emits shell_integration: false when shellIntegration is undefined', () => {
    const { deps, fire, emittedOpen } = makeDeps();
    startTerminalWiring(deps);
    fire.open(makeTerminal({ hasShellIntegration: false }));
    expect(emittedOpen[0]!.shell_integration).toBe(false);
  });

  it('emits shell_integration: true when shellIntegration is present', () => {
    const { deps, fire, emittedOpen } = makeDeps();
    startTerminalWiring(deps);
    fire.open(makeTerminal({ hasShellIntegration: true }));
    expect(emittedOpen[0]!.shell_integration).toBe(true);
  });

  it('assigns sequential terminal_ids across multiple opens', () => {
    const { deps, fire, emittedOpen } = makeDeps();
    startTerminalWiring(deps);
    fire.open(makeTerminal({}));
    fire.open(makeTerminal({}));
    expect(emittedOpen[0]!.terminal_id).toBe('term-0');
    expect(emittedOpen[1]!.terminal_id).toBe('term-1');
  });
});

describe('startTerminalWiring — terminal.close', () => {
  it('does not emit any extra event on close', () => {
    const { deps, fire, emittedOpen, emittedCommand } = makeDeps();
    startTerminalWiring(deps);
    const t = makeTerminal({});
    fire.open(t);
    fire.close(t);
    expect(emittedOpen).toHaveLength(1);
    expect(emittedCommand).toHaveLength(0);
  });

  it('removes the terminal from the map (re-open gets a new id)', () => {
    const { deps, fire, emittedOpen } = makeDeps();
    startTerminalWiring(deps);
    const t = makeTerminal({});
    fire.open(t);
    fire.close(t);
    // Re-open the same JS object — should get a fresh id.
    fire.open(t);
    expect(emittedOpen[0]!.terminal_id).toBe('term-0');
    expect(emittedOpen[1]!.terminal_id).toBe('term-1');
  });
});

describe('startTerminalWiring — terminal.command (shell integration available)', () => {
  it('emits terminal.command with command text and exit_code on execution end', () => {
    const { deps, fire, emittedCommand } = makeDeps();
    startTerminalWiring(deps);
    const t = makeTerminal({ hasShellIntegration: true });
    fire.open(t);
    const exec = makeExecution('python hw.py');
    fire.start({
      terminal: t,
      execution: exec,
    } as unknown as vscode.TerminalShellExecutionStartEvent);
    fire.end({
      terminal: t,
      execution: exec,
      exitCode: 0,
    } as unknown as vscode.TerminalShellExecutionEndEvent);
    expect(emittedCommand).toHaveLength(1);
    expect(emittedCommand[0]!.command).toBe('python hw.py');
    expect(emittedCommand[0]!.exit_code).toBe(0);
  });

  it('omits exit_code field when exitCode is undefined', () => {
    const { deps, fire, emittedCommand } = makeDeps();
    startTerminalWiring(deps);
    const t = makeTerminal({ hasShellIntegration: true });
    fire.open(t);
    const exec = makeExecution('ls');
    fire.start({
      terminal: t,
      execution: exec,
    } as unknown as vscode.TerminalShellExecutionStartEvent);
    fire.end({
      terminal: t,
      execution: exec,
      exitCode: undefined,
    } as unknown as vscode.TerminalShellExecutionEndEvent);
    expect(emittedCommand[0]).not.toHaveProperty('exit_code');
  });

  it('end event without matching start is ignored', () => {
    const { deps, fire, emittedCommand } = makeDeps();
    startTerminalWiring(deps);
    const t = makeTerminal({ hasShellIntegration: true });
    fire.open(t);
    const exec = makeExecution('echo hi');
    // Fire end without start.
    fire.end({
      terminal: t,
      execution: exec,
      exitCode: 0,
    } as unknown as vscode.TerminalShellExecutionEndEvent);
    expect(emittedCommand).toHaveLength(0);
  });

  it('terminal_id in terminal.command matches terminal_id from terminal.open', () => {
    const { deps, fire, emittedOpen, emittedCommand } = makeDeps();
    startTerminalWiring(deps);
    const t = makeTerminal({ hasShellIntegration: true });
    fire.open(t);
    const exec = makeExecution('npm test');
    fire.start({
      terminal: t,
      execution: exec,
    } as unknown as vscode.TerminalShellExecutionStartEvent);
    fire.end({
      terminal: t,
      execution: exec,
      exitCode: 1,
    } as unknown as vscode.TerminalShellExecutionEndEvent);
    expect(emittedCommand[0]!.terminal_id).toBe(emittedOpen[0]!.terminal_id);
  });
});

describe('startTerminalWiring — shell execution unavailable', () => {
  it('does not emit terminal.command when shell integration hooks are absent', () => {
    const { emittedOpen, emittedCommand } = makeDeps();
    // Build deps without the shell-exec hooks.
    let openHandler: ((t: vscode.Terminal) => void) | undefined;
    const limitedDeps = {
      emitTerminalOpen: (d: Parameters<Deps['emitTerminalOpen']>[0]) => emittedOpen.push(d),
      emitTerminalCommand: (d: Parameters<Deps['emitTerminalCommand']>[0]) =>
        emittedCommand.push(d),
      onDidOpenTerminal: (h: (t: vscode.Terminal) => void) => {
        openHandler = h;
        return { dispose: () => undefined };
      },
      onDidCloseTerminal: (_h: (t: vscode.Terminal) => void) => ({ dispose: () => undefined }),
      // Intentionally omit onDidStartTerminalShellExecution / onDidEndTerminalShellExecution
    };
    startTerminalWiring(limitedDeps);
    openHandler!(makeTerminal({ hasShellIntegration: true }));
    // No command emitted — we can't subscribe without the hooks.
    expect(emittedCommand).toHaveLength(0);
    expect(emittedOpen).toHaveLength(1);
  });
});

describe('cwd-based ownership routing', () => {
  function makeTerminal(opts: { cwd?: string; shellIntegrationCwd?: string }): vscode.Terminal {
    return {
      creationOptions: opts.cwd !== undefined ? { cwd: opts.cwd } : {},
      shellIntegration:
        opts.shellIntegrationCwd !== undefined
          ? { cwd: { fsPath: opts.shellIntegrationCwd } }
          : undefined,
    } as unknown as vscode.Terminal;
  }

  it('emits terminal.open when the terminal cwd (via creationOptions) is owned', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: vscode.Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    openHandler!(makeTerminal({ cwd: '/ws/cats' }));
    expect(emitTerminalOpen).toHaveBeenCalledOnce();
  });

  it('drops terminal.open when the resolved cwd is owned by no session', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: vscode.Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    openHandler!(makeTerminal({ cwd: '/ws/parent' }));
    expect(emitTerminalOpen).not.toHaveBeenCalled();
  });

  it('drops terminal.open when cwd cannot be determined at all', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: vscode.Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: () => true, // even an "owns everything" filter can't help with unknown cwd
    });
    openHandler!(makeTerminal({}));
    expect(emitTerminalOpen).not.toHaveBeenCalled();
  });

  it('prefers shellIntegration.cwd over creationOptions.cwd when both are present', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: vscode.Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      isOwnedByThisRoot: (fsPath) => fsPath === '/ws/hog', // only the shellIntegration cwd is owned
    });
    openHandler!(makeTerminal({ cwd: '/ws/cats', shellIntegrationCwd: '/ws/hog' }));
    expect(emitTerminalOpen).toHaveBeenCalledOnce();
  });

  it('defaults to owning everything when isOwnedByThisRoot is omitted, as long as cwd resolves (regression)', () => {
    const emitTerminalOpen = vi.fn();
    let openHandler: ((t: vscode.Terminal) => void) | undefined;
    startTerminalWiring({
      emitTerminalOpen,
      emitTerminalCommand: vi.fn(),
      onDidOpenTerminal: (h) => {
        openHandler = h;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
    });
    openHandler!(makeTerminal({ cwd: '/ws/hw03' }));
    expect(emitTerminalOpen).toHaveBeenCalledOnce();
  });
});

describe('startTerminalWiring — dispose', () => {
  it('dispose cleans up subscriptions (all provided disposables disposed)', () => {
    const disposeCalls: string[] = [];
    const deps = {
      emitTerminalOpen: () => undefined,
      emitTerminalCommand: () => undefined,
      onDidOpenTerminal: (_h: (t: vscode.Terminal) => void) => ({
        dispose: () => disposeCalls.push('open'),
      }),
      onDidCloseTerminal: (_h: (t: vscode.Terminal) => void) => ({
        dispose: () => disposeCalls.push('close'),
      }),
      onDidStartTerminalShellExecution: (
        _h: (e: vscode.TerminalShellExecutionStartEvent) => void,
      ) => ({ dispose: () => disposeCalls.push('start') }),
      onDidEndTerminalShellExecution: (_h: (e: vscode.TerminalShellExecutionEndEvent) => void) => ({
        dispose: () => disposeCalls.push('end'),
      }),
    };
    const wiring = startTerminalWiring(deps);
    wiring.dispose();
    expect(disposeCalls).toContain('open');
    expect(disposeCalls).toContain('close');
    expect(disposeCalls).toContain('start');
    expect(disposeCalls).toContain('end');
  });
});
