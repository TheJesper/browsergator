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
  },
  {
    // The end-to-end and browser checks are CommonJS so they can `require` a globally installed Playwright,
    // and they pass functions into the page, where `document` and `navigator` exist.
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        getComputedStyle: 'readonly',
        HTMLElement: 'readonly'
      }
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
