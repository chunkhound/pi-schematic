import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveRealPath } from "../../resolve-path.js";

const DEEP_PATH_PARTS = ["__pi_test_deep", "a", "b", "c"];

test("resolveRealPath: non-existent path inside temp dir preserves full path", () => {
	const tmp = os.tmpdir();
	const nonExistent = path.join(tmp, ...DEEP_PATH_PARTS);
	const result = resolveRealPath(nonExistent);
	// Use path.join for platform-native separators (\ vs /)
	const expectedSuffix = path.join(...DEEP_PATH_PARTS);
	assert.ok(
		result.includes(expectedSuffix),
		`should preserve all path components — expected "${expectedSuffix}" in "${result}"`,
	);
});

test("resolveRealPath follows symlinks", () => {
	const dir = os.tmpdir();
	const target = path.join(dir, `pi-test-target-${Date.now()}`);
	const link = path.join(dir, `pi-test-link-${Date.now()}`);
	fs.mkdirSync(target);
	try {
		fs.symlinkSync(target, link);
		const resolved = resolveRealPath(link);
		// Use resolveRealPath on target too to handle macOS /var → /private/var
		assert.equal(resolved, resolveRealPath(target));
	} finally {
		fs.rmSync(link, { force: true });
		fs.rmSync(target, { force: true, recursive: true });
	}
});

test("resolveRealPath: deep non-existent path under symlinked dir keeps suffix", () => {
	const target = path.join(os.tmpdir(), `pi-test-real-${Date.now()}`);
	const link = path.join(os.tmpdir(), `pi-test-link-${Date.now()}`);
	fs.mkdirSync(target);
	try {
		fs.symlinkSync(target, link);
		const deep = path.join(link, ...DEEP_PATH_PARTS);
		const resolved = resolveRealPath(deep);
		const suffix = path.join(...DEEP_PATH_PARTS);
		assert.ok(resolved.endsWith(suffix), `suffix kept — "${suffix}" in "${resolved}"`);
		assert.ok(
			resolved.startsWith(resolveRealPath(target)),
			`prefix must be the resolved target — "${resolved}"`,
		);
	} finally {
		fs.rmSync(link, { force: true });
		fs.rmSync(target, { force: true, recursive: true });
	}
});

test("resolveRealPath: dangling or looping symlink returns without throw", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolve-edge-"));
	try {
		const dangling = path.join(base, "dangling");
		fs.symlinkSync(path.join(base, "missing-target"), dangling);
		assert.equal(typeof resolveRealPath(dangling), "string");
		const loop = path.join(base, "loop");
		fs.symlinkSync(loop, loop);
		assert.equal(typeof resolveRealPath(loop), "string");
	} finally {
		fs.rmSync(base, { force: true, recursive: true });
	}
});

test("resolveRealPath: resolution is idempotent (macOS /var alias handled)", () => {
	const cases = [os.tmpdir(), path.join(os.tmpdir(), "pi-idem-missing", "child")];
	for (const p of cases) {
		const once = resolveRealPath(p);
		assert.equal(resolveRealPath(once), once, `idempotent — ${p}`);
	}
	if (process.platform === "darwin" && os.tmpdir().startsWith("/var/")) {
		// macOS exposes tmpdir under the /var alias; realpath must escape to /private/var.
		assert.ok(
			resolveRealPath(os.tmpdir()).startsWith("/private/var/"),
			`expected /private/var prefix — ${resolveRealPath(os.tmpdir())}`,
		);
	}
});
