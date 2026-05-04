// ESLint flat config for the v13 TypeScript packages under `packages/*`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

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
);
