import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Walk up from a start directory to find node_modules/<name>.
 * Works regardless of how the package was installed (local vs global).
 */
function findPackageRoot(name, startDir, maxDepth = 50) {
	let dir = startDir;
	let depth = 0;
	while (true) {
		if (depth > maxDepth) return null;
		const candidate = path.join(dir, "node_modules", name);
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
		depth++;
	}
}

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = findPackageRoot(
	"@earendil-works/pi-coding-agent",
	PROJECT_ROOT,
);
if (!PACKAGE_ROOT) throw new Error("Cannot find @earendil-works/pi-coding-agent package root");

function findPackageEntry(name, entry, searchRoot) {
	const packageRoot = findPackageRoot(name, searchRoot);
	if (!packageRoot) throw new Error(`Cannot find ${name} package root`);
	const resolved = path.join(packageRoot, entry);
	if (existsSync(resolved)) return resolved;
	throw new Error(`Cannot find ${name}/${entry}`);
}

const TYPEBOX_ROOT = findPackageRoot("typebox", PROJECT_ROOT);
if (!TYPEBOX_ROOT) throw new Error("Cannot find typebox package root");
const TYPEBOX_EXPORTS = JSON.parse(readFileSync(path.join(TYPEBOX_ROOT, "package.json"), "utf8")).exports;

function resolveTypeboxSpecifier(specifier) {
	const exportKey = specifier === "typebox" ? "." : `./${specifier.slice("typebox/".length)}`;
	const exportTarget = TYPEBOX_EXPORTS?.[exportKey];
	const entry = typeof exportTarget === "string" ? exportTarget : exportTarget?.import ?? exportTarget?.default;
	if (!entry) throw new Error(`Cannot find ${specifier} export in top-level typebox package`);
	const resolved = path.join(TYPEBOX_ROOT, entry);
	if (!existsSync(resolved)) throw new Error(`Cannot find ${specifier} at ${resolved}`);
	return resolved;
}

const PACKAGE_ALIASES = {
	"@earendil-works/pi-coding-agent": `${PACKAGE_ROOT}/dist/index.js`,
	"@earendil-works/pi-ai": findPackageEntry("@earendil-works/pi-ai", "dist/index.js", PACKAGE_ROOT),
	"@earendil-works/pi-tui": findPackageEntry("@earendil-works/pi-tui", "dist/index.js", PACKAGE_ROOT),
	"@earendil-works/pi-agent-core": findPackageEntry("@earendil-works/pi-agent-core", "dist/index.js", PACKAGE_ROOT),
	"@earendil-works/pi-codemode": findPackageEntry("@earendil-works/pi-codemode", "dist/index.js", PACKAGE_ROOT),
};

export async function resolve(specifier, context, defaultResolve) {
	// typebox handled before PACKAGE_ALIASES — resolved via exports map, not alias entry.
	if (specifier === "typebox" || specifier.startsWith("typebox/")) {
		const typeboxPath = resolveTypeboxSpecifier(specifier);
		// Tests should use the repo's declared top-level TypeBox package, including subpath exports.
		return defaultResolve(pathToFileURL(typeboxPath).href, context, defaultResolve);
	}

	const packagePath = PACKAGE_ALIASES[specifier];
	if (packagePath) {
		return defaultResolve(pathToFileURL(packagePath).href, context, defaultResolve);
	}

	if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
		const parentPath = fileURLToPath(context.parentURL);
		const tsPath = path.resolve(path.dirname(parentPath), specifier.slice(0, -3) + ".ts");
		try {
			await access(tsPath);
			return defaultResolve(pathToFileURL(tsPath).href, context, defaultResolve);
		} catch {
			// fall through
		}
	}

	return defaultResolve(specifier, context, defaultResolve);
}
