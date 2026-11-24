// Contract: the author-facing classifier block stays aligned with the pi-ai unions the
// engine passes through. The runtime arrays carry a compile-time check; this test carries
// the documentation check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	CLASSIFIER_ANSWER_TYPES,
	CLASSIFIER_QUESTION_TYPES,
	CLASSIFIER_STOP_REASONS,
} from "../../workflow/classify.js";

const DOC = new URL("../../docs/workflows.md", import.meta.url);

function classifierBlock(): string {
	const text = readFileSync(DOC, "utf8");
	const start = text.indexOf("<summary>Classifier types</summary>");
	const end = text.indexOf("</details>", start);
	assert.ok(start >= 0 && end > start, "docs/workflows.md keeps the Classifier types block");
	return text.slice(start, end);
}

test("classifier question and answer types match the documented block", () => {
	const block = classifierBlock();
	const documented = new Set([...block.matchAll(/type: "([^"]+)"/g)].map((match) => match[1]));
	const expected = new Set([...CLASSIFIER_QUESTION_TYPES, ...CLASSIFIER_ANSWER_TYPES]);
	assert.deepEqual([...documented].sort(), [...expected].sort());
});

test("classifier stop reasons match the documented block", () => {
	const block = classifierBlock();
	assert.match(block, /stopReason: "stop" \| "error" \| "aborted"/);
	assert.deepEqual([...CLASSIFIER_STOP_REASONS], ["stop", "error", "aborted"]);
});
