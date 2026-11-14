import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Canonical (symlink-resolved) OS temp dir path.
 *
 * Resolved at module import time. Shared by readonly-bash.ts and os-sandbox.ts
 * so both modules agree on the same temp directory.
 *
 * This lives in its own module to avoid a cyclic dependency between
 * readonly-bash.ts (imports from os-sandbox.ts) and os-sandbox.ts.
 */
export const TEMP_DIR = (() => {
	const resolved = path.resolve(os.tmpdir());
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
})();
