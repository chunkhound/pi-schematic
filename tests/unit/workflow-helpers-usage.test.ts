// Attribution and accumulation rules of the usage helpers, read through their public
// outputs. Whole-branch totals are covered by usage.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
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

function assistant(id: string, fields: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 0, ...fields },
	} as SessionEntry;
}

function userMessage(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "user", content: "hi", timestamp: 0 },
	} as SessionEntry;
}

test("addModelSpend keeps the provider-less and provider-scoped rows of one model apart", () => {
	const map = new Map<string, ModelSpend>();
	addModelSpend(map, null, "widget", usd(0.1));
	addModelSpend(map, "acme", "widget", usd(0.2));
	assert.equal(map.get("widget")?.costUsd, 0.1);
	assert.equal(map.get("acme/widget")?.costUsd, 0.2);
	assert.equal(map.get("acme/widget")?.provider, "acme");
});

test("addModelSpend accumulates every field and counts one call per usage record", () => {
	const map = new Map<string, ModelSpend>();
	addModelSpend(map, "acme", "widget", usd(0.1));
	addModelSpend(map, "acme", "widget", usd(0.2));
	assert.deepEqual(map.get("acme/widget"), {
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
	const spend = usageByModel([assistant("a1", { usage: usd(0.3) })]);
	assert.equal(spend.get(UNATTRIBUTED_MODEL)?.costUsd, 0.3);
	assert.equal(spend.get(UNATTRIBUTED_MODEL)?.provider, null);
});

test("usageByModel keys a provider-less assistant turn by its bare model name", () => {
	const spend = usageByModel([assistant("a1", { model: "widget", usage: usd(0.3) })]);
	assert.deepEqual([...spend.keys()], ["widget"]);
});

test("usageByModel ignores turns without usage and entries of other types", () => {
	const spend = usageByModel([assistant("a1", { provider: "acme", model: "widget" }), userMessage("u1")]);
	assert.equal(spend.size, 0);
});

test("usageByModel attributes a tool result without a child model to the unattributed bucket", () => {
	const toolResult = {
		type: "message",
		id: "t1",
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "toolResult", toolName: "bash", toolCallId: "c1", content: "ok", timestamp: 0, usage: usd(0.4) },
	} as unknown as SessionEntry;
	assert.equal(usageByModel([toolResult]).get(UNATTRIBUTED_MODEL)?.costUsd, 0.4);
});

test("assistantCount counts every assistant message, with or without usage, and nothing else", () => {
	const entries: SessionEntry[] = [
		userMessage("u1"),
		assistant("a1", { provider: "acme", model: "widget", usage: usd(0.1) }),
		assistant("a2", {}),
		{
			type: "usage",
			id: "us1",
			parentId: null,
			timestamp: "",
			kind: "classifier",
			provider: "acme",
			model: "widget",
			usage: usd(0.1),
		} as SessionEntry,
	];
	assert.equal(assistantCount(entries), 2);
	assert.equal(assistantCount([]), 0);
});

test("mergeModelSpend with no sources yields an empty map", () => {
	assert.equal(mergeModelSpend().size, 0);
});

test("mergeModelSpend returns row copies so mutating the result leaves its sources untouched", () => {
	const source = usageByModel([assistant("a1", { provider: "acme", model: "widget", usage: usd(0.5) })]);
	const merged = mergeModelSpend(source);
	merged.get("acme/widget")!.costUsd = 99;
	assert.equal(source.get("acme/widget")?.costUsd, 0.5);
});

test("addUsage returns a new record and leaves both operands unchanged", () => {
	const left = usd(0.1);
	const right = usd(0.2);
	const sum = addUsage(left, right);
	assert.notEqual(sum, left);
	assert.equal(left.cost.total, 0.1);
	assert.equal(right.cost.total, 0.2);
	assert.equal(sum.cacheWrite, 4);
});

test("ZERO_USAGE is frozen so a shared zero cannot be corrupted by a caller", () => {
	assert.equal(Object.isFrozen(ZERO_USAGE), true);
	assert.equal(Object.isFrozen(ZERO_USAGE.cost), true);
});

test("collectUsage over an empty branch equals the zero record", () => {
	assert.deepEqual(collectUsage([]), ZERO_USAGE);
});
