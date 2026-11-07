import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { piManifestPath } from "../../pi-packages.mjs";
import { assertPresent } from "../assertions.js";
import { spawnNode } from "./spawn-node.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const REGISTER_LOADER = pathToFileURL(resolve(ROOT, "register-loader.mjs")).href;
const ENTRY = fileURLToPath(new URL("./fixtures/register-loader-entry.mjs", import.meta.url));

test("register-loader resolves test-loader relative to itself instead of cwd", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-"));

	try {
		const result = spawnNode([ENTRY], { cwd, loader: REGISTER_LOADER });

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toMatch(/ok/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("register-loader errors when entry file does not exist", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-fail-"));
	try {
		const result = spawnNode(["/nonexistent/entry.mjs"], { cwd, loader: REGISTER_LOADER });

		expect(result.status, "should exit non-zero for missing entry").not.toBe(0);
		// Node.js always includes the path in ENOENT errors, so checking for "nonexistent" is sufficient
		expect(result.stderr, "stderr should reference the missing file, got: " + result.stderr).toContain("nonexistent");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("register-loader resolves typebox exports from pi's dependency tree", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-typebox-"));
	try {
		const result = spawnNode(
			[
				"--input-type=module",
				"-e",
				[
					'const specifiers = ["typebox", "typebox/compile", "typebox/value"];',
					"const mods = await Promise.all(specifiers.map((specifier) => import(specifier)));",
					'if (typeof mods[0].Type.String !== "function") process.exit(1);',
					"console.log(JSON.stringify(Object.fromEntries(specifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]))));",
				].join("\n"),
			],
			{ cwd, loader: REGISTER_LOADER },
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		const resolved = JSON.parse(result.stdout.trim()) as Record<string, string>;
		const [rootSpecifier, ...subpathSpecifiers] = Object.keys(resolved);
		const typeboxRoot = resolved[rootSpecifier].replace(/(?:build\/)?index\.m?js$/, "");
		expect(typeboxRoot).toMatch(/^file:/);
		// The copy pi itself loads, not the project's top-level one, which can be another version.
		const piTypeboxManifest = findPackageJSON("typebox", pathToFileURL(piManifestPath));
		assertPresent(piTypeboxManifest, "pi's dependency tree should contain typebox");
		// Node's resolver returns real paths, so compare against the real path of pi's copy.
		expect(typeboxRoot, "typebox should resolve from pi's dependency tree").toBe(
			pathToFileURL(realpathSync(dirname(piTypeboxManifest))).href + "/",
		);
		for (const specifier of Object.keys(resolved)) {
			expect(resolved[specifier]).toMatch(/^file:/);
			expect(
				resolved[specifier].startsWith(typeboxRoot),
				`${specifier} should resolve from the same typebox package root`,
			).toBe(true);
		}
		expect(subpathSpecifiers.length).toBeGreaterThan(0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("register-loader leaves an unknown typebox subpath to Node's export check", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-typebox-missing-"));
	try {
		const result = spawnNode(
			[
				"--input-type=module",
				"-e",
				'await import("typebox/not-real");',
			],
			{ cwd, loader: REGISTER_LOADER },
		);

		expect(result.status, "should exit non-zero for missing typebox export").not.toBe(0);
		expect(result.stderr).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
		expect(result.stderr).toMatch(/Package subpath '\.\/not-real' is not defined by "exports" in .*typebox[\\/]package\.json/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
