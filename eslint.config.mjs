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
);
