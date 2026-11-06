import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { PI_SHARED_PACKAGES, piManifestPath } from "./pi-packages.mjs";

const PI_MANIFEST_URL = pathToFileURL(piManifestPath).href;

// pi-coding-agent ships its own copies of these packages, and its nested pi packages import those
// copies. Resolving with pi's manifest as the parent gives the extension the same instances.
export async function resolve(specifier, context, defaultResolve) {
	if (PI_SHARED_PACKAGES.test(specifier)) {
		return defaultResolve(specifier, { ...context, parentURL: PI_MANIFEST_URL }, defaultResolve);
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
