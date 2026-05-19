/**
 * Minimal vscode module mock for unit tests.
 * Provides only the surface area used by the recorder's source files.
 * CLAUDE.md: "Do not write tests that exercise VS Code APIs from unit tests. Mock at the seam."
 */

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export const version = '1.97.0';

export const workspace = {
  workspaceFolders: undefined as unknown as unknown[],
};

export const window = {
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => ({
    text: '',
    tooltip: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
};

export const extensions = {
  getExtension: (_id: string) => undefined,
};

// Expose the class shape that extension.ts uses; tests replace it via ActivateDeps.
export class Uri {
  static file(p: string): Uri {
    return new Uri(p);
  }
  constructor(public fsPath: string) {}
}
