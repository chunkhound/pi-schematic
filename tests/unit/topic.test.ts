import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../state.js";
import { setActiveNotebookTopic, clearActiveNotebookTopic } from "../../notebook/topic.js";
import { registerNotebookTopicTool } from "../../notebook/topic-tool.js";
import { createTestHost } from "./test-host.js";

test("topic helpers manage the active notebook topic lifecycle", () => {
	const state = createState();
	const first = setActiveNotebookTopic(state, "OAuth", "agent");
	assert.deepEqual(first, {
		changed: true,
		previous: null,
		current: "oauth",
		boundaryHint: null,
	});
	const second = setActiveNotebookTopic(state, "Billing", "human");
	assert.equal(second.boundaryHint?.from, "oauth");
	assert.equal(second.boundaryHint?.to, "billing");
	clearActiveNotebookTopic(state);
	assert.equal(state.activeNotebookTopic, null);
	assert.equal(state.activeNotebookTopicSource, null);
	assert.equal(state.pendingTopicBoundaryHint, null);
});

test("notebook_topic_set establishes a fresh topic, is idempotent, and refuses overrides", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookTopicTool(api, state));

	const tool = pi.tools.get("notebook_topic_set");
	const first = await tool.execute("1", { topic: "OAuth" });
	assert.equal(first.details.topic, "oauth");
	assert.equal(state.activeNotebookTopic, "oauth");
	assert.equal(state.activeNotebookTopicSource, "agent");

	const second = await tool.execute("2", { topic: "oauth" });
	assert.equal(second.details.changed, false);
	assert.equal(second.details.source, "agent");
	assert.match(second.content[0].text, /already set to "oauth"/i);

	await assert.rejects(() => tool.execute("3", { topic: "billing" }), /already exists/);
});


test("notebook_topic_set preserves human authority, stays idempotent for equal topics, and rejects empty normalized topics", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookTopicTool(api, state));
	const tool = pi.tools.get("notebook_topic_set");

	setActiveNotebookTopic(state, "oauth", "human");
	const same = await tool.execute("1", { topic: "OAuth" });
	assert.equal(same.details.changed, false);
	assert.equal(same.details.source, "human");
	assert.match(same.content[0].text, /already set to "oauth"/i);
	await assert.rejects(
		() => tool.execute("2", { topic: "billing" }),
		/human-set notebook topic is authoritative/i,
	);

	const freshState = createState();
	const freshPi = await createTestHost((api) => registerNotebookTopicTool(api, freshState));
	const freshTool = freshPi.tools.get("notebook_topic_set");
	await assert.rejects(
		() => freshTool.execute("3", { topic: "@@@" }),
		/notebook topic cannot be empty/i,
	);
});
