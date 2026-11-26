// SSOT contract: one cost derivation feeds every surface, and the run's child ledger
// owns each child's spend exactly once.
import { expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	UNATTRIBUTED_MODEL,
	ZERO_USAGE,
	addModelSpend,
	addUsage,
	collectUsage,
	mergeModelSpend,
	sessionStatsToUsage,
	spendIdentity,
	spendRowsTotal,
	usageByModel,
	zeroUsage,
	type ModelSpend,
	type SessionStatsLike,
} from "../../usage.js";
import { assistantMessageEntry, toolResultEntry, usageFixtureUsd } from "./helpers.js";

test("addUsage sums every usage field including cost", () => {
	const total = addUsage(zeroUsage(), usageFixtureUsd(0.5));
	expect(total.input).toBe(10);
	expect(total.cost.total).toBe(0.5);
	expect(addUsage(total, usageFixtureUsd(0.25)).cost).toStrictEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 });
});

test("addUsage preserves the optional reasoning and cacheWrite1h splits", () => {
	const split = { ...usageFixtureUsd(0.1), reasoning: 7, cacheWrite1h: 3 };
	const sum = addUsage(split, usageFixtureUsd(0.2));
	expect(sum.reasoning).toBe(7);
	expect(sum.cacheWrite1h).toBe(3);
	expect(addUsage(zeroUsage(), split).reasoning).toBe(7);
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
			usage: usageFixtureUsd(0.1),
		},
		assistantMessageEntry("a1", "p", "m", 0.2),
		toolResultEntry("t1", { usage: usageFixtureUsd(0.3), model: "haiku", provider: "anthropic", toolCallId: "c1" }),
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

test("collectUsage preserves the optional reasoning and cacheWrite1h splits across entries", () => {
	const entries: SessionEntry[] = [
		{
			type: "usage",
			id: "us2",
			parentId: null,
			timestamp: "",
			kind: "classifier",
			provider: "p",
			model: "m",
			usage: { ...usageFixtureUsd(0.1), reasoning: 7, cacheWrite1h: 3 },
		},
	];
	const total = collectUsage(entries);
	expect(total.reasoning).toBe(7);
	expect(total.cacheWrite1h).toBe(3);
});

test("collectUsage over an empty branch returns a fresh zero a caller may mutate", () => {
	const empty = collectUsage([]);
	expect(empty).toStrictEqual(zeroUsage());
	empty.input = 42;
	expect(collectUsage([]).input).toBe(0);
});

test("sessionStatsToUsage reads token totals and the authoritative session cost", () => {
	const usage = sessionStatsToUsage({
		sessionFile: undefined,
		sessionId: "s1",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
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
		assistantMessageEntry("a1", "anthropic", "opus", 0.5),
		{
			type: "usage",
			id: "u1",
			parentId: null,
			timestamp: "2026-10-07T00:00:01.000Z",
			kind: "cache_warm",
			provider: "typesafe",
			model: "jev",
			usage: usageFixtureUsd(0.1),
		},
		toolResultEntry("t1", { usage: usageFixtureUsd(0.2), model: "haiku", provider: "anthropic", toolCallId: "c1" }),
		{
			type: "compaction",
			id: "comp1",
			parentId: null,
			timestamp: "2026-10-07T00:00:03.000Z",
			summary: "sum",
			firstKeptEntryId: "a1",
			tokensBefore: 1,
			usage: usageFixtureUsd(0.05),
		},
	];
	const spend = usageByModel(entries);
	expect(spend.get("anthropic/opus")?.costUsd).toBe(0.5);
	expect(spend.get("typesafe/jev")?.costUsd).toBe(0.1);
	expect(spend.get("anthropic/haiku")?.costUsd).toBe(0.2);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.05);
	// The rows partition the branch's usage exactly (full-field parity lives in usage-helpers.test.ts).
	const sum = [...spend.values()].reduce((total, row) => total + row.costUsd, 0);
	expect(sum, "rows sum to collected usage").toBeCloseTo(collectUsage(entries).cost.total, 9);
});

// SSOT contract: the child ledger is the single owner of child-owned tool results, so
// `usageByModel` must skip exactly the tool calls the ledger already folds.
test("usageByModel skips a child-owned tool result when claimed, and counts it otherwise", () => {
	const entries: SessionEntry[] = [toolResultEntry("t1", { usage: usageFixtureUsd(0.2), model: "haiku", provider: "anthropic", toolCallId: "c1" })];
	const claimed = usageByModel(entries, { skip: new Set(["c1"]) });
	expect(claimed.size, "claimed child tool result is excluded").toBe(0);

	const unclaimed = usageByModel(entries);
	expect(unclaimed.get("anthropic/haiku")?.costUsd, "unclaimed tool result is attributed").toBe(0.2);
});

// SSOT contract: an empty entry id is never matched against `skip` (only a non-empty id
// or the tool-call id can claim an entry).
test("usageByModel ignores an empty entry id and skips by tool-call id only", () => {
	const entries: SessionEntry[] = [toolResultEntry("", { usage: usageFixtureUsd(0.2), model: "haiku", provider: "anthropic", toolCallId: "c1" })];
	const bare = [toolResultEntry("", { usage: usageFixtureUsd(0.3), model: "haiku", provider: "anthropic", toolCallId: "" })];
	expect(usageByModel(entries, { skip: new Set(["c1"]) }).size, "empty-id entry skipped via tool-call id").toBe(0);
	expect(usageByModel(entries, { skip: new Set([""]) }).get("anthropic/haiku")?.costUsd, "empty id is never matched").toBe(0.2);
	expect(usageByModel(entries).get("anthropic/haiku")?.costUsd, "unclaimed empty-id entry attributed").toBe(0.2);
	expect(usageByModel(bare, { skip: new Set([""]) }).get("anthropic/haiku")?.costUsd, "an empty skip key never suppresses a usage-bearing tool row").toBe(0.3);
});

// SSOT contract: spendIdentity owns the entry-id/tool-call-id rule, and isClaimed routes
// through it, so the run-scoped scan and the child ledger cannot drift on what claims an entry.
test("spendIdentity yields the entry id, else the tool-call id", () => {
	expect(spendIdentity(assistantMessageEntry("a1", "anthropic", "opus", 0.5))).toBe("a1");
	expect(spendIdentity(toolResultEntry("t1", { toolCallId: "c1" }))).toBe("t1");
	expect(
		spendIdentity({ type: "usage", id: "", parentId: null, timestamp: "", kind: "classifier", provider: "p", model: "m", usage: usageFixtureUsd(0.1) }),
	).toBeNull();
	expect(spendIdentity(toolResultEntry("", { toolCallId: "c1" }))).toBe("c1");
	expect(spendIdentity(toolResultEntry("", { toolCallId: "" }))).toBeNull();
});

test("usageByModel claims exactly the identities spendIdentity reports", () => {
	const entries: SessionEntry[] = [
		assistantMessageEntry("a1", "anthropic", "opus", 0.5),
		toolResultEntry("t1", { usage: usageFixtureUsd(0.2), model: "haiku", provider: "anthropic", toolCallId: "c1" }),
	];
	expect(usageByModel(entries, { skip: new Set(["a1"]) }).get("anthropic/opus"), "entry id claims the assistant turn").toBeUndefined();
	expect(usageByModel(entries, { skip: new Set(["c1"]) }).get("anthropic/haiku"), "tool-call id claims the tool result").toBeUndefined();
	expect(usageByModel(entries, { skip: new Set(["a1", "c1"]) }).size, "both identities are honored").toBe(0);
});

test("assistant responseModel and child spend collapse onto one effective-model row", () => {
	const entries: SessionEntry[] = [
		assistantMessageEntry("a1", "p", "alias", 0.5, "resolved"),
		toolResultEntry("t1", { usage: usageFixtureUsd(0.3), model: "resolved", provider: "p", toolCallId: "c1" }),
	];
	const spend = usageByModel(entries);
	expect(spend.get("p/resolved")?.costUsd).toBeCloseTo(0.8, 9);
	expect(spend.get("p/resolved")?.calls).toBe(2);
	expect(spend.has("p/alias"), "requested alias must not split the row").toBe(false);
});

test("usageByModel attributes an assistant turn by its response model, falling back to model", () => {
	const spend = usageByModel([assistantMessageEntry("a1", "anthropic", "opus", 0.5, "haiku"), assistantMessageEntry("a2", "typesafe", "jev", 0.25)]);
	expect(spend.get("anthropic/haiku")?.costUsd).toBe(0.5);
	expect(spend.get("anthropic/opus")).toBeUndefined();
	expect(spend.get("typesafe/jev")?.costUsd).toBe(0.25);
});

test("usageByModel keys an empty provider by bare model name", () => {
	const spend = usageByModel([assistantMessageEntry("a1", "", "opus", 0.5)]);
	expect([...spend.keys()]).toStrictEqual(["opus"]);
	expect(spend.get("opus")?.provider).toBeNull();
	expect(spend.get("/opus")).toBeUndefined();
});

test("usageByModel attributes a branch summary's usage and ignores one without usage", () => {
	const withUsage: SessionEntry[] = [
		{ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-10-07T00:00:04.000Z", fromId: "a1", summary: "s", usage: usageFixtureUsd(0.05) },
	];
	const spend = usageByModel(withUsage);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.05);
	expect(usageByModel([{ type: "branch_summary", id: "b2", parentId: "c1", timestamp: "", fromId: "a1", summary: "s" }]).size).toBe(0);
});

test("usageByModel treats a non-spawn tool result as unattributed even with model details", () => {
	const entries: SessionEntry[] = [toolResultEntry("t1", { toolName: "other", usage: usageFixtureUsd(0.2), model: "haiku", provider: "anthropic" })];
	const spend = usageByModel(entries);
	expect(spend.get("anthropic/haiku")).toBeUndefined();
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.2);
});

