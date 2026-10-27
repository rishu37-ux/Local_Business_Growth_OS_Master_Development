import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import lbgos from './tooling/eslint/index.js';

const repoRoot = import.meta.dirname;

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'spikes/**', 'docs/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: repoRoot },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    plugins: { lbgos },
    rules: { 'lbgos/module-boundaries': ['error', { repoRoot }] },
  },
  prettier,
);
