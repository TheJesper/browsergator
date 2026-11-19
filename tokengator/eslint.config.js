import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly'
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.data/**', '.tmp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    // The core is shared by the server, the CLI and the browser bundle: it must stay free of
    // Node and DOM dependencies so the same waste math runs everywhere.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', '../server/*', '../cli/*', '../web/*'] }],
      'no-restricted-globals': ['error', 'window', 'document', 'process', 'localStorage']
    }
  },
  {
    // The browser bundle may use the core but never the server.
    files: ['src/web/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', '../server/*', '../cli/*', '../../server/*', '../../cli/*'] }]
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: nodeGlobals }
  }
);
