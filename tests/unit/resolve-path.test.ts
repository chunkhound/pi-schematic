import { expect, onTestFinished, test } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveRealPath } from "../../resolve-path.js";

/** A fresh directory under the OS temp dir, removed when the test finishes. */
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-schematic-resolve-path-"));
	onTestFinished(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

test("resolveRealPath resolves a missing file inside a symlinked directory", () => {
	const dir = tempDir();
	const target = path.join(dir, "target");
	const link = path.join(dir, "link");
	fs.mkdirSync(target);
	fs.symlinkSync(target, link);

	expect(resolveRealPath(path.join(link, "a", "b", "new-file"))).toBe(path.join(fs.realpathSync(target), "a", "b", "new-file"));
});

test("resolveRealPath follows symlinks", () => {
	const dir = tempDir();
	const target = path.join(dir, "target");
	const link = path.join(dir, "link");
	fs.mkdirSync(target);
	fs.symlinkSync(target, link);

	expect(resolveRealPath(link)).toBe(fs.realpathSync(target));
});
