/**
 * pi-coding-agent ships its own copies of pi-ai, pi-tui and typebox. The extension must load
 * those same copies, or state it registers through them never reaches pi, and schemas it builds
 * belong to a different typebox than the one pi checks them with. The pi-ai and pi-tui checks
 * register state through the shared package's public API and observe it through pi-coding-agent's
 * public API.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { generateSummary, keyText } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { piManifestPath } from "../../pi-packages.mjs";
import { AGENT_DIR_ENV_KEY, REGISTER_LOADER_URL, REPO_ROOT } from "../paths.js";
import { spawnNode } from "./spawn-node.js";

const PROBE_SUMMARY = "pi-module-identity probe summary";
const PROBE_KEY = "ctrl+q";

// The ESM entry of the typebox copy pi depends on, imported by file URL so the comparison does not
// pass through the resolver under test. pi-ai only re-exports typebox, so comparing against
// pi-ai's `Type` would match whichever typebox the resolver picked.
const piTypeboxManifest = findPackageJSON("typebox", pathToFileURL(piManifestPath));
if (piTypeboxManifest === undefined) throw new Error("pi's dependency tree has no typebox");
const PI_TYPEBOX_URL = pathToFileURL(
	join(dirname(piTypeboxManifest), JSON.parse(readFileSync(piTypeboxManifest, "utf8")).exports["."].import),
).href;

test("pi-coding-agent sees an api provider registered through the extension's pi-ai", async () => {
	const faux = registerFauxProvider();
	try {
		faux.setResponses([fauxAssistantMessage(PROBE_SUMMARY)]);
		expect(await generateSummary([], faux.getModel(), 2_000, undefined)).toBe(PROBE_SUMMARY);
	} finally {
		faux.unregister();
	}
});

test("pi-coding-agent sees keybindings set through the extension's pi-tui", () => {
	const previous = getKeybindings();
	try {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.cursorUp": PROBE_KEY }));
		expect(keyText("tui.editor.cursorUp")).toBe(PROBE_KEY);
	} finally {
		setKeybindings(previous);
	}
});

test("the extension's typebox is the instance pi depends on", async () => {
	const { Type: PiType } = await import(PI_TYPEBOX_URL);
	expect(Type).toBe(PiType);
});

test("a Node child under register-loader shares pi's pi-ai, pi-tui and typebox", () => {
	const code = `
		import { fauxAssistantMessage } from "@earendil-works/pi-ai";
		import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
		import { generateSummary, keyText } from "@earendil-works/pi-coding-agent";
		import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
		import { Type } from "typebox";
		const { Type: PiType } = await import(${JSON.stringify(PI_TYPEBOX_URL)});
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage(${JSON.stringify(PROBE_SUMMARY)})]);
		const summary = await generateSummary([], faux.getModel(), 2000, undefined);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.cursorUp": ${JSON.stringify(PROBE_KEY)} }));
		if (Type !== PiType) throw new Error("the extension's typebox is not the instance pi depends on");
		process.stdout.write(JSON.stringify({ summary, key: keyText("tui.editor.cursorUp") }));
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
