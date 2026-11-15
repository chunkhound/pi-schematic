import { expect, test } from "vitest";
import { notebookPagesSection, notebookTopicSection } from "../../notebook/prompt.js";
import { assertPresent } from "../assertions.js";
import { createState } from "../../state.js";

test("frames the active topic with its source", () => {
	const state = createState();
	state.activeNotebookTopic = { name: "oauth", source: "human" };

	expect(notebookTopicSection(state).render()).toContain("Current topic: `oauth` (human-set).");
});

test("asks for a topic when none is set", () => {
	const state = createState();

	expect(notebookTopicSection(state).render()).toContain("No active notebook topic is set.");
});

test("lists notebook pages sorted by name", () => {
	const state = createState();
	state.notebookPages.set("a", "a summary");
	state.notebookPages.set("B", "B summary");

	const rendered = notebookPagesSection(state).render();
	assertPresent(rendered, "the pages section renders");
	const listing = rendered.split("\n").filter((line) => line.startsWith("  "));

	expect(listing).toStrictEqual(["  B: B summary", "  a: a summary"]);
});

test("lists only the first line of each page", () => {
	const state = createState();
	state.notebookPages.set("alpha", "summary line\nsecond line");

	const body = notebookPagesSection(state).render();
	assertPresent(body, "the pages section renders");

	expect(body).toContain("alpha: summary line");
	expect(body).not.toContain("second line");
});

test("cuts a long page summary to 77 characters plus an ellipsis", () => {
	const state = createState();
	state.notebookPages.set("alpha", "x".repeat(81));

	const rendered = notebookPagesSection(state).render();
	assertPresent(rendered, "the pages section renders");
	const line = rendered.split("\n").find((l) => l.startsWith("  alpha: "));

	expect(line).toBe(`  alpha: ${"x".repeat(77)}...`);
});

test("keeps an 80-character page summary whole", () => {
	const state = createState();
	state.notebookPages.set("alpha", "x".repeat(80));

	const rendered = notebookPagesSection(state).render();
	assertPresent(rendered, "the pages section renders");
	const line = rendered.split("\n").find((l) => l.startsWith("  alpha: "));

	expect(line).toBe(`  alpha: ${"x".repeat(80)}`);
});

test("omits the pages section when the notebook is empty", () => {
	const state = createState();

	expect(notebookPagesSection(state).render()).toBeUndefined();
});
