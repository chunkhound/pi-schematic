// Pure digest helpers exercised directly on realistic session branches. The host-level
// suite (workflow-state-digest.test.ts) covers the sandbox seam; this suite pins the math.
import { expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildEntryDigests,
	buildStateDigest,
	contextPercentOf,
	lastAssistant,
	lastAssistantModel,
	lastAssistantText,
	type StateDigestInput,
} from "../../workflow/state-digest.js";

function message(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role, content, timestamp: 0, ...extra },
	} as SessionEntry;
}

function compaction(id: string, summary: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		summary,
		firstKeptEntryId: "a1",
		tokensBefore: 100,
	};
}

function branchFixture(): SessionEntry[] {
	return [
		message("u0", "user", "start the run"),
		message("a1", "assistant", [
			{ type: "text", text: "Looking" },
			{ type: "toolCall", name: "bash" },
			{ type: "toolCall", name: "read" },
		]),
		message("t1", "toolResult", [{ type: "text", text: "listing" }], { toolName: "bash" }),
		compaction("c1", "earlier work summarised"),
		message("a2", "assistant", [{ type: "text", text: "All done." }]),
	];
}

test("buildEntryDigests keeps text and names tool calls on assistant and tool-result rows", () => {
	const rows = buildEntryDigests(branchFixture(), {});
	expect(rows[0]).toStrictEqual({ id: "u0", role: "user", type: "message", text: "start the run", toolNames: [] });
	expect(rows[1]).toStrictEqual({
		id: "a1",
		role: "assistant",
		type: "message",
		text: "Looking",
		toolNames: ["bash", "read"],
	});
	expect(rows[2].toolNames).toStrictEqual(["bash"]);
});

test("buildEntryDigests reports summaries as text and other entry types as empty rows", () => {
	const label = { type: "label", id: "l1", parentId: null, timestamp: "", label: "x" } as unknown as SessionEntry;
	const rows = buildEntryDigests([compaction("c1", "summary text"), label], {});
	expect(rows[0]).toStrictEqual({
		id: "c1",
		role: "compaction",
		type: "compaction",
		text: "summary text",
		toolNames: [],
	});
	expect(rows[1]).toStrictEqual({ id: "l1", role: "label", type: "label", text: "", toolNames: [] });
});

test("buildEntryDigests drops non-text blocks and keeps text blocks in order", () => {
	const entry = message("a1", "assistant", [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "first" },
		{ type: "image", data: "..." },
		{ type: "text", text: "second" },
	]);
	expect(buildEntryDigests([entry], {})[0].text).toBe("firstsecond");
});

test("buildEntryDigests accepts plain string content on user messages", () => {
	expect(buildEntryDigests([message("u1", "user", "plain prompt")], {})[0].text).toBe("plain prompt");
});

test("buildEntryDigests returns every entry when after is null, undefined, or empty", () => {
	const entries = branchFixture();
	for (const after of [null, undefined, ""]) {
		const rows = buildEntryDigests(entries, { after: after as string | undefined });
		expect(rows.map((row) => row.id)).toStrictEqual(entries.map((entry) => entry.id));
	}
});

test("buildEntryDigests returns only entries strictly after the id", () => {
	const entries = branchFixture();
	expect(buildEntryDigests(entries, { after: "u0" }).map((row) => row.id)).toStrictEqual(["a1", "t1", "c1", "a2"]);
	expect(buildEntryDigests(entries, { after: "a2" }), "the last id yields nothing after it").toStrictEqual([]);
});

test("buildEntryDigests throws by name on an unknown after id instead of returning the whole branch", () => {
	expect(() => buildEntryDigests(branchFixture(), { after: "typo" })).toThrow(/unknown after id "typo"/);
});

test("buildEntryDigests applies after before the limit and keeps the newest rows", () => {
	const entries = branchFixture();
	expect(buildEntryDigests(entries, { after: "u0" }).map((row) => row.id)).toStrictEqual(["a1", "t1", "c1", "a2"]);
	expect(buildEntryDigests(entries, { after: "u0", limit: 2 }).map((row) => row.id)).toStrictEqual(["c1", "a2"]);
});

test("buildEntryDigests returns everything when the limit is at least the available count, and nothing at zero", () => {
	const entries = branchFixture();
	expect(buildEntryDigests(entries, { limit: entries.length }).length).toBe(entries.length);
	expect(buildEntryDigests(entries, { limit: 999 }).length).toBe(entries.length);
	expect(buildEntryDigests(entries, { limit: 0 })).toStrictEqual([]);
});

test("buildEntryDigests rejects a limit that is not a finite non-negative integer", () => {
	const entries = branchFixture();
	for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => buildEntryDigests(entries, { limit })).toThrow(/limit must be a non-negative integer/);
	}
});

test("lastAssistant returns the newest assistant index and message, honouring after", () => {
	const entries = branchFixture();
	const found = lastAssistant(entries);
	expect(found?.index).toBe(4);
	expect(found?.message.role).toBe("assistant");
	expect(lastAssistant(entries, 4), "nothing sits after the newest assistant").toBeNull();
	expect(lastAssistant([message("u0", "user", "hi")])).toBeNull();
});

