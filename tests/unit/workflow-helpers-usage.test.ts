// Attribution and accumulation rules of the usage helpers, read through their public
// outputs. Whole-branch totals are covered by usage.test.ts.
import { expect, test } from "vitest";
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
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fixture literal matches SessionMessageEntry without carrying the SDK's full union
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 0, ...fields },
	} as unknown as SessionEntry;
}

function userMessage(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "user", content: "hi", timestamp: 0 },
	};
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
	const spend = usageByModel([assistant("a1", { usage: usd(0.3) })]);
	expect(spend.get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.3);
	expect(spend.get(UNATTRIBUTED_MODEL)?.provider).toBeNull();
});

test("usageByModel keys a provider-less assistant turn by its bare model name", () => {
	const spend = usageByModel([assistant("a1", { model: "widget", usage: usd(0.3) })]);
	expect([...spend.keys()]).toStrictEqual(["widget"]);
});

test("usageByModel ignores turns without usage and entries of other types", () => {
	const spend = usageByModel([assistant("a1", { provider: "acme", model: "widget" }), userMessage("u1")]);
	expect(spend.size).toBe(0);
});

test("usageByModel attributes a tool result without a child model to the unattributed bucket", () => {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fixture literal matches SessionMessageEntry without carrying the SDK's full union
	const toolResult = {
		type: "message",
		id: "t1",
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "toolResult", toolName: "bash", toolCallId: "c1", content: "ok", timestamp: 0, usage: usd(0.4) },
	} as unknown as SessionEntry;
	expect(usageByModel([toolResult]).get(UNATTRIBUTED_MODEL)?.costUsd).toBe(0.4);
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
		},
	];
	expect(assistantCount(entries)).toBe(2);
	expect(assistantCount([])).toBe(0);
});

test("mergeModelSpend with no sources yields an empty map", () => {
	expect(mergeModelSpend().size).toBe(0);
});

test("mergeModelSpend returns row copies so mutating the result leaves its sources untouched", () => {
	const source = usageByModel([assistant("a1", { provider: "acme", model: "widget", usage: usd(0.5) })]);
	const merged = mergeModelSpend(source);
	for (const row of merged.values()) {
		row.costUsd = 99;
	}
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
