import { expect, test } from "vitest";
import { notebookPagesSection, notebookTopicSection } from "../../notebook/prompt.js";
import { createState } from "../../state.js";

test("frames the active topic with its source", () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";
	state.activeNotebookTopicSource = "human";

	expect(notebookTopicSection(state).render()!.includes("Current topic: `oauth` (human-set).")).toBe(true);
});

test("asks for a topic when none is set", () => {
	const state = createState();

	expect(notebookTopicSection(state).render()!.includes("No active notebook topic is set.")).toBe(true);
});

test("labels a topic with an unknown source", () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";
	state.activeNotebookTopicSource = null;

	expect(notebookTopicSection(state).render()!.includes("(unknown-set)")).toBe(true);
});

test("lists notebook pages sorted by name", () => {
	const state = createState();
	state.notebookPages.set("a", "a summary");
	state.notebookPages.set("B", "B summary");

	const listing = notebookPagesSection(state).render()!.split("\n").filter((line) => line.startsWith("  "));

	expect(listing).toStrictEqual(["  B: B summary", "  a: a summary"]);
});

test("lists only the first line of each page", () => {
	const state = createState();
	state.notebookPages.set("alpha", "summary line\nsecond line");

	const body = notebookPagesSection(state).render()!;

	expect(body.includes("alpha: summary line")).toBe(true);
	expect(!body.includes("second line")).toBe(true);
});

test("truncates a page summary at 80 characters", () => {
	const state = createState();
	state.notebookPages.set("alpha", "x".repeat(81));

	const line = notebookPagesSection(state).render()!.split("\n").find((l) => l.startsWith("  alpha: "))!;

	expect(line).toBe(`  alpha: ${"x".repeat(80)}`);
});

test("omits the pages section when the notebook is empty", () => {
	const state = createState();

	expect(notebookPagesSection(state).render()).toBe(undefined);
});
