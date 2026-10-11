import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRealPath } from "./resolve-path.js";

const tmpdirResolved = path.resolve(os.tmpdir());

/**
 * Canonical (symlink-resolved) OS temp dir path, resolved at module import time.
 *
 * Lives in its own module so every consumer shares one authority without
 * importing the enforcement layers: os-sandbox.ts (sandbox write roots),
 * readonly-shell-utils.ts (classifier path checks), readonly-bash-mktemp.ts
 * (synthetic mktemp paths).
 */
export const TEMP_DIR = (() => {
	try { return fs.realpathSync(tmpdirResolved); } catch { return tmpdirResolved; }
})();

/**
 * Every filesystem root readonly mode treats as writable scratch space.
 *
 * Single source of truth consumed by both enforcement layers — os-sandbox.ts
 * builds its platform sandbox from it and readonly-shell-utils.ts classifies
 * paths against it. Linux binds existing canonical roots; missing roots beneath
 * read-only ancestors remain unavailable.
 *
 * Includes the canonical + unresolved tmpdir forms (Seatbelt `subpath` does
 * NOT resolve symlinks), plus the POSIX scratch root /tmp; macOS also adds
 * /private/tmp (the realpath of /tmp).
 * POSIX-only: on Windows, POSIX-style absolute roots would silently resolve to
 * drive-root paths (C:\tmp) and open real locations to the L2 classifier.
 * Keeping /tmp writable also supports shell heredoc scratch files.
 */
const POSIX_SCRATCH_ROOTS = process.platform === "win32" ? []
	: process.platform === "darwin" ? ["/private/tmp", "/tmp"]
	: ["/tmp"];

export const TEMP_WRITE_ROOTS: readonly string[] = Object.freeze([
	...new Set([TEMP_DIR, tmpdirResolved, ...POSIX_SCRATCH_ROOTS]),
]);

/** TEMP_WRITE_ROOTS with every symlink resolved: the containment set classifier path checks
 * use, and the roots the parity tests compare. On Linux, an exotic TMPDIR under a read-only
 * ancestor is caught by `buildWritableBindsFromRoots` in os-sandbox.ts, which throws when no
 * root is a live directory; the macOS profile builder (`buildMacProfile`) does not throw. */
export const TEMP_WRITE_ROOTS_CANONICAL: readonly string[] = (() => {
	const roots = Object.freeze([
		...new Set(TEMP_WRITE_ROOTS.map((root) => resolveRealPath(root))),
	]);
	return roots;
})();
