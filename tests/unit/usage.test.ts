// SSOT contract: one cost derivation feeds every surface, and the run's child ledger
// owns each child's spend exactly once.
import { expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	UNATTRIBUTED_MODEL,
	addModelSpend,
	addUsage,
	collectUsage,
	mergeModelSpend,
	sessionStatsToUsage,
	spendRowsTotal,
	usageByModel,
	ZERO_USAGE,
	type ModelSpend,
} from "../../usage.js";

const usd = (total: number): Usage => ({
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function modelAssistant(id: string, provider: string, model: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
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

function childToolResult(id: string, toolCallId: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolName: "spawn",
			toolCallId,
			content: [{ type: "text", text: "done" }],
			details: { model: "haiku", route: { provider: "anthropic" } },
			isError: false,
			timestamp: 0,
			usage: usd(total),
		},
	};
}

test("addUsage sums every usage field including cost", () => {
	const total = addUsage(ZERO_USAGE, usd(0.5));
	expect(total.input).toBe(10);
	expect(total.cost.total).toBe(0.5);
	expect(addUsage(total, usd(0.25)).cost).toStrictEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 });
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
		},
		modelAssistant("a1", "p", "m", 0.2),
		childToolResult("t1", "c1", 0.3),
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-10-07T00:00:02.000Z",
			message: { role: "user", content: "no usage", timestamp: 0 },
		},
	];
	expect(collectUsage(entries).cost.total).toBeCloseTo(0.6, 9);
});

test("sessionStatsToUsage reads token totals and the authoritative session cost", () => {
	const usage = sessionStatsToUsage({
		tokens: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, total: 18 },
		cost: 0.42,
	});
	expect(usage.totalTokens).toBe(18);
	expect(usage.cost.total).toBe(0.42);
});

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
		},
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
		},
	];
	const spend = usageByModel(entries);
	expect(spend.get("anthropic/opus")?.costUsd).toBe(0.5);
	expect(spend.get("typesafe/jev")?.costUsd).toBe(0.1);
	expect(spend.get("anthropic/haiku")?.costUsd).toBe(0.2);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.05);
	// The rows partition the branch's usage exactly.
	const sum = [...spend.values()].reduce((total, row) => total + row.costUsd, 0);
	expect(sum, "rows sum to collected usage").toBeCloseTo(collectUsage(entries).cost.total, 9);
});

// SSOT contract: the child ledger is the single owner of child-owned tool results, so
// `usageByModel` must skip exactly the tool calls the ledger already folds.
test("usageByModel skips a child-owned tool result when claimed, and counts it otherwise", () => {
	const entries: SessionEntry[] = [childToolResult("t1", "c1", 0.2)];
	const claimed = usageByModel(entries, { skip: new Set(["c1"]) });
	expect(claimed.size, "claimed child tool result is excluded").toBe(0);

	const unclaimed = usageByModel(entries);
	expect(unclaimed.get("anthropic/haiku")?.costUsd, "unclaimed tool result is attributed").toBe(0.2);
});

// SSOT contract: an empty entry id is never matched against `skip` (only a non-empty id
// or the tool-call id can claim an entry), preserving spendIdentity's fallback.
test("usageByModel ignores an empty entry id and skips by tool-call id only", () => {
	const entries: SessionEntry[] = [childToolResult("", "c1", 0.2)];
	expect(usageByModel(entries, { skip: new Set(["c1"]) }).size, "empty-id entry skipped via tool-call id").toBe(0);
	expect(usageByModel(entries, { skip: new Set([""]) }).get("anthropic/haiku")?.costUsd, "empty id is never matched").toBe(0.2);
	expect(usageByModel(entries).get("anthropic/haiku")?.costUsd, "unclaimed empty-id entry attributed").toBe(0.2);
});

// SSOT contract: the run-scoped spend scan drops the conversation that predates the run,
// so only entries kept by the run's id-exclusion set reach the cost rows.
test("usageByModel omits every entry whose id is excluded", () => {
	const entries: SessionEntry[] = [modelAssistant("a1", "anthropic", "opus", 0.5), modelAssistant("a2", "anthropic", "opus", 0.25)];
	const kept = usageByModel(entries, { skip: new Set(["a1"]) });
	expect(kept.get("anthropic/opus")?.costUsd, "excluded entry is omitted").toBe(0.25);
	expect(kept.get("anthropic/opus")?.calls).toBe(1);
	expect(usageByModel(entries).get("anthropic/opus")?.costUsd, "omitting the option keeps every entry").toBe(0.75);
});

test("spendRowsTotal equals the exact row sum", () => {
	const rows = new Map<string, ModelSpend>();
	addModelSpend(rows, "anthropic", "opus", usd(0.5));
	addModelSpend(rows, null, "widget", usd(0.4));
	expect(spendRowsTotal(rows)).toBeCloseTo(0.9, 9);
	expect(spendRowsTotal(new Map())).toBe(0);
});

test("mergeModelSpend sums rows from every source without mutating its inputs", () => {
	const baseline = usageByModel([modelAssistant("a1", "anthropic", "opus", 0.5)]);
	const current = usageByModel([modelAssistant("a2", "anthropic", "opus", 0.25), modelAssistant("a3", "typesafe", "jev", 0.1)]);
	const merged = mergeModelSpend(baseline, current);
	expect(merged.get("anthropic/opus")?.costUsd).toBe(0.75);
	expect(merged.get("anthropic/opus")?.calls).toBe(2);
	expect(merged.get("typesafe/jev")?.costUsd).toBe(0.1);
	expect(baseline.get("anthropic/opus")?.costUsd, "input map untouched").toBe(0.5);
});
