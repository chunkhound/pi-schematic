import { expect, test } from "vitest";
import { contextPrimerSection } from "../../system-prompt.js";
import { formatCurrentDatePrompt } from "../../time/format.js";
import { createBeforeAgentStartEvent, createTestHost, getCommand, getHandler, getTool } from "./test-host.js";
import { createCommandContext, makeTUICtx } from "./helpers.js";
import { assertPresent } from "../assertions.js";

test("the context primer states the notebook, topic, and handoff contracts", () => {
	const primer = contextPrimerSection().render();
	assertPresent(primer);
	expect(primer, "the context primer should contain zero stale ledger references after the rename").not.toMatch(/ledger/i);

	const notebookParts = primer.split("### Notebook");
	const topicParts = primer.split("### Active notebook topic");
	const handoffParts = primer.split("### Handoff");
	const rulesParts = primer.split("### Rules");
	expect(notebookParts).toHaveLength(2);
	expect(topicParts).toHaveLength(2);
	expect(handoffParts).toHaveLength(2);
	expect(rulesParts).toHaveLength(2);

	const notebookSection = notebookParts[1].split("### Active notebook topic")[0];
	const topicSection = topicParts[1].split("### Handoff")[0];
	const handoffSection = handoffParts[1].split("### Rules")[0];
	const rulesSection = rulesParts[1];

	expect(notebookSection).toMatch(/notebook_index/);
	expect(notebookSection).toMatch(/notebook_read/);
	expect(notebookSection).toMatch(/fresh context/i);
	expect(notebookSection).toMatch(/two-tier cache/i);
	expect(notebookSection).toMatch(/shared memory/i);
	expect(notebookSection).not.toMatch(/durable cross-context grounding/i);
	expect(topicSection).toMatch(/semantic frame/i);
	expect(topicSection).toMatch(/prefer spawn/i);
	expect(topicSection).toMatch(/prefer handoff/i);
	expect(handoffSection).toMatch(/next instruction/i);
	expect(handoffSection).toMatch(/verbatim/i);
	expect(handoffSection).toMatch(/Hand off BEFORE executing/i);
	expect(handoffSection).toMatch(/nextInstruction/i);
	expect(handoffSection).not.toMatch(/draft a handoff prompt/i);
	expect(handoffSection).toMatch(/notebook/i);
	expect(handoffSection).not.toMatch(/\bbrief\b/i);
	expect(primer).toMatch(/When the ask no longer matches the topic, call the handoff tool\./i);
	expect(rulesSection).toMatch(/one subject, thread, or subsystem/i);
	expect(handoffSection).toMatch(/situational context/i);
	expect(rulesSection, "rules must specify what the notebook must hold before handoff").toMatch(/non-recoverable knowledge/i);
	expect(rulesSection, "rules must explicitly list what the prompt carries").toMatch(/current state, blockers, and next steps/i);
	expect(rulesSection, "replaced with explicit list of what the prompt carries").not.toMatch(/remaining situational context/i);
	expect(rulesSection).toMatch(/Keep pages compact/i);
	expect(rulesSection, "rules must require verifying all important findings are persisted before handoff").toMatch(/handoff.*verify all important findings are persisted/i);
	expect(rulesSection).toMatch(/chaining handoffs/i);
	expect(rulesSection, "rules must explain when notebook pages may be deleted during handoff").toMatch(/discard pages holding only recoverable code facts/i);
	expect(primer).toMatch(/overlong child output is truncated/i);
});

