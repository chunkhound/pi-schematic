// Pure digest helpers exercised directly on realistic session branches. The host-level
// suite (workflow-state-digest.test.ts) covers the sandbox seam; this suite pins the math.
import assert from "node:assert/strict";
import test from "node:test";
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
	} as SessionEntry;
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
	assert.deepEqual(rows[0], { id: "u0", role: "user", type: "message", text: "start the run", toolNames: [] });
	assert.deepEqual(rows[1], {
		id: "a1",
		role: "assistant",
		type: "message",
		text: "Looking",
		toolNames: ["bash", "read"],
	});
	assert.deepEqual(rows[2]!.toolNames, ["bash"]);
});

test("buildEntryDigests reports summaries as text and other entry types as empty rows", () => {
	const label = { type: "label", id: "l1", parentId: null, timestamp: "", label: "x" } as unknown as SessionEntry;
	const rows = buildEntryDigests([compaction("c1", "summary text"), label], {});
	assert.deepEqual(rows[0], {
		id: "c1",
		role: "compaction",
		type: "compaction",
		text: "summary text",
		toolNames: [],
	});
	assert.deepEqual(rows[1], { id: "l1", role: "label", type: "label", text: "", toolNames: [] });
});

test("buildEntryDigests drops non-text blocks and keeps text blocks in order", () => {
	const entry = message("a1", "assistant", [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "first" },
		{ type: "image", data: "..." },
		{ type: "text", text: "second" },
	]);
	assert.equal(buildEntryDigests([entry], {})[0]!.text, "firstsecond");
});

test("buildEntryDigests accepts plain string content on user messages", () => {
	assert.equal(buildEntryDigests([message("u1", "user", "plain prompt")], {})[0]!.text, "plain prompt");
});

test("buildEntryDigests returns every entry when after is null, undefined, or empty", () => {
	const entries = branchFixture();
	for (const after of [null, undefined, ""]) {
		const rows = buildEntryDigests(entries, { after: after as string | undefined });
		assert.deepEqual(rows.map((row) => row.id), entries.map((entry) => entry.id));
	}
});

test("buildEntryDigests returns only entries strictly after the id", () => {
	const entries = branchFixture();
	assert.deepEqual(
		buildEntryDigests(entries, { after: "u0" }).map((row) => row.id),
		["a1", "t1", "c1", "a2"],
	);
	assert.deepEqual(buildEntryDigests(entries, { after: "a2" }), [], "the last id yields nothing after it");
});

test("buildEntryDigests throws by name on an unknown after id instead of returning the whole branch", () => {
	assert.throws(() => buildEntryDigests(branchFixture(), { after: "typo" }), /unknown after id "typo"/);
});

test("buildEntryDigests applies after before the limit and keeps the newest rows", () => {
	const entries = branchFixture();
	assert.deepEqual(
		buildEntryDigests(entries, { after: "u0" }).map((row) => row.id),
		["a1", "t1", "c1", "a2"],
	);
	assert.deepEqual(
		buildEntryDigests(entries, { after: "u0", limit: 2 }).map((row) => row.id),
		["c1", "a2"],
	);
});

test("buildEntryDigests returns everything when the limit is at least the available count, and nothing at zero", () => {
	const entries = branchFixture();
	assert.equal(buildEntryDigests(entries, { limit: entries.length }).length, entries.length);
	assert.equal(buildEntryDigests(entries, { limit: 999 }).length, entries.length);
	assert.deepEqual(buildEntryDigests(entries, { limit: 0 }), []);
});

test("buildEntryDigests rejects a limit that is not a finite non-negative integer", () => {
	const entries = branchFixture();
	for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => buildEntryDigests(entries, { limit }), /limit must be a non-negative integer/, `limit ${limit}`);
	}
});

test("lastAssistant returns the newest assistant index and message, honouring after", () => {
	const entries = branchFixture();
	const found = lastAssistant(entries);
	assert.equal(found?.index, 4);
	assert.equal(found?.message.role, "assistant");
	assert.equal(lastAssistant(entries, 4), null, "nothing sits after the newest assistant");
	assert.equal(lastAssistant([message("u0", "user", "hi")]), null);
});

test("lastAssistantText returns the newest assistant text, skipping user and tool rows", () => {
	assert.equal(lastAssistantText(branchFixture()), "All done.");
});

