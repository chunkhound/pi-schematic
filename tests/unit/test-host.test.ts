import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, type ExecResult, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { assertPresent } from "../assertions.js";
import { CHILD_TIMEOUT_MS } from "./spawn-node.js";
import { createExtensionContext, createToolRenderContext, emitAll, theme, type RenderContext } from "./helpers.js";
import {
	createTestHost,
	emitBeforeAgentStart,
	getCommand,
	getHandler,
	getHandlers,
	getTool,
	getToolRenderCall,
	getToolRenderResult,
	invokeHandler,
	type TestPI,
} from "./test-host.js";

function namedTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `test tool ${name}`,
		parameters: Type.Object({}),
		execute: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

function registerNamedTool(pi: ExtensionAPI, name: string): void {
	pi.registerTool(namedTool(name));
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
	await emitAll(pi, "tool_call", "probe-event", {});

	expect(pi.handlers.get("tool_call")).toHaveLength(1);
	expect(seen).toStrictEqual(["probe-event"]);
});

test("a registered handler is returned with its result", async () => {
	const pi = await createTestHost((api) => {
		api.on("input", (event) => ({ action: "transform", text: event.text.toUpperCase() }));
	});

	const result = await getHandler(pi, "input")({ type: "input", text: "probe", source: "interactive" }, createExtensionContext());

	expect(result).toStrictEqual({ action: "transform", text: "PROBE" });
});

test("a handler lookup for an unregistered event throws naming the event", async () => {
	const pi = await createTestHost((api) => {
		registerNamedTool(api, "probe_tool");
	});

	expect(() => getHandler(pi, "input")).toThrow('No "input" handler is registered on the test host.');
});

test.for([1, -1, 0.5])("a handler lookup at index %s throws naming the event and index", async (index) => {
	const pi = await createTestHost((api) => {
		api.on("input", () => ({ action: "continue" }));
	});

	expect(() => getHandler(pi, "input", index)).toThrow(`No "input" handler at index ${String(index)}; 1 registered on the test host.`);
});

const PROBE_INPUT = { type: "input", text: "probe", source: "interactive" } as const;

async function hostWithTwoInputHandlers(): Promise<TestPI> {
	return createTestHost((api) => {
		api.on("input", () => ({ action: "transform", text: "first" }));
		api.on("input", () => ({ action: "transform", text: "second" }));
	});
}

test("handlers of one event are returned in registration order", async () => {
	const pi = await hostWithTwoInputHandlers();
	const ctx = createExtensionContext();

	const results = [];
	for (const handler of getHandlers(pi, "input")) {results.push(await handler(PROBE_INPUT, ctx));}

	expect(results).toStrictEqual([{ action: "transform", text: "first" }, { action: "transform", text: "second" }]);
});

test("an invoked handler at an index is the handler registered at that position", async () => {
	const pi = await hostWithTwoInputHandlers();

	await expect(invokeHandler(pi, "input", PROBE_INPUT, createExtensionContext(), 1)).resolves.toStrictEqual({
		action: "transform",
		text: "second",
	});
});

test("an invoked handler that returns nothing resolves to undefined", async () => {
	const pi = await createTestHost((api) => {
		api.on("agent_end", () => undefined);
	});

	await expect(invokeHandler(pi, "agent_end", { type: "agent_end", messages: [] }, createExtensionContext())).resolves.toBeUndefined();
});

test("a lookup on an api the test host did not return throws", async () => {
	const pi = await createTestHost((api) => {
		registerNamedTool(api, "probe_tool");
	});

	expect(() => getTool({ ...pi }, "probe_tool")).toThrow("This api was not returned by createTestHost.");
});

test("a tool lookup returns the registered definition", async () => {
	const definition = namedTool("probe_tool");
	const pi = await createTestHost((api) => {
		api.registerTool(definition);
	});

	expect(getTool(pi, "probe_tool")).toBe(definition);
});

test("a tool's renderers are returned bound to the definition and callable with a typed render context", async () => {
	const seen: { receiver: unknown; context: RenderContext }[] = [];
	const definition: ToolDefinition = {
		...namedTool("probe_tool"),
		renderCall(_args, _theme, context) {
			seen.push({ receiver: this, context });
			return new Text("call");
		},
		renderResult(_result, _options, _theme, context) {
			seen.push({ receiver: this, context });
			return new Text("result");
		},
	};
	const pi = await createTestHost((api) => {
		api.registerTool(definition);
	});
	const callContext = createToolRenderContext({ toolCallId: "probe-call" });
	const resultContext = createToolRenderContext({ toolCallId: "probe-result" });

	getToolRenderCall(pi, "probe_tool")({}, theme, callContext);
	getToolRenderResult(pi, "probe_tool")(
		{ content: [{ type: "text", text: "ok" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		resultContext,
	);

	expect(seen).toStrictEqual([
		{ receiver: definition, context: callContext },
		{ receiver: definition, context: resultContext },
	]);
});

test.for([
	{ member: "renderCall", get: getToolRenderCall },
	{ member: "renderResult", get: getToolRenderResult },
])("a renderer lookup for a tool without $member throws naming the tool and member", async ({ member, get }) => {
	const pi = await createTestHost((api) => {
		registerNamedTool(api, "probe_tool");
	});

	expect(() => get(pi, "probe_tool")).toThrow(`Tool "probe_tool" on the test host has no ${member}.`);
});

test("a tool lookup for an unregistered name throws naming the tool", async () => {
	const pi = await createTestHost((api) => {
		registerNamedTool(api, "other_tool");
	});

	expect(() => getTool(pi, "probe_tool")).toThrow('No tool "probe_tool" is registered on the test host.');
});

test("a command lookup returns the registered command", async () => {
	const handler = async (): Promise<void> => { await Promise.resolve(); };
	const pi = await createTestHost((api) => {
		api.registerCommand("probe", { description: "probe command", handler });
	});

	const command = getCommand(pi, "probe");

	expect({ name: command.name, description: command.description, handler: command.handler }).toStrictEqual({ name: "probe", description: "probe command", handler });
});

test("a command lookup for an unregistered name throws naming the command", async () => {
	const pi = await createTestHost((api) => {
		registerNamedTool(api, "probe_tool");
	});

	expect(() => getCommand(pi, "probe")).toThrow('No command "probe" is registered on the test host.');
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
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash"] });

	expect(pi.getActiveTools()).toStrictEqual(["read", "bash"]);
});

test("host actions after the load record side effects", async () => {
	const pi = await createTestHost(vi.fn());

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
		const line = lines[index + 1];
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
			before: [(pi) => { registerNamedTool(pi, "duplicate_tool"); }, (pi) => { registerNamedTool(pi, "duplicate_tool"); }],
		}),
	).rejects.toSatisfy((error: Error) => {
		assertLoadErrorMessage(error, [/duplicate_tool/]);
		return true;
	});
});

test("every load error starts a new line", async () => {
	await expect(
		emitBeforeAgentStart({
			before: [(pi) => { registerNamedTool(pi, "first_duplicate"); }, (pi) => { registerNamedTool(pi, "first_duplicate"); }],
			after: [(pi) => { registerNamedTool(pi, "second_duplicate"); }, (pi) => { registerNamedTool(pi, "second_duplicate"); }],
		}),
	).rejects.toSatisfy((error: Error) => {
		assertLoadErrorMessage(error, [
			/first_duplicate/,
			/second_duplicate/,
		]);
		return true;
	});
});
