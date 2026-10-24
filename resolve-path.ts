import fs from "node:fs";
import path from "node:path";

/** Join a path operand under a base WITHOUT lexical collapse. The kernel follows each
 * symlink before it applies a later `..`, so `link/..` is the link target's parent, not
 * the entry's parent. `path.resolve`/`path.join` erase that difference. */
export function joinPathFrom(base: string, value: string): string {
	return path.isAbsolute(value) ? value : `${base}${path.sep}${value}`;
}

/** Resolve `value` under `base` the way the kernel does: join raw, then follow symlinks. */
export function resolvePathFrom(base: string, value: string): string {
	return resolveRealPath(joinPathFrom(base, value));
}

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

/** True only for a real directory: a symlink or a missing path is not one. `find -execdir`
 * uses this to tell a directory search root (runs there) from a file entry (runs in its
 * parent); `lstat` keeps a symlink root on the parent side, find's default -P behavior. */
export function isRealDirectory(p: string): boolean {
	try {
		return fs.lstatSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** True only for a symlink entry, before any realpath resolution. */
export function isSymlinkPath(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
