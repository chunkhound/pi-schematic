import { expect, test } from "vitest";
import { createState, type SchematicState } from "../../state.js";
import { clearActiveNotebookTopic, normalizeNotebookTopic, setActiveNotebookTopic } from "../../notebook/topic.js";
import { registerNotebookTopicTool } from "../../notebook/topic-tool.js";
import { detailsOf, firstText } from "../support/tool-result.js";
import { createRunner, type RunnerFixture } from "../support/runner.js";

/** A headless runner with only the notebook_topic_set tool, registered over `state`. */
function topicToolRunner(state: SchematicState): Promise<RunnerFixture> {
	return createRunner({
		cwd: process.cwd(),
		mode: "print",
		factories: [
			(api) => {
				registerNotebookTopicTool(api, state);
			},
		],
	});
}

test("setActiveNotebookTopic reports a first topic as changed with no boundary hint", () => {
	const state = createState();

	expect(setActiveNotebookTopic(state, "OAuth", "agent")).toStrictEqual({
		changed: true,
		previous: null,
		current: "oauth",
		boundaryHint: null,
	});
});

test("setActiveNotebookTopic stages a boundary hint when the topic changes", () => {
	const state = createState();
	setActiveNotebookTopic(state, "OAuth", "agent");

	const second = setActiveNotebookTopic(state, "Billing", "human");

	const hint = { from: "oauth", to: "billing", source: "human", advisoryDelivered: false };
	expect(second.boundaryHint).toStrictEqual(hint);
	expect(state.pendingTopicBoundaryHint).toStrictEqual(hint);
});

test("setActiveNotebookTopic reports a repeated topic as unchanged with no boundary hint", () => {
	const state = createState();
	setActiveNotebookTopic(state, "oauth", "human");

	const repeated = setActiveNotebookTopic(state, "OAuth", "human");

	expect(repeated.changed).toBe(false);
	expect(repeated.boundaryHint).toBeNull();
});

test("repeating the current topic keeps the pending boundary hint", () => {
	const state = createState();
	setActiveNotebookTopic(state, "oauth", "human");
	setActiveNotebookTopic(state, "billing", "human");

	setActiveNotebookTopic(state, "billing", "human");

	expect(state.pendingTopicBoundaryHint).toStrictEqual({ from: "oauth", to: "billing", source: "human", advisoryDelivered: false });
});

test("clearActiveNotebookTopic clears the topic, its source and the pending hint", () => {
	const state = createState();
	setActiveNotebookTopic(state, "oauth", "human");
	setActiveNotebookTopic(state, "billing", "human");

	clearActiveNotebookTopic(state);

	expect(state.activeNotebookTopic).toBeNull();
	expect(state.activeNotebookTopicSource).toBeNull();
	expect(state.pendingTopicBoundaryHint).toBeNull();
});

test.each([
	{ input: "Billing & Invoices", expected: "billing-invoices" },
	{ input: "  --OAuth--  ", expected: "oauth" },
	{ input: "a".repeat(100), expected: "a".repeat(80) },
])("normalizeNotebookTopic($input) is $expected", ({ input, expected }) => {
	expect(normalizeNotebookTopic(input)).toBe(expected);
});

test("notebook_topic_set establishes a fresh topic, is idempotent, and refuses overrides", async () => {
	const state = createState();
	const fixture = await topicToolRunner(state);
	const tool = fixture.tool("notebook_topic_set");

	const first = await tool.execute("1", { topic: "OAuth" });
	expect(detailsOf(first).topic).toBe("oauth");
	expect(state.activeNotebookTopic).toBe("oauth");
	expect(state.activeNotebookTopicSource).toBe("agent");

	const second = await tool.execute("2", { topic: "oauth" });
	expect(detailsOf(second).changed).toBe(false);
	expect(detailsOf(second).source).toBe("agent");
	expect(firstText(second)).toMatch(/already set to "oauth"/i);

	await expect(tool.execute("3", { topic: "billing" })).rejects.toThrow(/already exists/);
});

test("notebook_topic_set preserves human authority, stays idempotent for equal topics, and rejects empty normalized topics", async () => {
	const state = createState();
	const tool = (await topicToolRunner(state)).tool("notebook_topic_set");

	setActiveNotebookTopic(state, "oauth", "human");
	const same = await tool.execute("1", { topic: "OAuth" });
	expect(detailsOf(same).changed).toBe(false);
	expect(detailsOf(same).source).toBe("human");
	expect(firstText(same)).toMatch(/already set to "oauth"/i);
	await expect(tool.execute("2", { topic: "billing" })).rejects.toThrow(/human-set notebook topic is authoritative/i);

	const freshTool = (await topicToolRunner(createState())).tool("notebook_topic_set");
	await expect(freshTool.execute("3", { topic: "@@@" })).rejects.toThrow(/notebook topic cannot be empty/i);
});

test("notebook_topic_set reports the topic it set when none was set", async () => {
	const tool = (await topicToolRunner(createState())).tool("notebook_topic_set");

	const result = await tool.execute("1", { topic: "OAuth" });

	expect(firstText(result)).toBe('Active notebook topic: "oauth".');
});

test("a topic set through /notebook <topic> refuses an agent override through notebook_topic_set", async () => {
	const fixture = await createRunner({ cwd: process.cwd(), mode: "print" });
	await fixture.command("notebook").handler("oauth", fixture.runner.createCommandContext());

	await expect(fixture.tool("notebook_topic_set").execute("1", { topic: "billing" })).rejects.toThrow(
		new Error("Human-set notebook topic is authoritative. Use handoff instead of overriding it."),
	);
});

test("/notebook <topic> repeating the agent's topic gives the user authority over it", async () => {
	const fixture = await createRunner({ cwd: process.cwd(), mode: "print" });
	const tool = fixture.tool("notebook_topic_set");
	await tool.execute("1", { topic: "oauth" });
	await fixture.command("notebook").handler("oauth", fixture.runner.createCommandContext());

	await expect(tool.execute("2", { topic: "billing" })).rejects.toThrow(
		new Error("Human-set notebook topic is authoritative. Use handoff instead of overriding it."),
	);
});
