import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, type ExecResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

	assert.deepEqual([...pi.tools.keys()], ["probe_tool"]);
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

	assert.equal(handlers.length, 1);
	assert.deepEqual(seen, ["probe-event"]);
});

test("the returned host is the api object pi passed to the factory", async () => {
	let seen: ExtensionAPI | undefined;

	const pi = await createTestHost((api) => {
		seen = api;
	});

	assert.equal(pi, seen);
});

test("the default factory registers schematic's tools", async () => {
	const pi = await createTestHost();

	for (const name of ["spawn", "handoff", "notebook_write", "notebook_read", "notebook_index", "notebook_topic_set"]) {
		assert.ok(pi.tools.has(name), `missing tool ${name}`);
	}
});

test("extensions in the project directory are not loaded", async () => {
	const root = mkdtempSync(join(tmpdir(), "test-host-isolation-"));
	const project = join(root, "project");
	try {
		mkdirSync(join(project, CONFIG_DIR_NAME, "extensions"), { recursive: true });
		writeFileSync(join(project, CONFIG_DIR_NAME, "extensions", "leak.js"), leakExtensionSource("leak_project"));
		const pi = await createTestHost(undefined, { cwd: project });

		assert.equal(pi.tools.has("leak_project"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi.exec during registration runs in the seeded project directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "test-host-exec-"));
	try {
		let result: ExecResult | undefined;
		await createTestHost(async (pi) => {
			result = await pi.exec(process.execPath, ["-e", "process.stdout.write(process.cwd())"]);
		}, { cwd: dir });

		assert.ok(result);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, realpathSync(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("host actions after the load report seeded state", async () => {
	const pi = await createTestHost(() => {}, { activeTools: ["read", "bash"] });

	assert.deepEqual(pi.getActiveTools(), ["read", "bash"]);
});

test("host actions after the load record side effects", async () => {
	const pi = await createTestHost(() => {});

	pi.sendUserMessage("x");
	pi.appendEntry("t", {});

	assert.deepEqual(pi.sentUserMessages, [{ content: "x", options: undefined }]);
	assert.deepEqual(pi.appendedEntries, [{ customType: "t", data: {} }]);
});

// The host's contract, independent of the path pi assigns: a header line, then
// each load error starting a new line as `path: message`.
function assertLoadErrorMessage(error: Error, expected: RegExp[]): void {
	const lines = error.message.split("\n");
	assert.equal(lines[0], "pi reported extension load errors:");
	assert.equal(lines.length, expected.length + 1);
	for (const [index, pattern] of expected.entries()) {
		const line = lines[index + 1]!;
		assert.match(line, /^[^\n]+: [^\n]+$/);
		assert.match(line, pattern);
	}
}

test("a throwing factory's message is listed as a load error", async () => {
	const detail = "probe factory exploded";

	await assert.rejects(
		createTestHost(() => {
			throw new Error(detail);
		}),
		(error: Error) => {
			assertLoadErrorMessage(error, [/probe factory exploded$/]);
			return true;
		},
	);
});

test("an action called during registration fails the load", async () => {
	await assert.rejects(
		createTestHost((pi) => {
			pi.getActiveTools();
		}),
		(error: Error) => {
			assertLoadErrorMessage(error, [/.+/]);
			return true;
		},
	);
});

test("a duplicate tool registration is listed as a load error", async () => {
	await assert.rejects(
		emitBeforeAgentStart({
			before: [(pi) => registerNamedTool(pi, "duplicate_tool"), (pi) => registerNamedTool(pi, "duplicate_tool")],
		}),
		(error: Error) => {
			assertLoadErrorMessage(error, [/duplicate_tool/]);
			return true;
		},
	);
});

test("every load error starts a new line", async () => {
	await assert.rejects(
		emitBeforeAgentStart({
			before: [(pi) => registerNamedTool(pi, "first_duplicate"), (pi) => registerNamedTool(pi, "first_duplicate")],
			after: [(pi) => registerNamedTool(pi, "second_duplicate"), (pi) => registerNamedTool(pi, "second_duplicate")],
		}),
		(error: Error) => {
			assertLoadErrorMessage(error, [
				/first_duplicate/,
				/second_duplicate/,
			]);
			return true;
		},
	);
});
