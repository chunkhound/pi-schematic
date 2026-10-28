// Attribution and accumulation rules of the usage helpers, read through their public
// outputs. Whole-branch totals are covered by usage.test.ts.
import { expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
	UNATTRIBUTED_MODEL,
	addModelSpend,
	addUsage,
	assistantCount,
	collectUsage,
	mergeModelSpend,
	usageByModel,
	ZERO_USAGE,
	type ModelSpend,
} from "../../usage.js";

const ENTRY_TIME = "2026-10-07T00:00:00.000Z";

function usd(total: number): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 1,
		cacheWrite: 2,
		totalTokens: 18,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

/** A full assistant message entry; pi's type always carries provider/model and usage. */
function assistantMessage(id: string, provider: string, model: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: ENTRY_TIME,
		message: {
			role: "assistant",
			api: "test",
			provider,
			model,
			content: [{ type: "text", text: "x" }],
			timestamp: 0,
			usage: usd(total),
			stopReason: "stop",
		},
	};
}

function userMessage(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: ENTRY_TIME,
		message: { role: "user", content: "hi", timestamp: 0 },
	};
}

/** A spawn tool-result entry; `options` select the optional usage and spawn details. */
function toolResultMessage(id: string, options?: { usage?: Usage; model?: string; provider?: string }): SessionEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolName: "spawn",
		toolCallId: `tc-${id}`,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	};
	if (options !== undefined) {
		if (options.usage !== undefined) {
			message.usage = options.usage;
		}
		if (options.model !== undefined || options.provider !== undefined) {
			message.details = {
				...(options.model !== undefined ? { model: options.model } : {}),
				...(options.provider !== undefined ? { route: { provider: options.provider } } : {}),
			};
		}
	}
	return { type: "message", id, parentId: null, timestamp: ENTRY_TIME, message };
}

/** `map.get(key)` or throws, so a test can mutate a merged row without a non-null assertion. */
function requireRow(map: ReadonlyMap<string, ModelSpend>, key: string): ModelSpend {
	const row = map.get(key);
	if (row === undefined) {
		throw new Error(`missing spend row: ${key}`);
	}
	return row;
}

test("addModelSpend keeps the provider-less and provider-scoped rows of one model apart", () => {
	const map = new Map<string, ModelSpend>();
	addModelSpend(map, null, "widget", usd(0.1));
	addModelSpend(map, "acme", "widget", usd(0.2));
	expect(map.get("widget")?.costUsd).toBe(0.1);
	expect(map.get("acme/widget")?.costUsd).toBe(0.2);
	expect(map.get("acme/widget")?.provider).toBe("acme");
});

test("addModelSpend accumulates every field and counts one call per usage record", () => {
	const map = new Map<string, ModelSpend>();
	addModelSpend(map, "acme", "widget", usd(0.1));
	addModelSpend(map, "acme", "widget", usd(0.2));
	expect(map.get("acme/widget")).toStrictEqual({
		key: "acme/widget",
		provider: "acme",
		model: "widget",
		costUsd: 0.1 + 0.2,
		totalTokens: 36,
		inputTokens: 20,
		outputTokens: 10,
		cacheReadTokens: 2,
		cacheWriteTokens: 4,
		calls: 2,
	});
});

test("usageByModel attributes an assistant turn without a model to the unattributed bucket", () => {
	// pi's assistant message type always carries provider/model, so the unattributed
	// fallback is exercised through a model-less tool result instead.
	const spend = usageByModel([toolResultMessage("t1", { usage: usd(0.3) })]);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.3);
	expect(spend.get(UNATTRIBUTED_MODEL)?.provider).toBeNull();
});

test("usageByModel keys a provider-less assistant turn by its bare model name", () => {
	const spend = usageByModel([toolResultMessage("t1", { model: "widget", usage: usd(0.3) })]);
	expect([...spend.keys()]).toStrictEqual(["widget"]);
});

test("usageByModel ignores turns without usage and entries of other types", () => {
	const spend = usageByModel([toolResultMessage("t1"), userMessage("u1")]);
	expect(spend.size).toBe(0);
});

test("usageByModel attributes a tool result without a child model to the unattributed bucket", () => {
	const spend = usageByModel([toolResultMessage("t1", { usage: usd(0.4) })]);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.4);
});

test("assistantCount counts every assistant message, with or without usage, and nothing else", () => {
	const entries: SessionEntry[] = [
		userMessage("u1"),
		assistantMessage("a1", "acme", "widget", 0.1),
		assistantMessage("a2", "acme", "widget", 0.2),
		{
			type: "usage",
			id: "us1",
			parentId: null,
			timestamp: "",
			kind: "classifier",
			provider: "acme",
			model: "widget",
			usage: usd(0.1),
		},
	];
	expect(assistantCount(entries)).toBe(2);
	expect(assistantCount([])).toBe(0);
});

test("mergeModelSpend with no sources yields an empty map", () => {
	expect(mergeModelSpend().size).toBe(0);
});

test("mergeModelSpend returns row copies so mutating the result leaves its sources untouched", () => {
	const source = usageByModel([assistantMessage("a1", "acme", "widget", 0.5)]);
	const merged = mergeModelSpend(source);
	requireRow(merged, "acme/widget").costUsd = 99;
	expect(source.get("acme/widget")?.costUsd).toBe(0.5);
});

test("addUsage returns a new record and leaves both operands unchanged", () => {
	const left = usd(0.1);
	const right = usd(0.2);
	const sum = addUsage(left, right);
	expect(sum).not.toBe(left);
	expect(left.cost.total).toBe(0.1);
	expect(right.cost.total).toBe(0.2);
	expect(sum.cacheWrite).toBe(4);
});

test("ZERO_USAGE is frozen so a shared zero cannot be corrupted by a caller", () => {
	expect(Object.isFrozen(ZERO_USAGE)).toBe(true);
	expect(Object.isFrozen(ZERO_USAGE.cost)).toBe(true);
});

test("collectUsage over an empty branch equals the zero record", () => {
	expect(collectUsage([])).toStrictEqual(ZERO_USAGE);
});
