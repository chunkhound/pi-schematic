import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
	TEMP_DIR,
	TEMP_WRITE_ROOTS,
	TEMP_WRITE_ROOTS_CANONICAL,
} from "../../temp-dir.js";
import { resolveRealPath } from "../../resolve-path.js";

// Contract tests for the single temp-root authority (temp-dir.ts).
// They pin the exported sets so no consumer can fork its own root list.
//
// Must-include-at-least contract: these assert required members (frozen,
// canonical, /tmp and /private/tmp pins), never an exact list or length, so a
// future root (e.g. XDG_RUNTIME_DIR) can be added without breaking this suite.

test("TEMP_WRITE_ROOTS: frozen and covers both tmpdir forms", () => {
	assert.ok(Object.isFrozen(TEMP_WRITE_ROOTS), "roots must be frozen");
	assert.ok(
		TEMP_WRITE_ROOTS.includes(path.resolve(os.tmpdir())),
		"unresolved tmpdir must be writable (Seatbelt subpath does not resolve symlinks)",
	);
	assert.ok(TEMP_WRITE_ROOTS.includes(TEMP_DIR), "canonical TEMP_DIR must be writable");
});

test("TEMP_WRITE_ROOTS: POSIX scratch roots follow platform contract", () => {
	if (process.platform === "win32") {
		// A POSIX root on Windows resolves to a drive path (C:\tmp) and would
		// open a real location to the classifier — must stay absent.
		assert.ok(!TEMP_WRITE_ROOTS.includes("/tmp"), "/tmp absent on win32");
		assert.ok(!TEMP_WRITE_ROOTS.includes("/private/tmp"), "/private/tmp absent on win32");
		return;
	}
	assert.ok(TEMP_WRITE_ROOTS.includes("/tmp"), "/tmp is writable scratch on POSIX");
	if (process.platform === "darwin") {
		// /tmp is a symlink to /private/tmp on macOS; both forms must be listed.
		assert.ok(TEMP_WRITE_ROOTS.includes("/private/tmp"), "/private/tmp present on darwin");
	} else {
		assert.ok(!TEMP_WRITE_ROOTS.includes("/private/tmp"), "/private/tmp is darwin-only");
	}
});

test("TEMP_WRITE_ROOTS_CANONICAL: deduped after symlink resolution", () => {
	assert.ok(Object.isFrozen(TEMP_WRITE_ROOTS_CANONICAL), "canonical roots must be frozen");
	assert.equal(
		new Set(TEMP_WRITE_ROOTS_CANONICAL).size,
		TEMP_WRITE_ROOTS_CANONICAL.length,
		"canonical list must hold no duplicates",
	);
});

test("TEMP_WRITE_ROOTS_CANONICAL: every root resolves into the canonical set", () => {
	for (const root of TEMP_WRITE_ROOTS) {
		assert.ok(
			TEMP_WRITE_ROOTS_CANONICAL.includes(resolveRealPath(root)),
			`${root} must resolve into the canonical set`,
		);
	}
});

test("TEMP_WRITE_ROOTS_CANONICAL: entries are resolution fixed points", () => {
	for (const root of TEMP_WRITE_ROOTS_CANONICAL) {
		assert.equal(resolveRealPath(root), root, `${root} must be fully resolved`);
	}
});