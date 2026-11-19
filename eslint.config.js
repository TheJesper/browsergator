import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // tokengator/ is a self-contained package with its own lint config and scripts.
  { ignores: ['dist/**', 'coverage/**', '.data/**', '.tmp/**', '**/*-profile/**', '.cache/**', 'tokengator/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // Plain Node ESM launcher scripts -- provide Node runtime globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
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
      }
    }
  }
);
