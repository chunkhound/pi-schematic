import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { createRunRegistry, matchRun, resolveRunTarget } from "../../workflow/run-registry.js";

const commands = [
	{ name: "review", source: "prompt", sourceInfo: {} },
	{ name: "skill:execute", source: "skill", sourceInfo: {} },
	{ name: "danger", source: "extension", sourceInfo: {} },
] as unknown as SlashCommandInfo[];

test("resolveRunTarget keeps prompt templates and normalizes skills to skill:<name>", () => {
	assert.deepEqual(resolveRunTarget(commands, "/review"), { text: "/review", source: "prompt" });
	assert.deepEqual(resolveRunTarget(commands, "/execute"), { text: "/skill:execute", source: "skill" });
	assert.deepEqual(resolveRunTarget(commands, "execute"), { text: "/skill:execute", source: "skill" });
	assert.deepEqual(resolveRunTarget(commands, "/skill:execute"), { text: "/skill:execute", source: "skill" });
});

test("resolveRunTarget rejects extension commands", () => {
	assert.throws(() => resolveRunTarget(commands, "/danger"), /extension command/);
});

test("resolveRunTarget leaves unknown prompts as plain text and preserves inline arguments", () => {
	assert.deepEqual(resolveRunTarget(commands, "just a prompt"), { text: "just a prompt", source: "plain" });
	assert.deepEqual(resolveRunTarget(commands, "/review foo bar"), { text: "/review foo bar", source: "prompt" });
	assert.deepEqual(resolveRunTarget(commands, "/unknown x"), { text: "/unknown x", source: "plain" });
});

function message(id: string, role: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: { role, content: "", timestamp: 0 },
	} as SessionEntry;
}

test("matchRun includes the complete settled run after the marker", () => {
	const branch = [message("u0", "user"), message("a1", "assistant"), message("t1", "toolResult"), message("a2", "assistant")];
	assert.deepEqual(matchRun(branch, "u0"), { fromEntryId: "a1", toEntryId: "a2", branch: branch.slice(1) });
	assert.deepEqual(matchRun(branch, null)?.toEntryId, "a2");
	assert.equal(matchRun(branch, "missing"), null);
});

test("pending correlation resolves when the branch settles", async () => {
	let settle: (() => void) | undefined;
	const registry = createRunRegistry({
		onSettled: (listener) => {
			settle = listener;
			return () => {};
		},
		getBranch: () => [message("a1", "assistant")],
	});
	const pending = registry.correlate(null);
	settle?.();
	const match = await pending.promise;
	assert.equal(match.toEntryId, "a1");
	registry.dispose();
});

test("registry disposal rejects pending correlations and removes the settled listener", async () => {
	let removed = 0;
	const registry = createRunRegistry({
		onSettled: () => () => { removed += 1; },
		getBranch: () => [],
	});
	const pending = registry.correlate(null);
	registry.dispose();
	await assert.rejects(pending.promise, /disposed/);
	registry.dispose();
	assert.equal(removed, 1);
});

test("matchRun returns null until an assistant entry appears after the marker", () => {
	const branch = [message("u0", "user"), message("t1", "toolResult")];
	assert.equal(matchRun(branch, "u0"), null);
	assert.equal(matchRun(branch, "missing"), null);
});
