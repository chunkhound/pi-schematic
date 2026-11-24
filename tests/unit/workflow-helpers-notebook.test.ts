// Pure notebook-write helpers: argument parsing and the preview a run later consumes.
import { expect, test } from "vitest";
import { buildNotebookWritePreview, parseNotebookWrite } from "../../workflow/notebook.js";

test("parseNotebookWrite returns exactly the name and content strings", () => {
	expect(parseNotebookWrite({ name: "findings", content: "line one\nline two" })).toStrictEqual({
		name: "findings",
		content: "line one\nline two",
	});
});

test("parseNotebookWrite drops fields the workflow did not declare", () => {
	expect(parseNotebookWrite({ name: "findings", content: "body", extra: 1 })).toStrictEqual({
		name: "findings",
		content: "body",
	});
});

test("parseNotebookWrite rejects arguments that are not an object with string name and content", () => {
	const malformed: unknown[] = [
		undefined,
		null,
		"findings",
		42,
		{},
		{ name: "findings" },
		{ content: "body" },
		{ name: 1, content: "body" },
		{ name: "findings", content: ["body"] },
	];
	for (const args of malformed) {
		expect(() => parseNotebookWrite(args)).toThrow(/requires \{ name, content \} as strings/);
	}
});

test("buildNotebookWritePreview names the page and carries the preview verbatim", () => {
	expect(buildNotebookWritePreview("findings", "first line")).toBe('Notebook page "findings" written: first line');
});

test("buildNotebookWritePreview keeps an ellipsis-clipped preview unchanged", () => {
	const clipped = "x".repeat(20) + "...";
	expect(buildNotebookWritePreview("p", clipped)).toBe(`Notebook page "p" written: ${clipped}`);
});
