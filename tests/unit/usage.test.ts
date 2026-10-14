// SSOT contract: one cost derivation feeds every surface, and the run's child ledger
// owns each child's spend exactly once.
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	UNATTRIBUTED_MODEL,
	addUsage,
	childSpendRows,
	collectUsage,
	mergeModelSpend,
	sessionStatsToUsage,
	spendRowsTotal,
	usageByModel,
	ZERO_USAGE,
	type ChildSpend,
} from "../../usage.js";

const usd = (total: number): Usage => ({
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function assistant(id: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 0, usage: usd(total) },
	} as SessionEntry;
}

test("addUsage sums every usage field including cost", () => {
	const total = addUsage(ZERO_USAGE, usd(0.5));
	assert.equal(total.input, 10);
	assert.equal(total.cost.total, 0.5);
	assert.deepEqual(addUsage(total, usd(0.25)).cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 });
});

test("collectUsage reads usage entries, assistant messages, and tool results", () => {
	const entries: SessionEntry[] = [
		{
			type: "usage",
			id: "us1",
			parentId: null,
			timestamp: "",
			kind: "classifier",
			provider: "p",
			model: "m",
			usage: usd(0.1),
		} as SessionEntry,
		modelAssistant("a1", "p", "m", 0.2),
		childToolResult("t1", "c1", 0.3),
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-10-07T00:00:02.000Z",
			message: { role: "user", content: "no usage", timestamp: 0 },
		} as SessionEntry,
	];
	assert.ok(Math.abs(collectUsage(entries).cost.total - 0.6) < 1e-9);
});

test("sessionStatsToUsage reads token totals and the authoritative session cost", () => {
	const usage = sessionStatsToUsage({
		tokens: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, total: 18 },
		cost: 0.42,
	});
	assert.equal(usage.totalTokens, 18);
	assert.equal(usage.cost.total, 0.42);
});

function modelAssistant(id: string, provider: string, model: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "assistant", provider, model, content: [{ type: "text", text: "x" }], timestamp: 0, usage: usd(total) },
	} as SessionEntry;
}

function childToolResult(id: string, toolCallId: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "toolResult", toolName: "spawn", toolCallId, content: "done", timestamp: 0, usage: usd(total), details: { model: "haiku", route: { provider: "anthropic" } } },
	} as unknown as SessionEntry;
}

// SSOT contract: the overview's spend rows come from the same entries as collectUsage,
// so every model is named and the rows sum to the authoritative total.
test("usageByModel attributes assistant, usage-entry, spawned-child, and model-less spend", () => {
	const entries: SessionEntry[] = [
		modelAssistant("a1", "anthropic", "opus", 0.5),
		{
			type: "usage",
			id: "u1",
			parentId: null,
			timestamp: "2026-10-07T00:00:01.000Z",
			kind: "cache_warm",
			provider: "typesafe",
			model: "jev",
			usage: usd(0.1),
		} as SessionEntry,
		childToolResult("t1", "c1", 0.2),
		{
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "2026-10-07T00:00:03.000Z",
			summary: "sum",
			firstKeptEntryId: "a1",
			tokensBefore: 1,
			usage: usd(0.05),
		} as SessionEntry,
	];
	const spend = usageByModel(entries);
	assert.equal(spend.get("anthropic/opus")?.costUsd, 0.5);
	assert.equal(spend.get("typesafe/jev")?.costUsd, 0.1);
	assert.equal(spend.get("anthropic/haiku")?.costUsd, 0.2);
	assert.equal(spend.get(UNATTRIBUTED_MODEL)?.costUsd, 0.05);
	// The rows partition the branch's usage exactly.
	const sum = [...spend.values()].reduce((total, row) => total + row.costUsd, 0);
	assert.ok(Math.abs(sum - collectUsage(entries).cost.total) < 1e-9, "rows sum to collected usage");
});

// SSOT contract: the child ledger is the single owner of child-owned tool results, so
// `usageByModel` must skip exactly the tool calls the ledger already folds.
test("usageByModel skips a child-owned tool result when claimed, and counts it otherwise", () => {
	const entries: SessionEntry[] = [childToolResult("t1", "c1", 0.2)];
	const claimed = usageByModel(entries, { skip: new Set(["c1"]) });
	assert.equal(claimed.size, 0, "claimed child tool result is excluded");

	const unclaimed = usageByModel(entries);
	assert.equal(unclaimed.get("anthropic/haiku")?.costUsd, 0.2, "unclaimed tool result is attributed");
});

// SSOT contract: the run-scoped spend scan drops the conversation that predates the run,
// so only entries kept by the run's id-exclusion set reach the cost rows.
test("usageByModel omits every entry whose id is excluded", () => {
	const entries: SessionEntry[] = [
		modelAssistant("a1", "anthropic", "opus", 0.5),
		modelAssistant("a2", "anthropic", "opus", 0.25),
	];
	const kept = usageByModel(entries, { skip: new Set(["a1"]) });
	assert.equal(kept.get("anthropic/opus")?.costUsd, 0.25, "excluded entry is omitted");
	assert.equal(kept.get("anthropic/opus")?.calls, 1);
	assert.equal(usageByModel(entries).get("anthropic/opus")?.costUsd, 0.75, "omitting the option keeps every entry");
});

// SSOT contract: each child contributes one call, and repeated model rows merge.
test("childSpendRows merges children by model with one call each", () => {
	const children = new Map<string, ChildSpend>([
		["c1", { provider: "anthropic", model: "opus", usage: usd(0.5) }],
		["c2", { provider: "anthropic", model: "opus", usage: usd(0.25) }],
		["c3", { provider: null, model: "widget", usage: usd(0.4) }],
	]);
	const rows = childSpendRows(children);
	assert.equal(rows.get("anthropic/opus")?.costUsd, 0.75);
	assert.equal(rows.get("anthropic/opus")?.calls, 2, "one call per child");
	assert.equal(rows.get("widget")?.costUsd, 0.4);
	assert.equal(rows.get("widget")?.provider, null);
});

test("spendRowsTotal equals the exact row sum", () => {
	const rows = childSpendRows(
		new Map<string, ChildSpend>([
			["c1", { provider: "anthropic", model: "opus", usage: usd(0.5) }],
			["c2", { provider: null, model: "widget", usage: usd(0.4) }],
		]),
	);
	assert.ok(Math.abs(spendRowsTotal(rows) - 0.9) < 1e-9);
	assert.equal(spendRowsTotal(new Map()), 0);
});

test("mergeModelSpend sums rows from every source without mutating its inputs", () => {
	const baseline = usageByModel([modelAssistant("a1", "anthropic", "opus", 0.5)]);
	const current = usageByModel([modelAssistant("a2", "anthropic", "opus", 0.25), modelAssistant("a3", "typesafe", "jev", 0.1)]);
	const merged = mergeModelSpend(baseline, current);
	assert.equal(merged.get("anthropic/opus")?.costUsd, 0.75);
	assert.equal(merged.get("anthropic/opus")?.calls, 2);
	assert.equal(merged.get("typesafe/jev")?.costUsd, 0.1);
	assert.equal(baseline.get("anthropic/opus")?.costUsd, 0.5, "input map untouched");
});