// SSOT contract: the run-scoped spend scan drops the conversation that predates the run,
// so only entries kept by the run's id-exclusion set reach the cost rows.
test("usageByModel omits every entry whose id is excluded", () => {
	const entries: SessionEntry[] = [assistantMessageEntry("a1", "anthropic", "opus", 0.5), assistantMessageEntry("a2", "anthropic", "opus", 0.25)];
	const kept = usageByModel(entries, { skip: new Set(["a1"]) });
	expect(kept.get("anthropic/opus")?.costUsd, "excluded entry is omitted").toBe(0.25);
	expect(kept.get("anthropic/opus")?.calls).toBe(1);
	expect(usageByModel(entries).get("anthropic/opus")?.costUsd, "omitting the option keeps every entry").toBe(0.75);
});

test("spendRowsTotal equals the exact row sum", () => {
	const rows = new Map<string, ModelSpend>();
	addModelSpend(rows, "anthropic", "opus", usageFixtureUsd(0.5));
	addModelSpend(rows, null, "widget", usageFixtureUsd(0.4));
	expect(spendRowsTotal(rows)).toBeCloseTo(0.9, 9);
	expect(spendRowsTotal(new Map())).toBe(0);
});

test("mergeModelSpend sums rows from every source without mutating its inputs", () => {
	const baseline = usageByModel([assistantMessageEntry("a1", "anthropic", "opus", 0.5)]);
	const current = usageByModel([assistantMessageEntry("a2", "anthropic", "opus", 0.25), assistantMessageEntry("a3", "typesafe", "jev", 0.1)]);
	const merged = mergeModelSpend(baseline, current);
	expect(merged.get("anthropic/opus")?.costUsd).toBe(0.75);
	expect(merged.get("anthropic/opus")?.calls).toBe(2);
	expect(merged.get("typesafe/jev")?.costUsd).toBe(0.1);
	expect(baseline.get("anthropic/opus")?.costUsd, "input map untouched").toBe(0.5);
});

