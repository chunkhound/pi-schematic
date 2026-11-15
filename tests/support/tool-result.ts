// Readers and checks for tool results and the records they carry.

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import { isRecord } from "../assertions.js";

/** `value` as a record; throws, naming `what`, unless it is an object. */
export function recordOf(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`Expected ${what} to be an object.`);
	}
	return value;
}

/** The details of a tool result; throws unless they are an object. */
export function detailsOf(result: AgentToolResult<unknown>): Record<string, unknown> {
	return recordOf(result.details, "the tool result details");
}

/** The text of the result's first content block; throws unless that block is text. */
export function firstText(result: AgentToolResult<unknown>): string {
	const block = result.content.at(0);
	if (block?.type !== "text") {
		throw new Error("Expected the tool result to start with a text block.");
	}
	return block.text;
}

/** Join the text of a tool result's text blocks. */
export function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

/**
 * Asserts that `result` is an error tool result whose only content is the text block `text`, whose
 * `details.outcome` is `"error"` and whose `usage` equals `usage`; throws unless `result` and its
 * details are objects.
 */
export function assertErrorResult(result: unknown, text: string, usage: unknown): void {
	if (!isRecord(result)) {
		throw new Error(`Expected a tool result object, got ${JSON.stringify(result)}.`);
	}
	expect(result.isError).toBe(true);
	expect(result.content).toStrictEqual([{ type: "text", text }]);
	if (!isRecord(result.details)) {
		throw new Error(`Expected a tool result with a details object, got ${JSON.stringify(result)}.`);
	}
	expect(result.details.outcome).toBe("error");
	expect(result.usage).toStrictEqual(usage);
}
