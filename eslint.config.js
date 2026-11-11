import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'work/**',
      'dist/**',
      'coverage/**',
      '.beads/**',
      '.agents/**',
      '.cad/**',
      '.idea/**',
      'stop-running.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['web/**/*.{js,ts}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['test/**/*.{js,mjs,ts}'],
    rules: { 'require-yield': 'off' },
  },
  {
    files: ['test/viewport-scroll.{mjs,ts}'],
    languageOptions: { globals: globals.browser },
  },
];
