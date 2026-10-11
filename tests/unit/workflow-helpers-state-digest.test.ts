// Pure digest helpers exercised directly on realistic session branches. The host-level
// suite (workflow-state-digest.test.ts) covers the sandbox seam; this suite pins the math.
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildEntryDigest,
	buildEntryDigests,
	buildStateDigest,
	contextPercentOf,
	lastAssistantText,
	sliceAfter,
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

test("buildEntryDigest keeps text and names tool calls on assistant and tool-result rows", () => {
	const [user, assistant, toolResult] = branchFixture();
	assert.deepEqual(buildEntryDigest(user!), { id: "u0", role: "user", type: "message", text: "start the run", toolNames: [] });
	assert.deepEqual(buildEntryDigest(assistant!), {
		id: "a1",
		role: "assistant",
		type: "message",
		text: "Looking",
		toolNames: ["bash", "read"],
	});
	assert.deepEqual(buildEntryDigest(toolResult!).toolNames, ["bash"]);
});

test("buildEntryDigest reports summaries as text and other entry types as empty rows", () => {
	assert.deepEqual(buildEntryDigest(compaction("c1", "summary text")), {
		id: "c1",
		role: "compaction",
		type: "compaction",
		text: "summary text",
		toolNames: [],
	});
	const label = { type: "label", id: "l1", parentId: null, timestamp: "", label: "x" } as unknown as SessionEntry;
	assert.deepEqual(buildEntryDigest(label), { id: "l1", role: "label", type: "label", text: "", toolNames: [] });
});

test("buildEntryDigest drops non-text blocks and keeps text blocks in order", () => {
	const entry = message("a1", "assistant", [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "first" },
		{ type: "image", data: "..." },
		{ type: "text", text: "second" },
	]);
	assert.equal(buildEntryDigest(entry).text, "firstsecond");
});

test("buildEntryDigest accepts plain string content on user messages", () => {
	assert.equal(buildEntryDigest(message("u1", "user", "plain prompt")).text, "plain prompt");
});

test("sliceAfter returns every entry when the id is null, undefined, or empty", () => {
	const entries = [{ id: "a" }, { id: "b" }];
	for (const afterId of [null, undefined, ""]) {
		const sliced = sliceAfter(entries, afterId);
		assert.deepEqual(sliced, entries);
		assert.notEqual(sliced, entries, "returns a copy, not the caller's array");
	}
});

test("sliceAfter returns only entries strictly after the id", () => {
	const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
	assert.deepEqual(sliceAfter(entries, "a"), [{ id: "b" }, { id: "c" }]);
	assert.deepEqual(sliceAfter(entries, "c"), [], "the last id yields nothing after it");
});

test("sliceAfter throws by name on an unknown id instead of returning the whole branch", () => {
	assert.throws(() => sliceAfter([{ id: "a" }], "typo"), /unknown after id "typo"/);
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
