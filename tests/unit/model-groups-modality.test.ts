import test from "node:test";
import assert from "node:assert/strict";
import { MODALITY_FG, MODALITY_LETTER, modalityLetterRun } from "../../model-groups/modality.js";
import type { ModelGroupModality } from "../../model-groups/types.js";

test("MODALITY_LETTER / MODALITY_FG cover the established single-letter lexicon", () => {
	assert.deepEqual(MODALITY_LETTER, { text: "T", image: "I", reasoning: "R" });
	assert.equal(MODALITY_FG.text, "syntaxKeyword");
	assert.equal(MODALITY_FG.image, "success");
	assert.equal(MODALITY_FG.reasoning, "thinkingHigh");
});

test("modalityLetterRun canonicalizes order and excludes reasoning by default", () => {
	const effective = ["reasoning", "image", "text"] as readonly ModelGroupModality[];
	assert.equal(modalityLetterRun(effective), "T I"); // reasoning dropped, text first
	assert.equal(modalityLetterRun(effective, { includeReasoning: true }), "T I R");
	assert.equal(modalityLetterRun(["reasoning"]), "");
	assert.equal(modalityLetterRun([]), "");
	assert.equal(modalityLetterRun(undefined), "");
	assert.equal(modalityLetterRun(null), "");
});

test("modalityLetterRun consolidates text away when another media modality is present", () => {
	// Image implies text -> only the image letter shows (OpenRouter-style).
	assert.equal(modalityLetterRun(["text", "image"], { hideTextWhenOtherMedia: true }), "I");
	// Text-only keeps the T.
	assert.equal(modalityLetterRun(["text"], { hideTextWhenOtherMedia: true }), "T");
	// Reasoning is not a media modality; consolidation still applies after it is excluded.
	assert.equal(modalityLetterRun(["text", "image", "reasoning"], { hideTextWhenOtherMedia: true }), "I");
	// Default leaves full letters (list rows keep text alongside image).
	assert.equal(modalityLetterRun(["text", "image"]), "T I");
});

test("modalityLetterRun honors a renderer and separator", () => {
	const rendered = modalityLetterRun(["text", "image"], {
		render: (modality, letter) => `${MODALITY_FG[modality]}(${letter})`,
		separator: "·",
	});
	assert.equal(rendered, "syntaxKeyword(T)·success(I)");
});