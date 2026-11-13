import { readFileSync } from "node:fs";
import { defineConfig } from "eslint/config";
import { builtinRules } from "eslint/use-at-your-own-risk";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import n from "eslint-plugin-n";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import globals from "globals";
import vitest from "@vitest/eslint-plugin";

const nodeFloor = readFileSync(new URL(".node-version", import.meta.url), "utf8").trim();
if (nodeFloor === "") {
	throw new Error(".node-version is empty; it must hold the Node.js floor.");
}

// Every rule is listed explicitly and none is switched off. When a rule joins the list, the
// violations the repository already had are recorded in eslint-suppressions.json as a count per
// file and rule. Lint fails when a file exceeds its recorded count for a rule, and then reports
// every violation of that rule in that file. Lint also fails, with exit code 2, while a recorded
// count is higher than the actual one, until `npx eslint . --prune-suppressions` lowers it.

// Production code is every TypeScript file outside tests/ and scripts/, except the Vitest config.
const PRODUCTION = { files: ["**/*.ts"], ignores: ["tests/**", "scripts/**", "vitest.config.ts"] };
const SPAWN_NODE = "tests/unit/spawn-node.ts";

// no-restricted-imports and no-restricted-syntax replace their options in each matching block, so
// every block below carries the full set for its file class.
const restrictedImports = ({ production = false, tests = false }) => {
	const paths = ["node:child_process", "child_process"].map((name) => ({
		name,
		importNames: ["exec"],
		message: "exec is not allowed.",
	}));
	if (tests) {
		for (const name of ["node:test", "node:assert", "assert", "node:assert/strict", "assert/strict"]) {
			paths.push({ name, message: "Tests use vitest, not node:test or node:assert." });
		}
	}
	const patterns = [{ group: ["@earendil-works/*/dist/**", "**/dist/**"], message: "Do not import pi dist internals." }];
	if (production) {
		patterns.push({ group: ["**/tests/**", "tests/**"], message: "Production code must not import from tests/." });
	}
	return ["error", { paths, patterns }];
};

const URL_PATHNAME = {
	selector: "MemberExpression[property.name='pathname'] > NewExpression[callee.name='URL']",
	message: "Use fileURLToPath instead of new URL(...).pathname.",
};
const PRODUCTION_SYNTAX = [
	URL_PATHNAME,
	{ selector: "Literal[value=/(^|[\\\\/])\\.pi([\\\\/]|$)/]", message: "Do not hard-code a .pi path segment in production code." },
	{ selector: "TemplateElement[value.cooked=/(^|[\\\\/])\\.pi([\\\\/]|$)/]", message: "Do not hard-code a .pi path segment in production code." },
	{
		selector: "CallExpression > MemberExpression.callee[property.name='write'][object.object.name='process'][object.property.name=/^(stdout|stderr)$/]",
		message: "Writing to process.stdout or process.stderr corrupts pi's TUI.",
	},
];
const TEST_SYNTAX = [
	URL_PATHNAME,
];

// A ban that had violations when it landed is a core rule registered under its own ID, because
// eslint-suppressions.json keeps one count per file and rule: bans sharing no-restricted-imports or
// no-restricted-syntax would share a count, and a new violation of one could hide behind a fixed
// violation of another. Bans without violations stay in the core rules.
const coreRule = (name) => {
	const rule = builtinRules.get(name);
	if (rule === undefined) {
		throw new Error(`ESLint has no core rule named ${name}.`);
	}
	return rule;
};
const RESTRICTED_IMPORTS = coreRule("no-restricted-imports");
const RESTRICTED_SYNTAX = coreRule("no-restricted-syntax");
const ban = {
	rules: {
		"exec-sync-import": RESTRICTED_IMPORTS,
		"spawn-sync-import": RESTRICTED_IMPORTS,
		"set-singletons-import": RESTRICTED_IMPORTS,
		"find-package-json-import": RESTRICTED_IMPORTS,
		"wall-clock": RESTRICTED_SYNTAX,
		"console-assignment": RESTRICTED_SYNTAX,
		"shell-option": RESTRICTED_SYNTAX,
		"module-level-set-singletons": RESTRICTED_SYNTAX,
		"zero-delay-timeout": RESTRICTED_SYNTAX,
	},
};
const CHILD_PROCESS_CALLS = "/^(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/";

