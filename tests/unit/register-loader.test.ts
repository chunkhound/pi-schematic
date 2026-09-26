import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const REGISTER_LOADER = pathToFileURL(resolve(ROOT, "register-loader.mjs")).href;
const ENTRY = fileURLToPath(new URL("./fixtures/register-loader-entry.mjs", import.meta.url));

test("register-loader resolves test-loader relative to itself instead of cwd", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-"));

	try {
		const result = spawnSync(
			process.execPath,
			["--import", REGISTER_LOADER, ENTRY],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
			},
		);

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /ok/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("register-loader errors when entry file does not exist", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-fail-"));
	try {
		const result = spawnSync(
			process.execPath,
			["--import", REGISTER_LOADER, "/nonexistent/entry.mjs"],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
			},
		);

		assert.notEqual(result.status, 0, "should exit non-zero for missing entry");
		// Node.js always includes the path in ENOENT errors, so checking for "nonexistent" is sufficient
		assert.ok(
			result.stderr.includes("nonexistent"),
			"stderr should reference the missing file, got: " + result.stderr,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("register-loader resolves typebox exports from the project dependency tree", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-typebox-"));
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				REGISTER_LOADER,
				"--input-type=module",
				"-e",
				[
					'const specifiers = ["typebox", "typebox/compile", "typebox/value"];',
					"const mods = await Promise.all(specifiers.map((specifier) => import(specifier)));",
					'if (typeof mods[0].Type.String !== "function") process.exit(1);',
					"console.log(JSON.stringify(Object.fromEntries(specifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]))));",
				].join("\n"),
			],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
			},
		);

		assert.equal(result.status, 0, result.stderr || result.stdout);
		const resolved = JSON.parse(result.stdout.trim()) as Record<string, string>;
		const [rootSpecifier, ...subpathSpecifiers] = Object.keys(resolved);
		const typeboxRoot = resolved[rootSpecifier].replace(/(?:build\/)?index\.m?js$/, "");
		assert.match(typeboxRoot, /^file:/);
		for (const specifier of Object.keys(resolved)) {
			assert.match(resolved[specifier], /^file:/);
			assert.ok(
				resolved[specifier].startsWith(typeboxRoot),
				`${specifier} should resolve from the same typebox package root`,
			);
		}
		assert.ok(subpathSpecifiers.length > 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("register-loader surfaces a clear error for missing typebox exports", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-schematic-loader-typebox-missing-"));
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				REGISTER_LOADER,
				"--input-type=module",
				"-e",
				'await import("typebox/not-real");',
			],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
			},
		);

		assert.notEqual(result.status, 0, "should exit non-zero for missing typebox export");
		assert.match(result.stderr, /Cannot find typebox\/not-real export/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