test("lastAssistantText returns the newest assistant text, skipping user and tool rows", () => {
	expect(lastAssistantText(branchFixture())).toBe("All done.");
});

test("lastAssistantText returns empty when the newest assistant turn carries only tool calls", () => {
	const entries = [message("a1", "assistant", [{ type: "text", text: "earlier" }]), message("a2", "assistant", [{ type: "toolCall", name: "bash" }])];
	expect(lastAssistantText(entries)).toBe("");
});

test("lastAssistantText returns empty for a branch without assistant messages", () => {
	expect(lastAssistantText([])).toBe("");
	expect(lastAssistantText([message("u0", "user", "hi"), compaction("c1", "summary")])).toBe("");
});

test("lastAssistantModel reports the newest assistant turn's model and thinking level", () => {
	const entries = [
		message("a1", "assistant", [{ type: "text", text: "first" }], { provider: "openai", model: "gpt-6.1-sol" }),
		message("u1", "user", "note"),
		message("a2", "assistant", [{ type: "text", text: "second" }], { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" }),
	];
	expect(lastAssistantModel(entries)).toStrictEqual({ provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" });
});

test("lastAssistantModel reports the answering model when the provider fell back to a different one", () => {
	// pi sets responseModel only on a fallback: model names the request, responseModel the answer.
	const entries = [
		message("a1", "assistant", [{ type: "text", text: "x" }], {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			responseModel: "claude-sonnet-4-5-20260101",
		}),
	];
	expect(lastAssistantModel(entries)).toStrictEqual({ provider: "anthropic", model: "claude-sonnet-4-5-20260101" });
});

test("lastAssistantModel omits thinkingLevel when the turn records none and nulls an unrecorded provider", () => {
	const entries = [message("a1", "assistant", [{ type: "text", text: "hi" }], { model: "anonymous-model" })];
	expect(lastAssistantModel(entries)).toStrictEqual({ provider: null, model: "anonymous-model" });
});

test("lastAssistantModel returns null when the final turn named no model or no assistant exists", () => {
	expect(lastAssistantModel([])).toBeNull();
	expect(lastAssistantModel([message("u0", "user", "hi")])).toBeNull();
	// The final turn is authoritative: an unrecorded model must not borrow an earlier turn's.
	expect(
		lastAssistantModel([
			message("a1", "assistant", [{ type: "text", text: "first" }], { provider: "openai", model: "gpt-6.1-sol" }),
			message("a2", "assistant", [{ type: "text", text: "second" }]),
		]),
	).toBeNull();
});

test("contextPercentOf passes real percentages through, including zero", () => {
	expect(contextPercentOf({ percent: 0 })).toBe(0);
	expect(contextPercentOf({ percent: 42.5 })).toBe(42.5);
});

test("contextPercentOf reports null when the provider exposed no percent", () => {
	expect(contextPercentOf(undefined)).toBeNull();
	expect(contextPercentOf({ percent: null })).toBeNull();
});

test("contextPercentOf maps a non-finite percent (NaN, Infinity) to null, never to a number", () => {
	expect(contextPercentOf({ percent: Number.NaN })).toBeNull();
	expect(contextPercentOf({ percent: Number.POSITIVE_INFINITY })).toBeNull();
});

const stateInput: StateDigestInput = {
	sessionId: "s1",
	leafId: "a2",
	branch: branchFixture(),
	cost: 0.5,
	contextPercent: 17,
	activeTools: ["bash", "read"],
	readonly: false,
	notebookTopic: "runtime",
	notebookTopicSource: "human",
	settledRuns: 3,
};

test("buildStateDigest counts only message entries toward messageCount", () => {
	const digest = buildStateDigest(stateInput);
	expect(digest.messageCount, "compaction is not a message").toBe(4);
	expect(digest.lastResponse).toBe("All done.");
});

test("buildStateDigest mirrors identity and numeric inputs unchanged", () => {
	const digest = buildStateDigest(stateInput);
	expect(digest.sessionId).toBe("s1");
	expect(digest.leafId).toBe("a2");
	expect(digest.cost).toBe(0.5);
	expect(digest.contextPercent).toBe(17);
	expect(digest.settledRuns).toBe(3);
});

test("buildStateDigest mirrors posture inputs unchanged", () => {
	const digest = buildStateDigest(stateInput);
	expect(digest.readonly).toBe(false);
	expect(digest.notebookTopic).toBe("runtime");
	expect(digest.notebookTopicSource).toBe("human");
});

test("buildStateDigest copies activeTools so later caller mutation cannot change the digest", () => {
	const tools = ["bash"];
	const digest = buildStateDigest({ ...stateInput, activeTools: tools });
	tools.push("write");
	expect(digest.activeTools).toStrictEqual(["bash"]);
});

test("buildStateDigest on an empty branch reports zero messages and an empty response", () => {
	const digest = buildStateDigest({ ...stateInput, leafId: null, branch: [], contextPercent: null });
	expect(digest.messageCount).toBe(0);
	expect(digest.lastResponse).toBe("");
	expect(digest.leafId).toBeNull();
	expect(digest.contextPercent).toBeNull();
});
