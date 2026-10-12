import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a path's real location, following symlinks.
 * If the path doesn't exist, walk up to the nearest existing ancestor
 * and resolve that, then append the remaining components.
 * This handles the common case where a new file is created inside a
 * symlinked temp dir (/tmp -> /private/tmp on macOS).
 *
 * WHY `realpathSync.native`: the JS realpath walk rebuilds the path from the input
 * segments and never expands Windows 8.3 short names (`RUNNER~1`), while git and the
 * OS resolver return the long form. Both roots and targets must canonicalize identically
 * or containment misjudges a temp path as outside.
 */
export function resolveRealPath(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		const parent = path.dirname(p);
		if (parent === p) return p; // hit root
		try {
			const realParent = fs.realpathSync.native(parent);
			return path.join(realParent, path.basename(p));
		} catch {
			return path.join(resolveRealPath(parent), path.basename(p));
		}
	}
}
