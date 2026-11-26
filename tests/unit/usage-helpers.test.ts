// Attribution and accumulation rules of the usage helpers, read through their public
// outputs. Whole-branch totals are covered by usage.test.ts.
import { expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { UNATTRIBUTED_MODEL, addModelSpend, addUsage, assistantCount, collectUsage, mergeModelSpend, usageByModel, type ModelSpend } from "../../usage.js";
import { collectSessionAccounting } from "../../usage.js";
import { SPAWN_TOOL_NAME } from "../../spawn/shared.js";
import { assistantMessageEntry, messageEntry, toolResultEntry, usageFixtureUsd } from "./helpers.js";

function userMessage(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "user", content: "hi", timestamp: 0 },
	};
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
	addModelSpend(map, null, "widget", usageFixtureUsd(0.1));
	addModelSpend(map, "acme", "widget", usageFixtureUsd(0.2));
	expect(map.get("widget")?.costUsd).toBe(0.1);
	expect(map.get("acme/widget")?.costUsd).toBe(0.2);
	expect(map.get("acme/widget")?.provider).toBe("acme");
});

test("addModelSpend accumulates every field and counts one call per usage record", () => {
	const map = new Map<string, ModelSpend>();
	addModelSpend(map, "acme", "widget", usageFixtureUsd(0.1));
	addModelSpend(map, "acme", "widget", usageFixtureUsd(0.2));
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

test("usageByModel keys a provider-less tool result by its bare model name", () => {
	const spend = usageByModel([toolResultEntry("t1", { model: "widget", usage: usageFixtureUsd(0.3) })]);
	expect([...spend.keys()]).toStrictEqual(["widget"]);
});

test("usageByModel ignores turns without usage and entries of other types", () => {
	const spend = usageByModel([toolResultEntry("t1"), userMessage("u1")]);
	expect(spend.size).toBe(0);
});

// Parity guard: the spend rows and the amount walk classify the same entries identically, so
// every field sums from the rows to the collected totals across the same accepted entries.
test("row sums match collected usage field-for-field across every usage-bearing entry kind", () => {
	const entries: SessionEntry[] = [
		assistantMessageEntry("a1", "anthropic", "opus", 0.5),
		{ type: "usage", id: "u1", parentId: null, timestamp: "", kind: "classifier", provider: "p", model: "m", usage: usageFixtureUsd(0.1) },
		toolResultEntry("t1", { usage: usageFixtureUsd(0.2), model: "haiku", provider: "anthropic", toolCallId: "c1" }),
		{ type: "compaction", id: "comp1", parentId: null, timestamp: "", summary: "s", firstKeptEntryId: "a1", tokensBefore: 1, usage: usageFixtureUsd(0.05) },
		{ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "", fromId: "a1", summary: "s", usage: usageFixtureUsd(0.25) },
	];
	const spend = usageByModel(entries);
	const raw = collectUsage(entries);
	const rows = [...spend.values()];
	const sum = (field: "costUsd" | "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
		rows.reduce((total, row) => total + row[field], 0);
	expect(sum("costUsd")).toBeCloseTo(raw.cost.total, 9);
	expect([sum("totalTokens"), sum("inputTokens"), sum("outputTokens"), sum("cacheReadTokens"), sum("cacheWriteTokens")]).toStrictEqual([
		raw.totalTokens,
		raw.input,
		raw.output,
		raw.cacheRead,
		raw.cacheWrite,
	]);
});

// A hostile spawn result whose route accessor throws must not break the amount walk; row
// attribution degrades to the unattributed bucket instead of failing the overview.
test("collectUsage survives a throwing spawn details.route getter; usageByModel degrades to unattributed", () => {
	const entry = messageEntry("t1", {
		role: "toolResult",
		toolName: SPAWN_TOOL_NAME,
		toolCallId: "c1",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
		usage: usageFixtureUsd(0.4),
		details: {
			model: "haiku",
			get route() {
				throw new Error("route getter exploded");
			},
		},
	});
	expect(collectUsage([entry]).cost.total).toBeCloseTo(0.4, 9);
	expect(collectSessionAccounting([entry]).usage.cost.total).toBeCloseTo(0.4, 9);
	const spend = usageByModel([entry]);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBeCloseTo(0.4, 9);
	expect(spend.has("anthropic/haiku")).toBe(false);
});

test("usageByModel attributes a tool result without a child model to the unattributed bucket", () => {
	// pi's assistant message type always carries provider/model, so the unattributed
	// fallback is exercised through a model-less tool result instead.
	const spend = usageByModel([toolResultEntry("t1", { usage: usageFixtureUsd(0.4) })]);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.4);
	expect(spend.get(UNATTRIBUTED_MODEL)?.provider).toBeNull();
});

test("assistantCount counts every assistant message, with or without usage, and nothing else", () => {
	const entries: SessionEntry[] = [
		userMessage("u1"),
		assistantMessageEntry("a1", "acme", "widget", 0.1),
		assistantMessageEntry("a2", "acme", "widget", 0.2),
		{
			type: "usage",
			id: "us1",
			parentId: null,
			timestamp: "",
			kind: "classifier",
			provider: "acme",
			model: "widget",
			usage: usageFixtureUsd(0.1),
		},
	];
	expect(assistantCount(entries)).toBe(2);
	expect(assistantCount([])).toBe(0);
});

test("mergeModelSpend with no sources yields an empty map", () => {
	expect(mergeModelSpend().size).toBe(0);
});

test("mergeModelSpend returns row copies so mutating the result leaves its sources untouched", () => {
	const source = usageByModel([assistantMessageEntry("a1", "acme", "widget", 0.5)]);
	const merged = mergeModelSpend(source);
	requireRow(merged, "acme/widget").costUsd = 99;
	expect(source.get("acme/widget")?.costUsd).toBe(0.5);
});

test("addUsage returns a new record and leaves both operands unchanged", () => {
	const left = usageFixtureUsd(0.1);
	const right = usageFixtureUsd(0.2);
	const sum = addUsage(left, right);
	expect(sum).not.toBe(left);
	expect(left.cost.total).toBe(0.1);
	expect(right.cost.total).toBe(0.2);
	expect(sum.cacheWrite).toBe(4);
});
