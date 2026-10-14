import test from "node:test";
import assert from "node:assert/strict";
import { contextPrimerSection } from "../../system-prompt.js";
import { formatCurrentDatePrompt } from "../../time/format.js";
import { createBeforeAgentStartEvent, createTestHost } from "./test-host.js";
import { makeTUICtx } from "./helpers.js";

test("the context primer states the notebook, topic, and handoff contracts", () => {
	const primer = contextPrimerSection().render();
	assert.ok(primer !== undefined);
	assert.doesNotMatch(primer, /ledger/i,
		"the context primer should contain zero stale ledger references after the rename");

	const notebookParts = primer.split("### Notebook");
	const topicParts = primer.split("### Active notebook topic");
	const handoffParts = primer.split("### Handoff");
	const rulesParts = primer.split("### Rules");
	assert.equal(notebookParts.length, 2);
	assert.equal(topicParts.length, 2);
	assert.equal(handoffParts.length, 2);
	assert.equal(rulesParts.length, 2);

	const notebookSection = notebookParts[1].split("### Active notebook topic")[0];
	const topicSection = topicParts[1].split("### Handoff")[0];
	const handoffSection = handoffParts[1].split("### Rules")[0];
	const rulesSection = rulesParts[1];

	assert.match(notebookSection, /notebook_index/);
	assert.match(notebookSection, /notebook_read/);
	assert.match(notebookSection, /fresh context/i);
	assert.match(notebookSection, /two-tier cache/i);
	assert.match(notebookSection, /shared memory/i);
	assert.doesNotMatch(notebookSection, /durable cross-context grounding/i);
	assert.match(topicSection, /semantic frame/i);
	assert.match(topicSection, /prefer spawn/i);
	assert.match(topicSection, /prefer handoff/i);
	assert.match(handoffSection, /next instruction/i);
	assert.match(handoffSection, /verbatim/i);
	assert.match(handoffSection, /Hand off BEFORE executing/i);
	assert.match(handoffSection, /nextInstruction/i);
	assert.doesNotMatch(handoffSection, /draft a handoff prompt/i);
	assert.match(handoffSection, /notebook/i);
	assert.doesNotMatch(handoffSection, /\bbrief\b/i);
	assert.match(primer, /When the ask no longer matches the topic, call the handoff tool\./i);
	assert.match(rulesSection, /one subject, thread, or subsystem/i);
	assert.match(handoffSection, /situational context/i);
	assert.match(rulesSection, /non-recoverable knowledge/i,
		"rules must specify what the notebook must hold before handoff");
	assert.match(rulesSection, /current state, blockers, and next steps/i,
		"rules must explicitly list what the prompt carries");
	assert.doesNotMatch(rulesSection, /remaining situational context/i,
		"replaced with explicit list of what the prompt carries");
	assert.match(rulesSection, /Keep pages compact/i);
	assert.match(rulesSection, /handoff.*verify all important findings are persisted/i,
		"rules must require verifying all important findings are persisted before handoff");
	assert.match(rulesSection, /chaining handoffs/i);
	assert.match(rulesSection, /discard pages holding only recoverable code facts/i,
		"rules must explain when notebook pages may be deleted during handoff");
	assert.match(primer, /overlong child output is truncated/i);
});

