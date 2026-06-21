import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'lib/**', 'dist/**'] },
  js.configs.recommended,
  prettierConfig,
  // Base config for all JS/TS files
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        app: 'writable',
      },
    },
    rules: {
      // Allow single-underscore catch params — they signal "intentionally ignored"
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-extra-boolean-cast': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  // TypeScript-specific config (only for .ts files)
  {
    files: ['src/**/*.ts'],
    ...tseslint.configs.recommended[0],
    languageOptions: {
      ...tseslint.configs.recommended[0].languageOptions,
      globals: { ...globals.browser },
    },
    rules: {
      ...tseslint.configs.recommended[0].rules,
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'off',
      // Disable base JS rules that conflict with TS
      'no-unused-vars': 'off',
      'no-unused-expressions': 'off',
    },
  },
];
