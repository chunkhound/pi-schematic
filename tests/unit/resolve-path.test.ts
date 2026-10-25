import { expect, test } from "vitest";
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
	expect(result, `should preserve all path components — expected "${expectedSuffix}" in "${result}"`).toContain(expectedSuffix);
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
		expect(resolved).toBe(resolveRealPath(target));
	} finally {
		fs.rmSync(link, { force: true });
		fs.rmSync(target, { force: true, recursive: true });
	}
});
