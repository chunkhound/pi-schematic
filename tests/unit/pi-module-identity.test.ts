/**
 * pi-coding-agent ships its own copies of pi-ai, pi-tui and typebox. The extension must load
 * those same copies, or state it registers through them never reaches pi, and schemas it builds
 * belong to a different typebox than the one pi checks them with. The checks run in-process under
 * Vitest, in a Node child under register-loader, and in a Node child where pi's own extension
 * loader loads a fixture extension; the last path exists because pi's loader maps the shared
 * packages through its own alias table rather than through the resolution the other two use.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { piManifestPath } from "../../pi-packages.mjs";
import { AGENT_DIR_ENV_KEY, REGISTER_LOADER_URL, REPO_ROOT } from "../paths.js";
import { applySharedModuleProbe, PROBE_KEY, PROBE_SUMMARY, readSharedModuleProbe } from "./fixtures/shared-module-probe.js";
import { spawnNode } from "./spawn-node.js";

const PROBE_URL = new URL("fixtures/shared-module-probe.ts", import.meta.url).href;
const PROBE_EXTENSION_PATH = fileURLToPath(new URL("fixtures/shared-module-probe-extension.ts", import.meta.url));

// The ESM entry of the typebox copy pi depends on, imported by file URL so the comparison does not
// pass through the resolver under test. pi-ai only re-exports typebox, so comparing against
// pi-ai's `Type` would match whichever typebox the resolver picked.
const piTypeboxManifest = findPackageJSON("typebox", pathToFileURL(piManifestPath));
if (piTypeboxManifest === undefined) {throw new Error("pi's dependency tree has no typebox");}
// The value of `key` on `value`; throws unless `value` is an object that has `key` as its own member.
function ownMember(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {throw new Error(`Expected an object with "${key}".`);}
	const member: unknown = Reflect.get(value, key);
	return member;
}

const piTypeboxManifestJson: unknown = JSON.parse(readFileSync(piTypeboxManifest, "utf8"));
const piTypeboxImport = ownMember(ownMember(ownMember(piTypeboxManifestJson, "exports"), "."), "import");
if (typeof piTypeboxImport !== "string") {throw new Error(`typebox's manifest ${piTypeboxManifest} has no string exports["."].import`);}
const PI_TYPEBOX_URL = pathToFileURL(join(dirname(piTypeboxManifest), piTypeboxImport)).href;

test("pi-coding-agent sees the provider and keybindings set through the extension's pi-ai and pi-tui", async () => {
	const probe = applySharedModuleProbe();
	try {
		expect(await readSharedModuleProbe(probe.model)).toStrictEqual({ summary: PROBE_SUMMARY, key: PROBE_KEY });
	} finally {
		probe.restore();
	}
});

test("the extension's typebox is the instance pi depends on", async () => {
	const piTypebox: unknown = await import(PI_TYPEBOX_URL);
	expect(Type).toBe(ownMember(piTypebox, "Type"));
});

test("a Node child under register-loader shares pi's pi-ai, pi-tui and typebox", () => {
	const code = `
		import { Type } from "typebox";
		import { applySharedModuleProbe, readSharedModuleProbe } from ${JSON.stringify(PROBE_URL)};
		const { Type: PiType } = await import(${JSON.stringify(PI_TYPEBOX_URL)});
		if (Type !== PiType) throw new Error("the extension's typebox is not the instance pi depends on");
		const { model } = applySharedModuleProbe();
		process.stdout.write(JSON.stringify(await readSharedModuleProbe(model)));
	`;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-schematic-module-identity-"));
	try {
		const result = spawnNode(["--input-type=module", "--eval", code], {
			cwd: REPO_ROOT,
			env: { [AGENT_DIR_ENV_KEY]: agentDir },
			loader: REGISTER_LOADER_URL,
		});
		expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
		expect(JSON.parse(result.stdout)).toStrictEqual({ summary: PROBE_SUMMARY, key: PROBE_KEY });
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("an extension loaded by pi's own extension loader shares pi's pi-ai and pi-tui", () => {
	const code = `
		import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
		import { PROBE_MODEL_KEY, readSharedModuleProbe } from ${JSON.stringify(PROBE_URL)};
		const extensionPath = ${JSON.stringify(PROBE_EXTENSION_PATH)};
		const result = await discoverAndLoadExtensions([extensionPath], process.env.PROBE_CWD, process.env.${AGENT_DIR_ENV_KEY});
		if (result.errors.length > 0) {
			throw new Error("pi failed to load extensions: " + JSON.stringify(result.errors));
		}
		const loaded = result.extensions.map((extension) => extension.resolvedPath);
		if (loaded.length !== 1 || loaded[0] !== extensionPath) {
			throw new Error("pi loaded " + JSON.stringify(loaded) + " instead of only " + extensionPath);
		}
		const model = globalThis[PROBE_MODEL_KEY];
		if (model === undefined) throw new Error("the fixture extension did not hand over its faux model");
		process.stdout.write(JSON.stringify(await readSharedModuleProbe(model)));
	`;
	const tempDir = mkdtempSync(join(tmpdir(), "pi-schematic-module-identity-"));
	try {
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		const result = spawnNode(["--input-type=module", "--eval", code], {
			cwd: REPO_ROOT,
			env: { [AGENT_DIR_ENV_KEY]: agentDir, PROBE_CWD: cwd },
		});
		expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
		expect(JSON.parse(result.stdout)).toStrictEqual({ summary: PROBE_SUMMARY, key: PROBE_KEY });
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
