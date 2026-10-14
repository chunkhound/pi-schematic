import test from "node:test";
import assert from "node:assert/strict";
import { notebookPagesSection, notebookTopicSection } from "../../notebook/prompt.js";
import { createState } from "../../state.js";

test("frames the active topic with its source", () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";
	state.activeNotebookTopicSource = "human";

	assert.ok(notebookTopicSection(state).render()!.includes("Current topic: `oauth` (human-set)."));
});

test("asks for a topic when none is set", () => {
	const state = createState();

	assert.ok(notebookTopicSection(state).render()!.includes("No active notebook topic is set."));
});

test("labels a topic with an unknown source", () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";
	state.activeNotebookTopicSource = null;

	assert.ok(notebookTopicSection(state).render()!.includes("(unknown-set)"));
});

test("lists notebook pages sorted by name", () => {
	const state = createState();
	state.notebookPages.set("a", "a summary");
	state.notebookPages.set("B", "B summary");

	const listing = notebookPagesSection(state).render()!.split("\n").filter((line) => line.startsWith("  "));

	assert.deepEqual(listing, ["  B: B summary", "  a: a summary"]);
});

test("lists only the first line of each page", () => {
	const state = createState();
	state.notebookPages.set("alpha", "summary line\nsecond line");

	const body = notebookPagesSection(state).render()!;

	assert.ok(body.includes("alpha: summary line"));
	assert.ok(!body.includes("second line"));
});

test("truncates a page summary at 80 characters", () => {
	const state = createState();
	state.notebookPages.set("alpha", "x".repeat(81));

	const line = notebookPagesSection(state).render()!.split("\n").find((l) => l.startsWith("  alpha: "))!;

	assert.equal(line, `  alpha: ${"x".repeat(80)}`);
});

test("omits the pages section when the notebook is empty", () => {
	const state = createState();

	assert.equal(notebookPagesSection(state).render(), undefined);
});
