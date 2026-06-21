import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'eslint.config.mjs'] },
  js.configs.recommended,
  prettierConfig,
  // Base config for .ts files (bridge is fully TypeScript)
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'off',
      // intentional empty catches were audited in codereviewTODO.md — downgrade to warn
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Additional quality rules
      'no-var': 'warn',                         // prefer const/let over var
      'prefer-const': 'warn',                  // prefer const for never-reassigned variables
      'no-trailing-spaces': 'warn',            // no trailing whitespace
      'eol-last': ['warn', 'always'],          // files end with newline
      'no-multi-spaces': 'warn',               // no multiple consecutive spaces
      'no-useless-rename': 'warn',             // no redundant renaming
      'object-shorthand': 'warn',              // prefer {x} over {x:x}
      'prefer-object-spread': 'warn',          // prefer {...obj} over Object.assign
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // MCP servers still .js — keep using JS parser for them
  {
    files: ['mcp/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  // playwright-server.js runs inside a Playwright page context — browser globals are valid
  {
    files: ['mcp/playwright-server.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
];
