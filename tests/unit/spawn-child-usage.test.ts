import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai";
import { abortAndClearChildSessions, createState, resetState } from "../../state.js";
import {
	MAX_CHILD_USAGE_ENTRIES,
	childUsageByCall,
	recordChildUsage,
	registerSpawnTool,
} from "../../spawn/index.js";
import { createTestHost } from "./test-host.js";

const usage = (total: number): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

beforeEach(() => childUsageByCall().clear());
afterEach(() => childUsageByCall().clear());

test("error-path backfill still records usage and the hook consumes it", async () => {
	const state = createState();
	const factory = async () => ({
		session: {
			messages: [] as unknown[],
			prompt: async () => { throw new Error("prompt failed"); },
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({
				tokens: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, total: 11 },
				cost: 0.25,
				assistantMessages: 1,
			}),
		},
		extensionsResult: undefined as never,
	});
	const pi = await createTestHost((api) => registerSpawnTool(api, state, factory as never), {
		activeTools: ["read", "bash", "spawn"],
	});

	await assert.rejects(() => pi.tools.get("spawn").execute(
		"spawn-backfill",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	));
	assert.ok(childUsageByCall().has("spawn-backfill"), "the error path records usage for backfill");

	const [onToolResult] = pi.handlers.get("tool_result")!;
	const patch = await onToolResult({
		type: "tool_result",
		toolName: "spawn",
		toolCallId: "spawn-backfill",
		input: {},
		content: [],
		isError: true,
	});
	assert.equal(patch.usage.totalTokens, 11);
	assert.equal(patch.details?.model, "mock-model", "the backfilled row carries the child model");
	assert.equal(childUsageByCall().get("spawn-backfill"), undefined, "the backfill consumes its map entry");
});

test("partial event usage merges with the backfill record instead of dropping it", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerSpawnTool(api, state, undefined as never), {
		activeTools: ["read", "bash", "spawn"],
	});
	recordChildUsage(childUsageByCall(), "spawn-merge", { usage: usage(0.25), provider: null, model: "child-model" });
	const [onToolResult] = pi.handlers.get("tool_result")!;
	const partial: Usage = { ...usage(0.1), input: 5, output: 6, totalTokens: 11 };
	const patch = await onToolResult({
		type: "tool_result",
		toolName: "spawn",
		toolCallId: "spawn-merge",
		input: {},
		content: [],
		isError: true,
		usage: partial,
	});
	assert.equal(patch.usage.input, 6, "backfill input (1) merges with partial input (5)");
	assert.equal(patch.usage.output, 7, "backfill output (1) merges with partial output (6)");
	assert.equal(patch.usage.totalTokens, 13, "totals sum instead of the backfill being dropped");
	assert.equal(patch.usage.cost.total, 0.35);
	assert.equal(patch.details?.model, "child-model");
	assert.equal(childUsageByCall().get("spawn-merge"), undefined, "the backfill consumes its map entry");
});

test("the backfill map evicts oldest entries at the cap", () => {
	const map = childUsageByCall();
	let lastEvicted: string | null = null;
	for (let i = 0; i < MAX_CHILD_USAGE_ENTRIES + 5; i++) lastEvicted = recordChildUsage(map, `call-${i}`, { usage: usage(i), provider: null, model: "child-model" }) ?? lastEvicted;
	assert.equal(map.size, MAX_CHILD_USAGE_ENTRIES, "the map stays bounded");
	assert.equal(map.get("call-0"), undefined, "the oldest entries are evicted first");
	assert.equal(map.get("call-4"), undefined, "every entry past the cap is evicted");
	assert.equal(map.get(`call-${MAX_CHILD_USAGE_ENTRIES + 4}`)?.usage.cost.total, MAX_CHILD_USAGE_ENTRIES + 4, "the newest entry survives");
});

test("recordChildUsage returns the evicted key so callers can report the loss", () => {
	const map = new Map();
	for (let i = 0; i < MAX_CHILD_USAGE_ENTRIES; i++) assert.equal(recordChildUsage(map, `k-${i}`, { usage: usage(i), provider: null, model: "m" }), null);
	assert.equal(recordChildUsage(map, "k-new", { usage: usage(99), provider: null, model: "m" }), "k-0");
	assert.equal(recordChildUsage(map, "k-new", { usage: usage(100), provider: null, model: "m" }), null, "an update evicts nothing");
});

test("session reset clears pending backfill entries", () => {
	const map = childUsageByCall();
	const record = { usage: usage(1), provider: null, model: "child-model" };
	recordChildUsage(map, "stale-1", record);
	recordChildUsage(map, "stale-2", record);
	abortAndClearChildSessions(createState());
	assert.equal(map.size, 0, "abandoned calls can never be consumed, so their entries are dropped");
});

test("resetState clears pending backfill entries", () => {
	recordChildUsage(childUsageByCall(), "stale-reset", { usage: usage(1), provider: null, model: "child-model" });
	resetState(createState());
	assert.equal(childUsageByCall().size, 0, "a fresh session starts with an empty backfill map");
});

async function runWithThrowingSubscription(hasUI: boolean) {
	const state = createState();
	const notifications: Array<[string, string]> = [];
	const session: { messages: unknown[]; prompt: () => Promise<void> } & Record<string, unknown> = {
		messages: [],
		prompt: async () => {
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
		},
		abort: async () => {},
		dispose: () => {},
		getSessionStats: () => undefined,
		subscribe: () => { throw new Error("subscribe boom"); },
	};
	const factory = async () => ({ session, extensionsResult: undefined as never });
	const pi = await createTestHost((api) => registerSpawnTool(api, state, factory as never), {
		activeTools: ["read", "bash", "spawn"],
	});

	const result = await pi.tools.get("spawn").execute(
		"spawn-subscribe-fail",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{
			model: { id: "mock-model" },
			cwd: "/tmp",
			hasUI,
			ui: { notify: (message: string, level: string) => { notifications.push([message, level]); } },
		},
	);
	return { text: (result.content[0] as { text: string }).text, notifications, entries: pi.appendedEntries };
}

test("a throwing event subscription is reported via UI and the transcript without breaking the run", async () => {
	const { text, notifications, entries } = await runWithThrowingSubscription(true);
	assert.equal(text, "child result", "the run completes without live flushes");
	assert.deepEqual(notifications, [["Spawn event subscription failed: subscribe boom", "error"]]);
	assert.deepEqual(entries, [{
		customType: "spawn-notice",
		data: { phase: "spawn-event-subscribe-failed", message: "Spawn event subscription failed: subscribe boom" },
	}]);
});

test("a headless run keeps the subscription failure visible in the transcript", async () => {
	const { text, notifications, entries } = await runWithThrowingSubscription(false);
	assert.equal(text, "child result", "the run completes without live flushes");
	assert.deepEqual(notifications, []);
	assert.deepEqual(entries, [{
		customType: "spawn-notice",
		data: { phase: "spawn-event-subscribe-failed", message: "Spawn event subscription failed: subscribe boom" },
	}]);
});
