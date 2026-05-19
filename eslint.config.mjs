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
);
