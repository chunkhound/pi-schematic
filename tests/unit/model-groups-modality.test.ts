import { expect, test } from "vitest";
import { MODALITY_FG, modalityLetterRun } from "../../model-groups/modality.js";
import type { ModelGroupModality } from "../../model-groups/types.js";

test("modalityLetterRun canonicalizes order and excludes reasoning by default", () => {
	const effective = ["reasoning", "image", "text"] as readonly ModelGroupModality[];
	expect(modalityLetterRun(effective)).toBe("T I"); // reasoning dropped, text first
	expect(modalityLetterRun(effective, { includeReasoning: true })).toBe("T I R");
	expect(modalityLetterRun(["reasoning"])).toBe("");
	expect(modalityLetterRun([])).toBe("");
	expect(modalityLetterRun(undefined)).toBe("");
	expect(modalityLetterRun(null)).toBe("");
});

test("modalityLetterRun consolidates text away when another media modality is present", () => {
	// Image implies text -> only the image letter shows (OpenRouter-style).
	expect(modalityLetterRun(["text", "image"], { hideTextWhenOtherMedia: true })).toBe("I");
	// Text-only keeps the T.
	expect(modalityLetterRun(["text"], { hideTextWhenOtherMedia: true })).toBe("T");
	// Reasoning is not a media modality; consolidation still applies after it is excluded.
	expect(modalityLetterRun(["text", "image", "reasoning"], { hideTextWhenOtherMedia: true })).toBe("I");
	// Default leaves full letters (list rows keep text alongside image).
	expect(modalityLetterRun(["text", "image"])).toBe("T I");
});

test("modalityLetterRun honors a renderer and separator", () => {
	const rendered = modalityLetterRun(["text", "image"], {
		render: (modality, letter) => `${MODALITY_FG[modality]}(${letter})`,
		separator: "·",
	});
	expect(rendered).toBe("syntaxKeyword(T)·success(I)");
});
