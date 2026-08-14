// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const eslintConfigPrettier = require('eslint-config-prettier/flat');

module.exports = tseslint.config(
  {
    // Build output + generated files. `.next/` and next-env.d.ts are emitted by
    // Next.js (the dashboard has its own `next lint`); linting them produces only
    // noise about generated code we don't own.
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Root tooling configs are CommonJS (no `"type": "module"` in the root
    // package.json), unlike everything else in the workspace.
    files: ['eslint.config.js', 'prettier.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // Must stay LAST — it only turns rules off. Prettier owns formatting, ESLint
  // owns code quality, and this guarantees the two can never disagree about the
  // same line. The overlap today is small — `js.configs.recommended` contributes
  // exactly one conflicting rule (`no-unexpected-multiline`) and the
  // typescript-eslint presets contribute none — but keeping this wired means the
  // guarantee holds if either preset adds formatting rules later.
  eslintConfigPrettier,
);
