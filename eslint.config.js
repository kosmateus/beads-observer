import js from '@eslint/js';
import globals from 'globals';

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
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  { files: ['web/**/*.js'], languageOptions: { globals: globals.browser } },
  {
    files: ['test/**/*.js', 'test/**/*.mjs'],
    rules: { 'require-yield': 'off' },
  },
  {
    files: ['test/viewport-scroll.mjs'],
    languageOptions: { globals: globals.browser },
  },
];
