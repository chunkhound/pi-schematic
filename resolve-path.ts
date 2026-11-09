import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a path's real location, following symlinks.
 * If the path doesn't exist, walk up to the nearest existing ancestor
 * and resolve that, then append the remaining components.
 * This handles the common case where a new file is created inside a
 * symlinked temp dir (/tmp -> /private/tmp on macOS).
 */
export function resolveRealPath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		const parent = path.dirname(p);
		if (parent === p) {return p;} // hit root
		try {
			const realParent = fs.realpathSync(parent);
			return path.join(realParent, path.basename(p));
		} catch {
			return path.join(resolveRealPath(parent), path.basename(p));
		}
	}
}
