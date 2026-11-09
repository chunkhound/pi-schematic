import { readFileSync } from "node:fs";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import n from "eslint-plugin-n";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import globals from "globals";

const nodeFloor = readFileSync(new URL(".node-version", import.meta.url), "utf8").trim();
if (nodeFloor === "") {
	throw new Error(".node-version is empty; it must hold the Node.js floor.");
}

// Every rule is listed explicitly and none is switched off. A rule joins this list only once the
// whole repository passes it.

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
		for (const name of ["node:test", "node:assert", "node:assert/strict"]) {
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
	{
		selector: "ImportExpression[source.type='TemplateLiteral']:has(CallExpression[callee.object.name='Date'][callee.property.name='now'])",
		message: "Do not bust the module cache with Date.now() in import().",
	},
];

export default defineConfig([
	{ ignores: ["node_modules/**", ".claude/**", "coverage/**", "dist/**"] },
	{ linterOptions: { reportUnusedDisableDirectives: "error" } },
	{
		files: ["**/*.ts", "**/*.mjs", "**/*.js"],
		plugins: { "import-x": importX, n, ...comments.recommended.plugins },
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
			"no-unsafe-optional-chaining": "error",
			"no-unused-labels": "error",
			"no-unused-private-class-members": "error",
			"no-useless-assignment": "error",
			"no-useless-backreference": "error",
			"no-useless-catch": "error",
			"no-useless-escape": "error",
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
			"n/no-extraneous-import": "error",
			"n/no-missing-import": "error",

			"import-x/no-cycle": "error",

			"no-restricted-imports": restrictedImports({}),
			"no-restricted-syntax": ["error", URL_PATHNAME],
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
		},
	},
	{
		// Files outside the tsconfig are linted without type information.
		files: ["**/*.mjs", "**/*.js"],
		extends: [tseslint.configs.disableTypeChecked],
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
			"@typescript-eslint/no-confusing-non-null-assertion": "error",
			"@typescript-eslint/no-deprecated": "error",
			"@typescript-eslint/no-duplicate-enum-values": "error",
			"@typescript-eslint/no-duplicate-type-constituents": "error",
			"@typescript-eslint/no-empty-object-type": "error",
			"@typescript-eslint/no-extra-non-null-assertion": "error",
			"@typescript-eslint/no-extraneous-class": "error",
			"@typescript-eslint/no-for-in-array": "error",
			"@typescript-eslint/no-generated-empty-object-type": "error",
			"@typescript-eslint/no-implied-eval": "error",
			"@typescript-eslint/no-inferrable-types": "error",
			"@typescript-eslint/no-meaningless-void-operator": "error",
			"@typescript-eslint/no-misused-new": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/no-mixed-enums": "error",
			"@typescript-eslint/no-namespace": "error",
			"@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
			"@typescript-eslint/no-non-null-asserted-optional-chain": "error",
			"@typescript-eslint/no-redundant-type-constituents": "error",
			"@typescript-eslint/no-require-imports": "error",
			"@typescript-eslint/no-this-alias": "error",
			"@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
			"@typescript-eslint/no-unnecessary-template-expression": "error",
			"@typescript-eslint/no-unnecessary-type-arguments": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/no-unnecessary-type-constraint": "error",
			"@typescript-eslint/no-unnecessary-type-parameters": "error",
			"@typescript-eslint/no-unsafe-declaration-merging": "error",
			"@typescript-eslint/no-unsafe-enum-assignment": "error",
			"@typescript-eslint/no-unsafe-enum-comparison": "error",
			"@typescript-eslint/no-unsafe-function-type": "error",
			"@typescript-eslint/no-unsafe-unary-minus": "error",
			"@typescript-eslint/no-useless-constructor": "error",
			"@typescript-eslint/no-useless-default-assignment": "error",
			"@typescript-eslint/no-wrapper-object-types": "error",
			"@typescript-eslint/non-nullable-type-assertion-style": "error",
			"@typescript-eslint/prefer-as-const": "error",
			"@typescript-eslint/prefer-find": "error",
			"@typescript-eslint/prefer-for-of": "error",
			"@typescript-eslint/prefer-function-type": "error",
			"@typescript-eslint/prefer-includes": "error",
			"@typescript-eslint/prefer-literal-enum-member": "error",
			"@typescript-eslint/prefer-namespace-keyword": "error",
			"@typescript-eslint/prefer-reduce-type-parameter": "error",
			"@typescript-eslint/prefer-regexp-exec": "error",
			"@typescript-eslint/prefer-return-this-type": "error",
			"@typescript-eslint/prefer-string-starts-ends-with": "error",
			"@typescript-eslint/related-getter-setter-pairs": "error",
			"@typescript-eslint/triple-slash-reference": "error",
			"@typescript-eslint/unified-signatures": "error",
			"no-var": "error",
			// An onTestFinished or cleanup closure may read a variable before its first assignment.
			"prefer-const": ["error", { ignoreReadBeforeAssign: true }],
			"prefer-rest-params": "error",
			"prefer-spread": "error",

			"@typescript-eslint/no-import-type-side-effects": "error",
			"@typescript-eslint/prefer-readonly": "error",
		},
	},
	{
		...PRODUCTION,
		rules: {
			"no-restricted-imports": restrictedImports({ production: true }),
			"no-restricted-syntax": ["error", ...PRODUCTION_SYNTAX],
		},
	},
	{
		files: ["tests/**"],
		ignores: [SPAWN_NODE],
		rules: {
			"no-restricted-imports": restrictedImports({ tests: true }),
			"no-restricted-syntax": ["error", ...TEST_SYNTAX],
		},
	},
	{
		files: [SPAWN_NODE],
		rules: { "no-restricted-syntax": ["error", ...TEST_SYNTAX] },
	},
	{
		files: ["tests/**"],
		rules: {
			// Vitest fixtures must take an object destructuring pattern as their first parameter, so `async ({}, use) =>` is required.
			"no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
		},
	},
]);
