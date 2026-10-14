import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { abortAndClearChildSessions, createState, resetState } from "../../state.js";
import { usageByModel } from "../../usage.js";
import {
	MAX_CHILD_USAGE_ENTRIES,
	childUsageByCall,
	recordChildUsage,
	registerSpawnTool,
} from "../../spawn/index.js";
import { createTestHost } from "./test-host.js";
import { createRenderContext, stripAnsi, theme } from "./helpers.js";

const usage = (total: number): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

/** A settled spawn tool-result message: the branch copy `usageByModel` attributes. */
function toolResultEntry(id: string, toolCallId: string, usage: Usage | undefined, details: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "toolResult", toolName: "spawn", toolCallId, content: "done", timestamp: 0, usage, details },
	} as unknown as SessionEntry;
}

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
	recordChildUsage(childUsageByCall(), "spawn-merge", { usage: usage(0.25), model: "child-model", thinking: "medium", route: { status: "inherited" } });
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
	for (let i = 0; i < MAX_CHILD_USAGE_ENTRIES + 5; i++) lastEvicted = recordChildUsage(map, `call-${i}`, { usage: usage(i), model: "child-model", thinking: "medium", route: { status: "inherited" } }) ?? lastEvicted;
	assert.equal(map.size, MAX_CHILD_USAGE_ENTRIES, "the map stays bounded");
	assert.equal(map.get("call-0"), undefined, "the oldest entries are evicted first");
	assert.equal(map.get("call-4"), undefined, "every entry past the cap is evicted");
	assert.equal(map.get(`call-${MAX_CHILD_USAGE_ENTRIES + 4}`)?.usage.cost.total, MAX_CHILD_USAGE_ENTRIES + 4, "the newest entry survives");
});

test("recordChildUsage returns the evicted key so callers can report the loss", () => {
	const map = new Map();
	for (let i = 0; i < MAX_CHILD_USAGE_ENTRIES; i++) assert.equal(recordChildUsage(map, `k-${i}`, { usage: usage(i), model: "m", thinking: "medium", route: { status: "inherited" } }), null);
	assert.equal(recordChildUsage(map, "k-new", { usage: usage(99), model: "m", thinking: "medium", route: { status: "inherited" } }), "k-0");
	assert.equal(recordChildUsage(map, "k-new", { usage: usage(100), model: "m", thinking: "medium", route: { status: "inherited" } }), null, "an update evicts nothing");
});

test("session reset clears pending backfill entries", () => {
	const map = childUsageByCall();
	const record = { usage: usage(1), model: "child-model", thinking: "medium" as const, route: { status: "inherited" as const } };
	recordChildUsage(map, "stale-1", record);
	recordChildUsage(map, "stale-2", record);
	abortAndClearChildSessions(createState());
	assert.equal(map.size, 0, "abandoned calls can never be consumed, so their entries are dropped");
});

test("resetState clears pending backfill entries", () => {
	recordChildUsage(childUsageByCall(), "stale-reset", { usage: usage(1), model: "child-model", thinking: "medium", route: { status: "inherited" } });
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

// WHY: every route carries a provider, so the ledger keys on `provider/model`. Dropping it for
// the inherited route split one model's spend across a bare-model row and a provider/model row.
test("an inherited child's backfilled error details carry provider/modelId and one spend row", async () => {
	const state = createState();
	const factory = async () => ({
		session: {
			messages: [] as unknown[],
			prompt: async () => { throw new Error("prompt failed"); },
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				cost: 0.1,
				assistantMessages: 1,
			}),
		},
		extensionsResult: undefined as never,
	});
	const pi = await createTestHost((api) => registerSpawnTool(api, state, factory as never), {
		activeTools: ["read", "bash", "spawn"],
	});

	await assert.rejects(() => pi.tools.get("spawn").execute(
		"spawn-inherited",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { provider: "openai", id: "parent-model" }, cwd: "/tmp" },
	));
	assert.equal(
		childUsageByCall().get("spawn-inherited")?.route.provider,
		"openai",
		"the inherited route's provider reaches the backfill record",
	);

	const [onToolResult] = pi.handlers.get("tool_result")!;
	const patch = await onToolResult({ type: "tool_result", toolName: "spawn", toolCallId: "spawn-inherited", input: {}, content: [], isError: true });
	assert.deepEqual(patch.details.route, { status: "inherited", provider: "openai", modelId: "parent-model" }, "the backfilled route carries both identity fields");
	const spend = usageByModel([toolResultEntry("tr-inherited-err", "spawn-inherited", patch.usage, patch.details)]);
	assert.deepEqual([...spend.keys()], ["openai/parent-model"], "one provider/model row, no bare-model split");
});

