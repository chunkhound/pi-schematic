// Guards the shared test host against drift. Production calls `pi.*`; most of those delegate
// to a runtime handler that stays the `notInitialized` sentinel until the host binds it. A
// missing bind throws "Extension runtime not initialized" only at call time, deep inside an
// unrelated suite — so this file scans the engine's call sites and probes each runtime action
// the host must answer. Registration methods live on the real loader api and are not probed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTestHost, type TestPI } from "./test-host.js";

const WORKFLOW_DIR = fileURLToPath(new URL("../../workflow/", import.meta.url));

/** Comment text can mention `pi.foo(`; strip it so the scan only sees real calls. */
function stripComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Every `pi.<method>(` or `deps.pi.<method>(` under workflow/, with the files that call it. */
function calledPiMethods(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const name of readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith(".ts"))) {
		const code = stripComments(readFileSync(WORKFLOW_DIR + name, "utf8"));
		for (const match of code.matchAll(/\bpi\.([A-Za-z_][A-Za-z0-9_]*)\(/g)) {
			const files = found.get(match[1]) ?? [];
			if (!files.includes(name)) files.push(name);
			found.set(match[1], files);
		}
	}
	return found;
}

// Registration methods are provided by pi's loader, so they never carry the sentinel.
const REGISTRATION_PREFIXES = ["register", "on"];

// Safe probes for the runtime handlers the engine calls. A new call site that is not a
// registration method and has no probe fails the test, so this table cannot silently drift.
const PROBES: Record<string, (pi: TestPI) => unknown> = {
	getSettings: (pi) => pi.getSettings(),
	getActiveTools: (pi) => pi.getActiveTools(),
	getAllTools: (pi) => pi.getAllTools(),
	getCommands: (pi) => pi.getCommands(),
	getThinkingLevel: (pi) => pi.getThinkingLevel(),
	getSessionName: (pi) => pi.getSessionName(),
	getFlag: (pi) => pi.getFlag("host-contract-probe"),
	appendEntry: (pi) => pi.appendEntry("host-contract-probe"),
	sendUserMessage: (pi) => pi.sendUserMessage("host-contract-probe"),
	setSessionName: (pi) => pi.setSessionName("host-contract-probe"),
	setLabel: (pi) => pi.setLabel("host-contract-probe", undefined),
	setActiveTools: (pi) => pi.setActiveTools([]),
	setThinkingLevel: (pi) => pi.setThinkingLevel("medium"),
	setModel: (pi) => pi.setModel(undefined as never),
};

test("every pi action the workflow engine calls exists on the host", async () => {
	const pi = await createTestHost();
	const missing = [...calledPiMethods()]
		.filter(([method]) => typeof (pi as unknown as Record<string, unknown>)[method] !== "function")
		.map(([method, files]) => `${method} (${files.join(", ")})`);
	assert.deepEqual(missing, [], `host is missing pi actions: ${missing.join("; ")}`);
});

test("every runtime action the engine calls answers without the notInitialized sentinel", async () => {
	const pi = await createTestHost();
	const uncovered: string[] = [];
	for (const [method] of calledPiMethods()) {
		if (REGISTRATION_PREFIXES.some((prefix) => method.startsWith(prefix))) continue;
		const probe = PROBES[method];
		if (!probe) {
			uncovered.push(method);
			continue;
		}
		try {
			await probe(pi);
		} catch (error) {
			assert.fail(`${method} is unbound in the host: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	assert.deepEqual(uncovered, [], `add a safe host probe for: ${uncovered.join(", ")}`);
});

test("seeded shellPath reaches the engine through getSettings", async () => {
	const pi = await createTestHost(undefined, { shellPath: "/bin/zsh" });
	assert.equal(pi.getSettings().shellPath, "/bin/zsh");
});

test("the test flag store round-trips through the real getFlag reader", async () => {
	const pi = await createTestHost((api) => {
		api.registerFlag("host-contract-probe", { type: "string", description: "host-contract probe" });
	});
	pi.setFlag("host-contract-probe", "5");
	assert.equal(pi.getFlag("host-contract-probe"), "5");
});