// SSOT contract: the merged run ledger never splits one model across two rows. The sink's rows and
// the parent branch scan key by provider/model, so a child and its parent that share a model collapse
// onto one row; a single owner means the run overview can sum rows without double-counting.
test("mergeModelSpend keeps one row per model when sink rows and parent entries collide", () => {
	const sinkRows = new Map<string, ModelSpend>();
	addModelSpend(sinkRows, "anthropic", "opus", usageFixtureUsd(0.2));
	addModelSpend(sinkRows, "anthropic", "opus", usageFixtureUsd(0.1));
	const merged = mergeModelSpend(sinkRows, usageByModel([assistantMessageEntry("a1", "anthropic", "opus", 0.5)]));
	expect(merged.get("anthropic/opus")?.costUsd).toBeCloseTo(0.8, 9);
	expect(merged.get("anthropic/opus")?.calls).toBe(3);
	expect([...merged.values()].filter((row) => row.key === "anthropic/opus")).toHaveLength(1);
});

// Cross-repo compatibility: the workflow host imports these names, so they stay resolvable
// and behave even though the module now centers on zeroUsage()/SessionStats.
test("compat exports: ZERO_USAGE, SessionStatsLike and sessionStatsToUsage", () => {
	expect(Object.isFrozen(ZERO_USAGE)).toBe(true);
	expect(ZERO_USAGE).toStrictEqual(zeroUsage());
	// The alias is deprecated on purpose; this compat test is its one sanctioned consumer.
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- this compat test is the alias's one sanctioned consumer
	const stats: SessionStatsLike = {
		sessionFile: undefined,
		sessionId: "s",
		userMessages: 0,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 1,
		tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 18 },
		cost: 0.5,
	};
	expect(sessionStatsToUsage(stats)).toMatchObject({ input: 10, totalTokens: 18, cost: { total: 0.5 } });
});
