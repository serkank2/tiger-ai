// ---------------------------------------------------------------------------
// ESLint flat config for the Kaplan monorepo (ESM).
//
// Rule philosophy
// ---------------
// Lint is a CORRECTNESS net, not a style enforcer — formatting belongs to
// Prettier (wired in LAST via eslint-config-prettier so the two never fight).
//
//   * High-value correctness rules are ERRORS (no-undef-via-typescript,
//     no-fallthrough, etc. from the recommended presets).
//   * Opinionated / stylistic rules are OFF or WARN so they never block CI.
//   * We use typescript-eslint's NON-type-checked recommended preset: it needs
//     no `tsc` program, so `eslint .` stays fast and does not depend on the
//     project's tsconfig graph (important for the Nuxt virtual files).
//
// CI invariant: `npm run lint` MUST exit 0 (warnings allowed, zero errors).
// Where the existing ~25k-LOC codebase legitimately trips a default rule
// (e.g. deliberate `any` at CLI/PTY boundaries, intentional empty catches),
// the rule is downgraded to `warn` or `off` here rather than edited in source.
// ---------------------------------------------------------------------------

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // --- Ignores (flat-config replacement for .eslintignore) ----------------
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.output/**',
      '**/.nuxt/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/package-lock.json',
      'apps/frontend/.data/**',
      'apps/frontend/.nuxt/**',
    ],
  },

  // --- Base JS recommended -------------------------------------------------
  js.configs.recommended,

  // --- TypeScript (non-type-checked recommended) ---------------------------
  ...tseslint.configs.recommended,

  // --- Shared rule tuning for all TS/JS/Vue --------------------------------
  {
    rules: {
      // TypeScript (and Nuxt's auto-imports) already resolve identifiers; the
      // core `no-undef` rule produces only false positives here (it doesn't
      // understand types, ambient globals, or auto-imports). The TS compiler is
      // the source of truth for undefined references — disable it everywhere.
      'no-undef': 'off',

      // Stylistic / opinionated — leave to Prettier or just allow.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-constant-condition': ['error', { checkLoops: false }],

      // Pedantic correctness rules that the existing codebase trips
      // legitimately (escapes inside char-classes, deliberate control-char
      // stripping regexes, void-expression statements). Flag, don't fail.
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',

      // The CLI/PTY/DB layers deliberately deal in untyped boundaries; flag,
      // don't fail.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Allow `namespace`/`require` only where unavoidable; warn elsewhere.
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      // Non-null assertions are used pragmatically after invariant checks.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // --- Backend (Node + ESM) ------------------------------------------------
  {
    files: ['apps/backend/**/*.{ts,mts,cts,mjs,cjs,js}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },

  // --- Frontend Vue SFCs (vue3-recommended + TS in <script setup>) ---------
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['apps/frontend/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        // Parse <script lang="ts"> with the TS parser.
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: { ...globals.browser },
    },
    rules: {
      // Nuxt auto-imports + single-file Vue components: relax opinionated rules.
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      'vue/no-v-html': 'warn',
      // Some components mutate props deliberately (v-model-ish patterns on
      // object props); these are pre-existing and out of this change's scope.
      'vue/no-mutating-props': 'warn',
      'vue/attributes-order': 'warn',
      'vue/order-in-components': 'warn',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/max-attributes-per-line': 'off',
    },
  },

  // --- Frontend TS / composables / stores ----------------------------------
  {
    files: ['apps/frontend/**/*.{ts,mts,js,mjs}'],
    languageOptions: {
      globals: { ...globals.browser },
      sourceType: 'module',
    },
  },

  // --- Test files: looser still --------------------------------------------
  {
    files: ['**/*.test.{ts,mts,js,mjs}', '**/test/**/*.{ts,mts,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': 'off',
    },
  },

  // --- Prettier compatibility (MUST be last) -------------------------------
  prettier,
);