// WHY: the renderer re-validates the persisted details, so a routed error backfill must keep
// `status` (and a valid `thinking`) to render its routed line instead of falling back to the
// bare model line. This drives the real failing execution so the hook's unmodified output is
// what gets rendered — no manual detail augmentation.
test("a routed child's backfilled error route renders the routed identity line", async () => {
	const state = createState();
	state.modelGroups.groups = [{
		name: "review",
		scope: "project",
		sourcePath: "<project>",
		models: [{ provider: "openai", modelId: "gpt-routed", thinkingLevel: "low" }],
		validation: { unavailableRefs: [], shadowedByProject: false, degraded: false },
	} as any];
	const routedModel = { provider: "openai", id: "gpt-routed", reasoning: true };
	const parentRegistry = {
		find: (provider: string, modelId: string) => provider === "openai" && modelId === "gpt-routed" ? routedModel : undefined,
		hasConfiguredAuth: (model: any) => model === routedModel,
	};
	const factory = async () => ({
		session: {
			messages: [] as unknown[],
			prompt: async () => { throw new Error("prompt failed"); },
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				cost: 0.1,
				assistantMessages: 1,
			}),
		},
		extensionsResult: undefined as never,
	});
	const pi = await createTestHost((api) => registerSpawnTool(api, state, factory as never), {
		activeTools: ["read", "bash", "spawn"],
	});

	await assert.rejects(() => pi.tools.get("spawn").execute(
		"spawn-routed",
		{ prompt: "Do the task", group: "review" },
		undefined,
		undefined,
		{ model: { provider: "openai", id: "parent-model" }, cwd: "/tmp", modelRegistry: parentRegistry },
	));

	const [onToolResult] = pi.handlers.get("tool_result")!;
	const patch = await onToolResult({
		type: "tool_result",
		toolName: "spawn",
		toolCallId: "spawn-routed",
		input: {},
		content: [],
		isError: true,
	});
	assert.deepEqual(patch.details.route, { status: "routed", group: "review", provider: "openai", modelId: "gpt-routed" });

	const rendered = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "prompt failed" }],
			details: patch.details,
		},
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "spawn-routed", isError: true }),
	) as any;
	assert.ok(
		rendered.render(120).some((line: string) => stripAnsi(line).includes("review → openai/gpt-routed • low")),
		"the backfilled route drives the routed identity line",
	);
});

// WHY: the live success path persists its route details; an inherited route that omits the
// provider would make a second source (a re-scan of the branch) split the same model's spend.
test("an inherited child's success details carry provider/modelId and one spend row", async () => {
	const state = createState();
	const session: { messages: unknown[]; prompt: () => Promise<void>; abort: () => Promise<void>; dispose: () => void; getSessionStats: () => unknown } = {
		messages: [],
		prompt: async () => { session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }]; },
		abort: async () => {},
		dispose: () => {},
		getSessionStats: () => ({ tokens: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, total: 11 }, cost: 0.25, assistantMessages: 1 }),
	};
	const pi = await createTestHost((api) => registerSpawnTool(api, state, (async () => ({ session, extensionsResult: undefined as never })) as never), {
		activeTools: ["read", "bash", "spawn"],
	});

	const result = await pi.tools.get("spawn").execute(
		"spawn-inherited-ok",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { provider: "openai", id: "parent-model" }, cwd: "/tmp" },
	);
	assert.deepEqual(result.details.route, { status: "inherited", provider: "openai", modelId: "parent-model" });
	const spend = usageByModel([toolResultEntry("tr-inherited-ok", "spawn-inherited-ok", result.usage, result.details)]);
	assert.deepEqual([...spend.keys()], ["openai/parent-model"], "one provider/model row, no bare-model split");
});
