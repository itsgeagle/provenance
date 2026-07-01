import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['**/*.ts', '**/*.tsx'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['packages/log-core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'vscode',
            'node:fs',
            'node:path',
            'node:worker_threads',
            'node:crypto',
            'fs',
            'path',
            'worker_threads',
            'crypto',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/analyzer/src/**/*.ts', 'packages/analyzer/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'node:fs',
            'node:path',
            'node:worker_threads',
            'node:crypto',
            'fs',
            'path',
            'worker_threads',
            'crypto',
          ],
        },
      ],
    },
  },
  {
    // analysis-core is the shared analysis engine consumed by BOTH the browser
    // analyzer and the Node server. It must stay isomorphic: no vscode, no
    // Node-only APIs. (DOM globals like Blob/ArrayBuffer are fine — they exist
    // in both runtimes.)
    files: ['packages/analysis-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'vscode',
            'node:fs',
            'node:path',
            'node:worker_threads',
            'node:crypto',
            'fs',
            'path',
            'worker_threads',
            'crypto',
          ],
        },
      ],
    },
  },
  {
    // The server is a Node process — forbid vscode and DOM-related imports.
    // vscode is a VS Code extension API and has no meaning in a server context.
    // DOM globals (document, window, etc.) are not available in Node; importing
    // DOM-only libs here would silently break at runtime.
    files: ['packages/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'vscode',
            // DOM-only libraries (not exhaustive; add as encountered)
            'jsdom',
            'canvas',
          ],
        },
      ],
    },
  },
);