test("lastAssistantText returns empty when the newest assistant turn carries only tool calls", () => {
	const entries = [
		message("a1", "assistant", [{ type: "text", text: "earlier" }]),
		message("a2", "assistant", [{ type: "toolCall", name: "bash" }]),
	];
	assert.equal(lastAssistantText(entries), "");
});

test("lastAssistantText returns empty for a branch without assistant messages", () => {
	assert.equal(lastAssistantText([]), "");
	assert.equal(lastAssistantText([message("u0", "user", "hi"), compaction("c1", "summary")]), "");
});

test("lastAssistantModel reports the newest assistant turn's model and thinking level", () => {
	const entries = [
		message("a1", "assistant", [{ type: "text", text: "first" }], { provider: "openai", model: "gpt-6.1-sol" }),
		message("u1", "user", "note"),
		message("a2", "assistant", [{ type: "text", text: "second" }], { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" }),
	];
	assert.deepEqual(lastAssistantModel(entries), { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" });
});

test("lastAssistantModel reports the answering model when the provider fell back to a different one", () => {
	// pi sets responseModel only on a fallback: model names the request, responseModel the answer.
	const entries = [message("a1", "assistant", [{ type: "text", text: "x" }], { provider: "anthropic", model: "claude-sonnet-4-5", responseModel: "claude-sonnet-4-5-20260101" })];
	assert.deepEqual(lastAssistantModel(entries), { provider: "anthropic", model: "claude-sonnet-4-5-20260101" });
});

test("lastAssistantModel omits thinkingLevel when the turn records none and nulls an unrecorded provider", () => {
	const entries = [message("a1", "assistant", [{ type: "text", text: "hi" }], { model: "anonymous-model" })];
	assert.deepEqual(lastAssistantModel(entries), { provider: null, model: "anonymous-model" });
});

test("lastAssistantModel returns null when the final turn named no model or no assistant exists", () => {
	assert.equal(lastAssistantModel([]), null);
	assert.equal(lastAssistantModel([message("u0", "user", "hi")]), null);
	// The final turn is authoritative: an unrecorded model must not borrow an earlier turn's.
	assert.equal(
		lastAssistantModel([
			message("a1", "assistant", [{ type: "text", text: "first" }], { provider: "openai", model: "gpt-6.1-sol" }),
			message("a2", "assistant", [{ type: "text", text: "second" }]),
		]),
		null,
	);
});

test("contextPercentOf passes real percentages through, including zero", () => {
	assert.equal(contextPercentOf({ percent: 0 }), 0);
	assert.equal(contextPercentOf({ percent: 42.5 }), 42.5);
});

test("contextPercentOf reports null when the provider exposed no percent", () => {
	assert.equal(contextPercentOf(undefined), null);
	assert.equal(contextPercentOf({ percent: null }), null);
});

test("contextPercentOf maps a non-finite percent (NaN, Infinity) to null, never to a number", () => {
	assert.equal(contextPercentOf({ percent: Number.NaN }), null);
	assert.equal(contextPercentOf({ percent: Number.POSITIVE_INFINITY }), null);
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
	assert.equal(digest.messageCount, 4, "compaction is not a message");
	assert.equal(digest.lastResponse, "All done.");
});

test("buildStateDigest mirrors scalar inputs unchanged", () => {
	const digest = buildStateDigest(stateInput);
	assert.equal(digest.sessionId, "s1");
	assert.equal(digest.leafId, "a2");
	assert.equal(digest.cost, 0.5);
	assert.equal(digest.contextPercent, 17);
	assert.equal(digest.settledRuns, 3);
	assert.equal(digest.readonly, false);
	assert.equal(digest.notebookTopic, "runtime");
	assert.equal(digest.notebookTopicSource, "human");
});

test("buildStateDigest copies activeTools so later caller mutation cannot change the digest", () => {
	const tools = ["bash"];
	const digest = buildStateDigest({ ...stateInput, activeTools: tools });
	tools.push("write");
	assert.deepEqual(digest.activeTools, ["bash"]);
});

test("buildStateDigest on an empty branch reports zero messages and an empty response", () => {
	const digest = buildStateDigest({ ...stateInput, leafId: null, branch: [], contextPercent: null });
	assert.equal(digest.messageCount, 0);
	assert.equal(digest.lastResponse, "");
	assert.equal(digest.leafId, null);
	assert.equal(digest.contextPercent, null);
});
