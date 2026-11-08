import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, type ExecResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { assertPresent } from "../assertions.js";
import { CHILD_TIMEOUT_MS } from "./spawn-node.js";
import { createTestHost, emitBeforeAgentStart } from "./test-host.js";

function registerNamedTool(pi: ExtensionAPI, name: string): void {
	pi.registerTool({
		name,
		label: name,
		description: `test tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	});
}

function leakExtensionSource(toolName: string): string {
	return `export default function (pi) {
	pi.registerTool({
		name: ${JSON.stringify(toolName)},
		label: ${JSON.stringify(toolName)},
		description: "leaked from the machine",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "leak" }], details: undefined }),
	});
}
`;
}

test("a factory's tool is registered on the host", async () => {
	const pi = await createTestHost((api) => {
		registerNamedTool(api, "probe_tool");
	});

	expect([...pi.tools.keys()]).toStrictEqual(["probe_tool"]);
});

test("a factory's event handler is registered on the host", async () => {
	const seen: unknown[] = [];

	const pi = await createTestHost((api) => {
		api.on("tool_call", (event) => {
			seen.push(event);
		});
	});
	const handlers = pi.handlers.get("tool_call") ?? [];
	for (const registered of handlers) await registered("probe-event", {});

	expect(handlers).toHaveLength(1);
	expect(seen).toStrictEqual(["probe-event"]);
});

test("the returned host is the api object pi passed to the factory", async () => {
	let seen: ExtensionAPI | undefined;

	const pi = await createTestHost((api) => {
		seen = api;
	});

	expect(pi).toBe(seen);
});

test("the default factory registers schematic's tools", async () => {
	const pi = await createTestHost();

	for (const name of ["spawn", "handoff", "notebook_write", "notebook_read", "notebook_index", "notebook_topic_set"]) {
		expect(pi.tools.has(name), `missing tool ${name}`).toBe(true);
	}
});

test("extensions in the project directory are not loaded", async () => {
	const root = mkdtempSync(join(tmpdir(), "test-host-isolation-"));
	const project = join(root, "project");
	try {
		mkdirSync(join(project, CONFIG_DIR_NAME, "extensions"), { recursive: true });
		writeFileSync(join(project, CONFIG_DIR_NAME, "extensions", "leak.js"), leakExtensionSource("leak_project"));
		const pi = await createTestHost(undefined, { cwd: project });

		expect(pi.tools.has("leak_project")).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi.exec during registration runs in the seeded project directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "test-host-exec-"));
	try {
		let result: ExecResult | undefined;
		await createTestHost(async (pi) => {
			// The child must come from pi.exec, so it cannot go through spawnNode; pi.exec has no env option to
			// clear NODE_OPTIONS, and the child only prints its working directory.
			result = await pi.exec(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
				timeout: CHILD_TIMEOUT_MS,
			});
		}, { cwd: dir });

		assertPresent(result);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(realpathSync(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("host actions after the load report seeded state", async () => {
	const pi = await createTestHost(() => {}, { activeTools: ["read", "bash"] });

	expect(pi.getActiveTools()).toStrictEqual(["read", "bash"]);
});

test("host actions after the load record side effects", async () => {
	const pi = await createTestHost(() => {});

	pi.sendUserMessage("x");
	pi.appendEntry("t", {});

	expect(pi.sentUserMessages).toStrictEqual([{ content: "x", options: undefined }]);
	expect(pi.appendedEntries).toStrictEqual([{ customType: "t", data: {} }]);
});

// The host's contract, independent of the path pi assigns: a header line, then
// each load error starting a new line as `path: message`.
function assertLoadErrorMessage(error: Error, expected: RegExp[]): void {
	const lines = error.message.split("\n");
	expect(lines[0]).toBe("pi reported extension load errors:");
	expect(lines).toHaveLength(expected.length + 1);
	for (const [index, pattern] of expected.entries()) {
		const line = lines[index + 1]!;
		expect(line).toMatch(/^[^\n]+: [^\n]+$/);
		expect(line).toMatch(pattern);
	}
}

test("a throwing factory's message is listed as a load error", async () => {
	const detail = "probe factory exploded";

	await expect(
		createTestHost(() => {
			throw new Error(detail);
		}),
	).rejects.toSatisfy((error: Error) => {
		assertLoadErrorMessage(error, [/probe factory exploded$/]);
		return true;
	});
});

test("an action called during registration fails the load", async () => {
	await expect(
		createTestHost((pi) => {
			pi.getActiveTools();
		}),
	).rejects.toSatisfy((error: Error) => {
		assertLoadErrorMessage(error, [/.+/]);
		return true;
	});
});

test("a duplicate tool registration is listed as a load error", async () => {
	await expect(
		emitBeforeAgentStart({
			before: [(pi) => registerNamedTool(pi, "duplicate_tool"), (pi) => registerNamedTool(pi, "duplicate_tool")],
		}),
	).rejects.toSatisfy((error: Error) => {
		assertLoadErrorMessage(error, [/duplicate_tool/]);
		return true;
	});
});

test("every load error starts a new line", async () => {
	await expect(
		emitBeforeAgentStart({
			before: [(pi) => registerNamedTool(pi, "first_duplicate"), (pi) => registerNamedTool(pi, "first_duplicate")],
			after: [(pi) => registerNamedTool(pi, "second_duplicate"), (pi) => registerNamedTool(pi, "second_duplicate")],
		}),
	).rejects.toSatisfy((error: Error) => {
		assertLoadErrorMessage(error, [
			/first_duplicate/,
			/second_duplicate/,
		]);
		return true;
	});
});
