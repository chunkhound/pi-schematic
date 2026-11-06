// Pure notebook-write helpers: argument parsing and the preview a run later consumes.
import assert from "node:assert/strict";
import test from "node:test";
import { buildNotebookWritePreview, parseNotebookWrite } from "../../workflow/notebook.js";

test("parseNotebookWrite returns exactly the name and content strings", () => {
	assert.deepEqual(parseNotebookWrite({ name: "findings", content: "line one\nline two" }), {
		name: "findings",
		content: "line one\nline two",
	});
});

test("parseNotebookWrite drops fields the workflow did not declare", () => {
	assert.deepEqual(parseNotebookWrite({ name: "findings", content: "body", extra: 1 }), {
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
		assert.throws(() => parseNotebookWrite(args), /requires \{ name, content \} as strings/, JSON.stringify(args));
	}
});

test("buildNotebookWritePreview names the page and carries the preview verbatim", () => {
	assert.equal(buildNotebookWritePreview("findings", "first line"), 'Notebook page "findings" written: first line');
});

test("buildNotebookWritePreview keeps an ellipsis-clipped preview unchanged", () => {
	const clipped = "x".repeat(20) + "...";
	assert.equal(buildNotebookWritePreview("p", clipped), `Notebook page "p" written: ${clipped}`);
});
