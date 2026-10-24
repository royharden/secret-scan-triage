// ESLint flat config. Verified at activation (no install in Dirty Mode).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Only src/core/mask/** may import unsafeMarkSafe (the unchecked SafeText brand). Expressed as no-restricted-syntax
// so it matches regardless of the relative import path; safe.ts itself defines it.
const UNSAFE_MARK_RULE = [
  'error',
  {
    selector: "ImportSpecifier[imported.name='unsafeMarkSafe']",
    message: 'unsafeMarkSafe may only be imported in src/core/mask/**. Use guardedSafeText (mask/leakGuard.ts) instead.',
  },
  {
    selector: "ExportSpecifier[local.name='unsafeMarkSafe']",
    message: 'Do not re-export unsafeMarkSafe outside src/core/safe.ts.',
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'fixtures/generated/**', 'results/raw/**', 'creddata/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': UNSAFE_MARK_RULE,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The pure core must not touch Node or the DOM.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*', 'fs', 'path', 'os', 'child_process', 'react', 'react-dom'], message: 'src/core is pure TS: no Node or DOM APIs.' }] },
      ],
    },
  },
  {
    // mask/ owns the SafeText brand (incl. safeBasename for judge views); safe.ts defines it. No other src file is
    // exempt: modules outside mask/ use guardedSafeText (mask/leakGuard.ts) or a mask/ helper.
    files: ['src/core/mask/**/*.ts', 'src/core/safe.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Tests build SafeText fixtures directly; test code never runs at an outbound boundary of the shipped app.
    files: ['tests/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