test("before_agent_start writes notebook contracts plus live topic and page data", async () => {
	const pi = await createTestHost();
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "first line\nsecond line" }, undefined, undefined, makeTUICtx());

	const handler = pi.handlers.get("before_agent_start")![0];
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	const { sections } = event.systemPromptOptions;
	assert.match(sections.schematic, /## Context management/);
	assert.match(sections.schematic_date, /## Current date\n\d{4}-\d{2}-\d{2} \(\w+\)/);
	assert.match(sections.schematic_date, /Resolve every relative or ambiguous time reference/);
	assert.match(sections.schematic_topic, /## Active Notebook Topic/);
	assert.match(sections.schematic_topic, /Current topic: `oauth`/);
	assert.match(sections.schematic_notebook, /## Active Notebook Pages/);
	assert.match(sections.schematic_notebook, /notebook_read/);
	assert.match(sections.schematic_notebook, /Reference pages by name/i);
	assert.match(sections.schematic_notebook, /alpha: first line/);
});

// Cached-prefix invariant: pi renders sections in key order, so the anchor sits
// after the static primer and before every dynamic section, exactly once. A
// notebook page first line may contain the same heading text, so the count
// matches only full anchor blocks and excludes the notebook listing section.
test("before_agent_start places date anchor after primer and before dynamic sections", async () => {
	const pi = await createTestHost();
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "decoy", content: "## Current date decoy" }, undefined, undefined, makeTUICtx());

	const [handler] = pi.handlers.get("before_agent_start")!;
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	const schematicNames = Object.keys(event.systemPromptOptions.sections).filter((name) => name.startsWith("schematic"));
	assert.deepEqual(schematicNames.slice(0, 3), ["schematic", "schematic_date", "schematic_topic"]);
	// Extension-owned anchors only: skip the notebook listing, whose page text
	// may reuse the heading, then count blocks that parse as a real anchor.
	const anchorCount = Object.entries(event.systemPromptOptions.sections)
		.filter(([name]) => name.startsWith("schematic") && name !== "schematic_notebook")
		.reduce((count, [, body]) => count + (body.match(/## Current date\n\d{4}-\d{2}-\d{2} \(\w+\)/g)?.length ?? 0), 0);
	assert.equal(anchorCount, 1);
});

// Same-day stability with pinned instants — no live clock, no midnight flake.
test("date anchor is stable for two times on the same day", () => {
	const morning = new Date(Date.UTC(2026, 9, 5, 0, 30));
	const evening = new Date(Date.UTC(2026, 9, 5, 23, 30));
	assert.equal(formatCurrentDatePrompt(evening, "UTC"), formatCurrentDatePrompt(morning, "UTC"));
});

// Freshness across midnight with pinned instants on either side.
test("date anchor changes across midnight", () => {
	const before = formatCurrentDatePrompt(new Date(Date.UTC(2026, 9, 5, 23, 59)), "UTC");
	const after = formatCurrentDatePrompt(new Date(Date.UTC(2026, 9, 6, 0, 1)), "UTC");
	assert.match(before, /2026-10-05/);
	assert.match(after, /2026-10-06/);
	assert.notEqual(before, after);
});

// Handler wiring smoke: the date section body is a whole, parseable anchor block.
test("before_agent_start writes a parseable date anchor section", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("before_agent_start")!;
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	assert.match(event.systemPromptOptions.sections.schematic_date, /^## Current date\n\d{4}-\d{2}-\d{2} \(\w+\), \S+ \(UTC[+-]\d{2}:\d{2}\)\n\n/);
});

test("before_agent_start writes no-topic guidance when the topic is unset", async () => {
	const pi = await createTestHost();
	const handler = pi.handlers.get("before_agent_start")![0];
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	const { sections } = event.systemPromptOptions;
	assert.match(sections.schematic_topic, /## Active Notebook Topic/);
	assert.match(sections.schematic_topic, /No active notebook topic is set\./);
	assert.match(sections.schematic_topic, /notebook_topic_set/);
});

test("does not copy the base prompt into schematic's sections", async () => {
	const pi = await createTestHost();
	const handler = pi.handlers.get("before_agent_start")![0];
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent({ systemPrompt: "Base system prompt." });
	await handler(event, ctx);

	const schematicBodies = Object.entries(event.systemPromptOptions.sections)
		.filter(([name]) => name.startsWith("schematic"))
		.map(([, body]) => body);
	assert.ok(schematicBodies.length > 0);
	for (const body of schematicBodies) assert.doesNotMatch(body, /Base system prompt\./);
});