test("before_agent_start writes notebook contracts plus live topic and page data", async () => {
	const pi = await createTestHost();
	await getCommand(pi, "notebook").handler("oauth", createCommandContext());
	const notebookWrite = getTool(pi, "notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "first line\nsecond line" }, undefined, undefined, makeTUICtx());

	const handler = getHandler(pi, "before_agent_start");
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	const { sections } = event.systemPromptOptions;
	expect(sections.schematic).toMatch(/## Context management/);
	expect(sections.schematic_date).toMatch(/## Current date\n\d{4}-\d{2}-\d{2} \(\w+\)/);
	expect(sections.schematic_date).toMatch(/Resolve every relative or ambiguous time reference/);
	expect(sections.schematic_topic).toMatch(/## Active Notebook Topic/);
	expect(sections.schematic_topic).toMatch(/Current topic: `oauth`/);
	expect(sections.schematic_notebook).toMatch(/## Active Notebook Pages/);
	expect(sections.schematic_notebook).toMatch(/notebook_read/);
	expect(sections.schematic_notebook).toMatch(/Reference pages by name/i);
	expect(sections.schematic_notebook).toMatch(/alpha: first line/);
});

// Cached-prefix invariant: pi renders sections in key order, so the anchor sits
// after the static primer and before every dynamic section, exactly once. A
// notebook page first line may contain the same heading text, so the count
// matches only full anchor blocks and excludes the notebook listing section.
test("before_agent_start places date anchor after primer and before dynamic sections", async () => {
	const pi = await createTestHost();
	await getCommand(pi, "notebook").handler("oauth", createCommandContext());
	const notebookWrite = getTool(pi, "notebook_write");
	await notebookWrite.execute("1", { name: "decoy", content: "## Current date decoy" }, undefined, undefined, makeTUICtx());

	const handler = getHandler(pi, "before_agent_start");
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	const schematicNames = Object.keys(event.systemPromptOptions.sections).filter((name) => name.startsWith("schematic"));
	expect(schematicNames.slice(0, 3)).toStrictEqual(["schematic", "schematic_date", "schematic_topic"]);
	// Extension-owned anchors only: skip the notebook listing, whose page text
	// may reuse the heading, then count blocks that parse as a real anchor.
	const anchorCount = Object.entries(event.systemPromptOptions.sections)
		.filter(([name]) => name.startsWith("schematic") && name !== "schematic_notebook")
		.reduce((count, [, body]) => count + (body.match(/## Current date\n\d{4}-\d{2}-\d{2} \(\w+\)/g)?.length ?? 0), 0);
	expect(anchorCount).toBe(1);
});

// Same-day stability with pinned instants — no live clock, no midnight flake.
test("date anchor is stable for two times on the same day", () => {
	const morning = new Date(Date.UTC(2026, 9, 5, 0, 30));
	const evening = new Date(Date.UTC(2026, 9, 5, 23, 30));
	expect(formatCurrentDatePrompt(evening, "UTC")).toBe(formatCurrentDatePrompt(morning, "UTC"));
});

// Freshness across midnight with pinned instants on either side.
test("date anchor changes across midnight", () => {
	const before = formatCurrentDatePrompt(new Date(Date.UTC(2026, 9, 5, 23, 59)), "UTC");
	const after = formatCurrentDatePrompt(new Date(Date.UTC(2026, 9, 6, 0, 1)), "UTC");
	expect(before).toMatch(/2026-10-05/);
	expect(after).toMatch(/2026-10-06/);
	expect(before).not.toBe(after);
});

// Handler wiring smoke: the date section body is a whole, parseable anchor block.
test("before_agent_start writes a parseable date anchor section", async () => {
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	expect(event.systemPromptOptions.sections.schematic_date).toMatch(/^## Current date\n\d{4}-\d{2}-\d{2} \(\w+\), \S+ \(UTC[+-]\d{2}:\d{2}\)\n\n/);
});

test("before_agent_start writes no-topic guidance when the topic is unset", async () => {
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent();
	await handler(event, ctx);

	const { sections } = event.systemPromptOptions;
	expect(sections.schematic_topic).toMatch(/## Active Notebook Topic/);
	expect(sections.schematic_topic).toMatch(/No active notebook topic is set\./);
	expect(sections.schematic_topic).toMatch(/notebook_topic_set/);
});

test("does not copy the base prompt into schematic's sections", async () => {
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const event = createBeforeAgentStartEvent({ systemPrompt: "Base system prompt." });
	await handler(event, ctx);

	const schematicBodies = Object.entries(event.systemPromptOptions.sections)
		.filter(([name]) => name.startsWith("schematic"))
		.map(([, body]) => body);
	expect(schematicBodies.length).toBeGreaterThan(0);
	for (const body of schematicBodies) {expect(body).not.toMatch(/Base system prompt\./);}
});