export default defineConfig([
	{ ignores: ["node_modules/**", ".claude/**", "coverage/**", "dist/**"] },
	{ linterOptions: { reportUnusedDisableDirectives: "error" } },
	{
		files: ["**/*.ts", "**/*.mjs", "**/*.js"],
		plugins: { "import-x": importX, n, ban, ...comments.recommended.plugins },
		settings: {
			...importX.flatConfigs.typescript.settings,
			"import-x/resolver-next": [createTypeScriptImportResolver({ project: "./tsconfig.json" })],
			n: { version: `>=${nodeFloor}`, resolverConfig: { extensionAlias: { ".js": [".ts", ".js"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] } } },
		},
		rules: {
			// @eslint/js recommended
			"for-direction": "error",
			"no-async-promise-executor": "error",
			"no-case-declarations": "error",
			"no-compare-neg-zero": "error",
			"no-cond-assign": "error",
			"no-constant-binary-expression": "error",
			"no-constant-condition": "error",
			"no-control-regex": "error",
			"no-debugger": "error",
			"no-delete-var": "error",
			"no-dupe-else-if": "error",
			"no-duplicate-case": "error",
			"no-empty": "error",
			"no-empty-character-class": "error",
			"no-empty-pattern": "error",
			"no-empty-static-block": "error",
			"no-ex-assign": "error",
			"no-extra-boolean-cast": "error",
			"no-fallthrough": "error",
			"no-global-assign": "error",
			"no-invalid-regexp": "error",
			"no-irregular-whitespace": "error",
			"no-loss-of-precision": "error",
			"no-misleading-character-class": "error",
			"no-nonoctal-decimal-escape": "error",
			"no-octal": "error",
			"no-prototype-builtins": "error",
			"no-regex-spaces": "error",
			"no-self-assign": "error",
			"no-shadow-restricted-names": "error",
			"no-sparse-arrays": "error",
			"no-unassigned-vars": "error",
			"no-unexpected-multiline": "error",
			"no-unsafe-finally": "error",
			"no-unsafe-optional-chaining": "error",
			"no-unused-labels": "error",
			"no-unused-private-class-members": "error",
			"no-useless-assignment": "error",
			"no-useless-backreference": "error",
			"no-useless-catch": "error",
			"no-useless-escape": "error",
			"preserve-caught-error": "error",
			"require-yield": "error",
			"use-isnan": "error",
			"valid-typeof": "error",

			curly: ["error", "all"],
			eqeqeq: "error",
			"no-param-reassign": "error",
			// "max-lines-per-function": ["error", { max: 20 }], // deferred: no agreed function length limit yet

			// eslint-comments recommended
			"@eslint-community/eslint-comments/disable-enable-pair": "error",
			"@eslint-community/eslint-comments/no-aggregating-enable": "error",
			"@eslint-community/eslint-comments/no-duplicate-disable": "error",
			"@eslint-community/eslint-comments/no-unlimited-disable": "error",
			"@eslint-community/eslint-comments/no-unused-enable": "error",
			"@eslint-community/eslint-comments/require-description": "error",

			// The supported Node.js range comes from .node-version, the Node floor that Renovate keeps on
			// pi's floor; package.json has no engines field.
			"n/no-unsupported-features/es-syntax": "error",
			"n/no-unsupported-features/node-builtins": "error",
			"n/no-extraneous-import": "error",
			"n/no-missing-import": "error",

			"import-x/no-cycle": "error",
			"import-x/no-mutable-exports": "error",

			"no-restricted-imports": restrictedImports({}),
			"no-restricted-syntax": ["error", URL_PATHNAME],
			"ban/exec-sync-import": [
				"error",
				...["node:child_process", "child_process"].map((name) => ({
					name,
					importNames: ["execSync"],
					message: "execSync is not allowed.",
				})),
			],
		},
	},
	{
		files: ["**/*.ts", "**/*.mjs", "**/*.js"],
		ignores: ["pi-packages.mjs"],
		rules: {
			"no-restricted-properties": [
				"error",
				{ object: "module", property: "findPackageJSON", message: "Only pi-packages.mjs locates package manifests." },
			],
			"ban/find-package-json-import": [
				"error",
				...["node:module", "module"].map((name) => ({
					name,
					importNames: ["findPackageJSON"],
					message: "Only pi-packages.mjs locates package manifests.",
				})),
			],
		},
	},
	{
		files: ["**/*.ts", "**/*.mjs", "**/*.js"],
		ignores: ["tests/**", "spawn/renderer.ts"],
		rules: {
			"ban/set-singletons-import": [
				"error",
				{
					patterns: [
						{
							group: ["**/runtime-singletons*"],
							importNames: ["__setSingletons"],
							message: "Only spawn/renderer.ts and tests replace the runtime singletons.",
						},
					],
				},
			],
		},
	},
	{
		// Files outside the tsconfig are linted without type information.
		files: ["**/*.mjs", "**/*.js"],
		languageOptions: { globals: globals.node },
		rules: {
			// @eslint/js recommended rules that typescript-eslint leaves to the compiler in TypeScript files
			"constructor-super": "error",
			"getter-return": "error",
			"no-class-assign": "error",
			"no-const-assign": "error",
			"no-dupe-args": "error",
			"no-dupe-class-members": "error",
			"no-dupe-keys": "error",
			"no-func-assign": "error",
			"no-import-assign": "error",
			"no-new-native-nonconstructor": "error",
			"no-obj-calls": "error",
			"no-redeclare": "error",
			"no-setter-return": "error",
			"no-this-before-super": "error",
			"no-undef": "error",
			"no-unreachable": "error",
			"no-unsafe-negation": "error",
			"no-unused-vars": "error",
			"no-with": "error",
		},
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		plugins: { "@typescript-eslint": tseslint.plugin },
		rules: {
			// typescript-eslint strict-type-checked and stylistic-type-checked
			"@typescript-eslint/adjacent-overload-signatures": "error",
			"@typescript-eslint/array-type": "error",
			"@typescript-eslint/await-thenable": "error",
			"@typescript-eslint/ban-ts-comment": ["error", { minimumDescriptionLength: 10 }],
			"@typescript-eslint/ban-tslint-comment": "error",
			"@typescript-eslint/class-literal-property-style": "error",
			"@typescript-eslint/consistent-generic-constructors": "error",
			"@typescript-eslint/consistent-indexed-object-style": "error",
			"@typescript-eslint/consistent-type-assertions": "error",
			"@typescript-eslint/consistent-type-definitions": "error",
			"@typescript-eslint/dot-notation": "error",
			"@typescript-eslint/no-array-constructor": "error",
			"@typescript-eslint/no-array-delete": "error",
			"@typescript-eslint/no-base-to-string": "error",
			"@typescript-eslint/no-confusing-non-null-assertion": "error",
			"@typescript-eslint/no-confusing-void-expression": "error",
			"@typescript-eslint/no-deprecated": "error",
			"@typescript-eslint/no-duplicate-enum-values": "error",
			"@typescript-eslint/no-duplicate-type-constituents": "error",
			"@typescript-eslint/no-dynamic-delete": "error",
			"@typescript-eslint/no-empty-function": "error",
			"@typescript-eslint/no-empty-object-type": "error",
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-extra-non-null-assertion": "error",
			"@typescript-eslint/no-extraneous-class": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-for-in-array": "error",
			"@typescript-eslint/no-generated-empty-object-type": "error",
			"@typescript-eslint/no-implied-eval": "error",
			"@typescript-eslint/no-inferrable-types": "error",
			"@typescript-eslint/no-invalid-void-type": "error",
			"@typescript-eslint/no-meaningless-void-operator": "error",
			"@typescript-eslint/no-misused-new": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/no-misused-spread": "error",
			"@typescript-eslint/no-mixed-enums": "error",
			"@typescript-eslint/no-namespace": "error",
			"@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
			"@typescript-eslint/no-non-null-asserted-optional-chain": "error",
			"@typescript-eslint/no-non-null-assertion": "error",
			"@typescript-eslint/no-redundant-type-constituents": "error",
			"@typescript-eslint/no-require-imports": "error",
			"@typescript-eslint/no-this-alias": "error",
			"@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",
			"@typescript-eslint/no-unnecessary-template-expression": "error",
			"@typescript-eslint/no-unnecessary-type-arguments": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/no-unnecessary-type-constraint": "error",
			"@typescript-eslint/no-unnecessary-type-conversion": "error",
			"@typescript-eslint/no-unnecessary-type-parameters": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-declaration-merging": "error",
			"@typescript-eslint/no-unsafe-enum-assignment": "error",
			"@typescript-eslint/no-unsafe-enum-comparison": "error",
			"@typescript-eslint/no-unsafe-function-type": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unsafe-unary-minus": "error",
			"@typescript-eslint/no-unused-expressions": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
			"@typescript-eslint/no-useless-constructor": "error",
			"@typescript-eslint/no-useless-default-assignment": "error",
			"@typescript-eslint/no-wrapper-object-types": "error",
			"@typescript-eslint/non-nullable-type-assertion-style": "error",
			"@typescript-eslint/only-throw-error": "error",
			"@typescript-eslint/prefer-as-const": "error",
			"@typescript-eslint/prefer-find": "error",
			"@typescript-eslint/prefer-for-of": "error",
			"@typescript-eslint/prefer-function-type": "error",
			"@typescript-eslint/prefer-includes": "error",
			"@typescript-eslint/prefer-literal-enum-member": "error",
			"@typescript-eslint/prefer-namespace-keyword": "error",
			"@typescript-eslint/prefer-nullish-coalescing": "error",
			"@typescript-eslint/prefer-optional-chain": "error",
			"@typescript-eslint/prefer-promise-reject-errors": "error",
			"@typescript-eslint/prefer-reduce-type-parameter": "error",
			"@typescript-eslint/prefer-regexp-exec": "error",
			"@typescript-eslint/prefer-return-this-type": "error",
			"@typescript-eslint/prefer-string-starts-ends-with": "error",
			"@typescript-eslint/related-getter-setter-pairs": "error",
			"@typescript-eslint/require-await": "error",
			"@typescript-eslint/restrict-plus-operands": [
				"error",
				{ allowAny: false, allowBoolean: false, allowNullish: false, allowNumberAndString: false, allowRegExp: false },
			],
			// Numbers interpolate the same with or without String(); objects, nullish and unknown values still fail.
			"@typescript-eslint/restrict-template-expressions": [
				"error",
				{ allowAny: false, allowBoolean: false, allowNever: false, allowNullish: false, allowNumber: true, allowRegExp: false },
			],
			"@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
			"@typescript-eslint/triple-slash-reference": "error",
			"@typescript-eslint/unbound-method": "error",
			"@typescript-eslint/unified-signatures": "error",
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
			"no-var": "error",
			// An onTestFinished or cleanup closure may read a variable before its first assignment.
			"prefer-const": ["error", { ignoreReadBeforeAssign: true }],
			"prefer-rest-params": "error",
			"prefer-spread": "error",

			"@typescript-eslint/no-import-type-side-effects": "error",
			"@typescript-eslint/prefer-readonly": "error",
			"@typescript-eslint/no-unsafe-type-assertion": "error",
			"@typescript-eslint/strict-boolean-expressions": "error",
			"@typescript-eslint/switch-exhaustiveness-check": "error",
		},
	},
	{
		...PRODUCTION,
		rules: {
			"no-console": "error",
			"no-restricted-imports": restrictedImports({ production: true }),
			"no-restricted-syntax": ["error", ...PRODUCTION_SYNTAX],
			"ban/shell-option": [
				"error",
				{
					selector: `CallExpression:matches([callee.name=${CHILD_PROCESS_CALLS}], [callee.type='MemberExpression'][callee.computed=false][callee.property.name=${CHILD_PROCESS_CALLS}], [callee.type='MemberExpression'][callee.computed=true][callee.property.value=${CHILD_PROCESS_CALLS}]) > ObjectExpression.arguments > Property:matches([computed=false][key.name='shell'], [key.value='shell'])[value.value=true]`,
					message: "Do not spawn through a shell.",
				},
			],
			"ban/module-level-set-singletons": [
				"error",
				{
					selector: "CallExpression[callee.name='__setSingletons']:not(:function CallExpression)",
					message: "Do not replace the runtime singletons at module level.",
				},
			],
		},
	},
	{
		files: ["tests/**"],
		ignores: [SPAWN_NODE],
		rules: {
			"no-restricted-imports": restrictedImports({ tests: true }),
			"no-restricted-syntax": ["error", ...TEST_SYNTAX],
			"ban/spawn-sync-import": [
				"error",
				...["node:child_process", "child_process"].map((name) => ({
					name,
					importNames: ["spawnSync"],
					message: "spawnSync is not allowed in tests; use it only in tests/unit/spawn-node.ts.",
				})),
			],
		},
	},
	{
		files: [SPAWN_NODE],
		rules: {
			"no-restricted-imports": restrictedImports({ tests: true }),
			"no-restricted-syntax": ["error", ...TEST_SYNTAX],
		},
	},
	{
		files: ["tests/**/*.ts"],
		plugins: { vitest },
		rules: {
			// @vitest/eslint-plugin recommended
			"vitest/expect-expect": "error",
			"vitest/no-commented-out-tests": "error",
			"vitest/no-conditional-expect": "error",
			// An error, not the preset's warn: lint exits 0 on warnings, so a disabled test would pass unnoticed.
			"vitest/no-disabled-tests": "error",
			"vitest/no-focused-tests": "error",
			"vitest/no-identical-title": "error",
			"vitest/no-import-node-test": "error",
			"vitest/no-interpolation-in-snapshots": "error",
			"vitest/no-mocks-import": "error",
			"vitest/no-standalone-expect": "error",
			"vitest/no-unneeded-async-expect-function": "error",
			"vitest/prefer-called-exactly-once-with": "error",
			"vitest/require-local-test-context-for-concurrent-snapshots": "error",
			"vitest/valid-describe-callback": "error",
			// The suite passes a failure message as the second argument: expect(value, message).
			"vitest/valid-expect": ["error", { maxArgs: 2 }],
			"vitest/valid-expect-in-promise": "error",
			"vitest/valid-title": "error",

			"vitest/max-expects": "error",
			"vitest/no-conditional-in-test": "error",
			"vitest/no-conditional-tests": "error",
			"vitest/no-restricted-vi-methods": ["error", { mock: "vi.mock is not allowed.", doMock: "vi.doMock is not allowed." }],
			"vitest/prefer-strict-boolean-matchers": "error",
			"vitest/prefer-to-be": "error",
			"vitest/prefer-to-contain": "error",
		},
	},
	{
		files: ["tests/**"],
		rules: {
			// Vitest fixtures must take an object destructuring pattern as their first parameter, so `async ({}, use) =>` is required.
			"no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],

			"ban/zero-delay-timeout": [
				"error",
				{ selector: "CallExpression[callee.name='setTimeout'][arguments.1.value=0]", message: "Do not use setTimeout with a 0 delay in tests." },
			],
			"ban/wall-clock": [
				"error",
				{
					selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='Date']:matches([callee.computed=false][callee.property.name='now'], [callee.computed=true][callee.property.value='now'])",
					message: "Do not read the wall clock in tests.",
				},
				{ selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Do not read the wall clock in tests." },
			],
			"ban/console-assignment": [
				"error",
				{
					selector: "AssignmentExpression[left.type='MemberExpression'][left.object.name='console']",
					message: "Do not replace console methods in tests.",
				},
			],
		},
	},
]);
