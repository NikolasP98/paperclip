/**
 * Paperclip Prettier config — mirrors @minion-stack/lint-config/prettier.config.js.
 *
 * Why this file inlines values instead of `require`-ing the shared config:
 * - @minion-stack/lint-config ships `prettier.config.js` with CJS `module.exports`
 * - That package is `type: "module"` — Node treats `.js` as ESM and errors on `module.exports`
 * - Paperclip is also `type: "module"`, so neither direct import nor require-shim works
 *
 * When @minion-stack/lint-config publishes a proper `prettier.config.cjs` (or a dual
 * CJS/ESM build), delete this file and set `"prettier": "@minion-stack/lint-config"`
 * in package.json.
 *
 * Tracked in: .planning/phases/03-adopt-foundation-in-subprojects/03-04-ISSUES.md
 * Upstream bug: @minion-stack/lint-config@0.1.0 prettier.config.js uses CJS in ESM package
 *
 * Values are a byte-for-byte copy of @minion-stack/lint-config@0.1.0/prettier.config.js
 * (verified 2026-04-20). Keep this file in sync when that package bumps.
 */
/** @type {import('prettier').Config} */
module.exports = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  quoteProps: 'as-needed',
  trailingComma: 'all',
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: 'always',
  endOfLine: 'lf',
  plugins: [],
};
