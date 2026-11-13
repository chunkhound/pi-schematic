import { expect, test } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { setActiveNotebookTopic, clearActiveNotebookTopic } from "../../notebook/topic.js";
import { registerNotebookTopicTool } from "../../notebook/topic-tool.js";
import { createToolContext } from "./helpers.js";
import { createTestHost, getTool } from "./test-host.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The result's details; throws unless they are an object. */
function detailsOf(result: AgentToolResult<unknown>): Record<string, unknown> {
	if (!isRecord(result.details)) {throw new Error("Expected the tool result details to be an object.");}
	return result.details;
}

/** The text of the result's first content block; throws unless that block is text. */
function firstText(result: AgentToolResult<unknown>): string {
	const block = result.content.at(0);
	if (block?.type !== "text") {throw new Error("Expected the tool result to start with a text block.");}
	return block.text;
}

test("topic helpers manage the active notebook topic lifecycle", () => {
	const state = createState();
	const first = setActiveNotebookTopic(state, "OAuth", "agent");
	expect(first).toStrictEqual({
		changed: true,
		previous: null,
		current: "oauth",
		boundaryHint: null,
	});
	const second = setActiveNotebookTopic(state, "Billing", "human");
	expect(second.boundaryHint?.from).toBe("oauth");
	expect(second.boundaryHint?.to).toBe("billing");
	clearActiveNotebookTopic(state);
	expect(state.activeNotebookTopic).toBeNull();
	expect(state.activeNotebookTopicSource).toBeNull();
	expect(state.pendingTopicBoundaryHint).toBeNull();
});

test("notebook_topic_set establishes a fresh topic, is idempotent, and refuses overrides", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookTopicTool(api, state); });

	const tool = getTool(pi, "notebook_topic_set");
	const ctx = createToolContext();
	const first = await tool.execute("1", { topic: "OAuth" }, undefined, undefined, ctx);
	expect(detailsOf(first).topic).toBe("oauth");
	expect(state.activeNotebookTopic).toBe("oauth");
	expect(state.activeNotebookTopicSource).toBe("agent");

	const second = await tool.execute("2", { topic: "oauth" }, undefined, undefined, ctx);
	expect(detailsOf(second).changed).toBe(false);
	expect(detailsOf(second).source).toBe("agent");
	expect(firstText(second)).toMatch(/already set to "oauth"/i);

	await expect(tool.execute("3", { topic: "billing" }, undefined, undefined, ctx)).rejects.toThrow(/already exists/);
});


test("notebook_topic_set preserves human authority, stays idempotent for equal topics, and rejects empty normalized topics", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookTopicTool(api, state); });
	const tool = getTool(pi, "notebook_topic_set");
	const ctx = createToolContext();

	setActiveNotebookTopic(state, "oauth", "human");
	const same = await tool.execute("1", { topic: "OAuth" }, undefined, undefined, ctx);
	expect(detailsOf(same).changed).toBe(false);
	expect(detailsOf(same).source).toBe("human");
	expect(firstText(same)).toMatch(/already set to "oauth"/i);
	await expect(tool.execute("2", { topic: "billing" }, undefined, undefined, ctx)).rejects.toThrow(/human-set notebook topic is authoritative/i);

	const freshState = createState();
	const freshPi = await createTestHost((api) => { registerNotebookTopicTool(api, freshState); });
	const freshTool = getTool(freshPi, "notebook_topic_set");
	await expect(freshTool.execute("3", { topic: "@@@" }, undefined, undefined, ctx)).rejects.toThrow(/notebook topic cannot be empty/i);
});
