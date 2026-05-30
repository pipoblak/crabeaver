import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    // Build output, deps, generated, and Rust trees are not linted.
    ignores: ['dist', 'node_modules', 'src-tauri', 'target', '.claude'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // The two classic, industry-standard hooks rules. We intentionally do NOT
      // adopt the full react-hooks v7 "purity/refs/setState" rule set: it errors
      // on many legitimate existing patterns (refs read during render, bootstrap
      // setState-in-effect). Those can be paid down later behind a warn gate.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Allow intentional unused via leading underscore; report the rest.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `cond && fn()` / `cond ? a() : b()` as statements are idiomatic here.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      // `any` appears on Tauri invoke glue; surface as warning, not a blocker.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Vitest globals for test + setup files.
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    languageOptions: {
      globals: { ...globals.node, vi: 'readonly', describe: 'readonly', it: 'readonly', expect: 'readonly', beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly' },
    },
  },
)
