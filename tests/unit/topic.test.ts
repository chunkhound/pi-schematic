import { expect, test } from "vitest";
import { createState } from "../../state.js";
import { setActiveNotebookTopic, clearActiveNotebookTopic } from "../../notebook/topic.js";
import { registerNotebookTopicTool } from "../../notebook/topic-tool.js";
import { createTestHost } from "./test-host.js";

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

	const tool = pi.tools.get("notebook_topic_set");
	const first = await tool.execute("1", { topic: "OAuth" });
	expect(first.details.topic).toBe("oauth");
	expect(state.activeNotebookTopic).toBe("oauth");
	expect(state.activeNotebookTopicSource).toBe("agent");

	const second = await tool.execute("2", { topic: "oauth" });
	expect(second.details.changed).toBe(false);
	expect(second.details.source).toBe("agent");
	expect(second.content[0].text).toMatch(/already set to "oauth"/i);

	await expect(tool.execute("3", { topic: "billing" })).rejects.toThrow(/already exists/);
});


test("notebook_topic_set preserves human authority, stays idempotent for equal topics, and rejects empty normalized topics", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookTopicTool(api, state); });
	const tool = pi.tools.get("notebook_topic_set");

	setActiveNotebookTopic(state, "oauth", "human");
	const same = await tool.execute("1", { topic: "OAuth" });
	expect(same.details.changed).toBe(false);
	expect(same.details.source).toBe("human");
	expect(same.content[0].text).toMatch(/already set to "oauth"/i);
	await expect(tool.execute("2", { topic: "billing" })).rejects.toThrow(/human-set notebook topic is authoritative/i);

	const freshState = createState();
	const freshPi = await createTestHost((api) => { registerNotebookTopicTool(api, freshState); });
	const freshTool = freshPi.tools.get("notebook_topic_set");
	await expect(freshTool.execute("3", { topic: "@@@" })).rejects.toThrow(/notebook topic cannot be empty/i);
});
