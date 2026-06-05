// ESLint flat config for the v13 TypeScript packages under `packages/*`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import n from 'eslint-plugin-n';

export default tseslint.config(
	{
		// Ignore build outputs and node_modules. Lint scope is `packages/`,
		// applied via the per-config `files` matcher below.
		ignores: [
			'**/dist/**',
			'**/dist-test/**',
			'**/node_modules/**',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...tseslint.configs.stylistic,
	{
		files: ['packages/**/*.ts'],
		plugins: {
			'@stylistic': stylistic,
		},
		// Type-checked lint rules deliberately not enabled here. Type errors are
		// caught at build time via `tsc -b` (each package's `npm run build` /
		// `build:test`). Keeping ESLint type-info-free lets it run on every file
		// under `packages/` without per-package tsconfig.test.json wiring, and
		// keeps the lint surface focused on syntax / style / a few syntax-level
		// type-system choices. If we later want type-aware rules, we can opt-in
		// per-rule and add `parserOptions.project` then.
		rules: {
			// Style: tabs, single quotes, semicolons required, dangling commas in multi-line.
			'@stylistic/indent': ['error', 'tab', { SwitchCase: 1 }],
			'@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
			'@stylistic/semi': ['error', 'always'],
			'@stylistic/comma-dangle': ['error', 'always-multiline'],
			'@stylistic/no-extra-semi': 'error',

			// Allow `_`-prefixed unused args (test fixtures, port-shape stubs).
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],

			// Type-system usage choices we make deliberately.
			'@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
			'@typescript-eslint/consistent-type-definitions': ['error', 'interface'],

			// Allow empty methods — test fakes implement the driver-port `Connection`
			// surface with intentional no-op stubs for methods they don't exercise.
			'@typescript-eslint/no-empty-function': ['error', { allow: ['methods', 'asyncMethods'] }],
		},
	},
	{
		// Node engines-floor enforcement — SRC ONLY. The shipped code must run on
		// the lowest supported Node (`engines.node`, currently >=20.3.0), so a
		// runtime built-in newer than the floor is a bug for consumers. Tests run
		// on the dev / CI Node and aren't bound by the floor, so they're excluded.
		// `eslint-plugin-n` reads each package's `engines.node` and flags runtime
		// built-ins (global + `node:*`) introduced after it.
		//
		// MODERNIZE convention — when you reach for a runtime API newer than the
		// floor, either raise `engines.node`, or polyfill it behind a small module
		// and tag that polyfill with
		//   // MODERNIZE(node>=N): <drop this once the floor reaches N>
		// so a floor bump is a grep away from finding everything to delete (see
		// src/util/with-resolvers.ts). The grep target is the literal `MODERNIZE`.
		files: ['packages/**/src/**/*.ts'],
		plugins: { n },
		rules: {
			'n/no-unsupported-features/node-builtins': 'error',
			// `Symbol.asyncDispose` / `Symbol.dispose` (Node 20.4) sit one minor
			// above the floor, but TypeScript downlevels `using` / `await using`
			// with a runtime shim that defines them when absent — so they're safe
			// at 20.3. plugin-n doesn't track them today; if a release ever does,
			// add them to an `ignores: [...]` here (the shim keeps consumers safe).
			'n/no-unsupported-features/es-builtins': 'error',
		},
	},
);
