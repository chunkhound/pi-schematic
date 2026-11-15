import { expect, onTestFinished, test, vi } from "vitest";
import { contextPrimerSection } from "../../system-prompt.js";
import { assertPresent } from "../assertions.js";
import { createRunner, type RunnerFixture } from "../support/runner.js";

/** A headless runner over the shipped extension in an untrusted project, with the clock the date section reads fixed. */
async function shippedRunner(): Promise<RunnerFixture> {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, 12)));
	onTestFinished(() => {
		vi.useRealTimers();
	});
	return createRunner({ cwd: process.cwd(), mode: "print", context: { isProjectTrusted: () => false } });
}

/** Run before_agent_start for a user prompt and return the prompt sections after every handler. */
async function sectionsAfterBeforeAgentStart(fixture: RunnerFixture, customPrompt?: string): Promise<Record<string, string>> {
	const result = await fixture.runner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, fixture.systemPromptOptions({ customPrompt }));
	return result.systemPromptOptions.sections;
}

const PRIMER_HEADINGS = ["### Notebook", "### Active notebook topic", "### Handoff", "### Rules"];

test("the context primer states the notebook, topic, and handoff contracts", () => {
	const primer = contextPrimerSection().render();
	assertPresent(primer);

	const positions = PRIMER_HEADINGS.map((heading) => primer.indexOf(heading));
	expect(
		PRIMER_HEADINGS.map((heading) => primer.split(heading).length - 1),
		"each contract heading appears exactly once",
	).toStrictEqual([1, 1, 1, 1]);
	expect(positions, "the contract headings appear in order").toStrictEqual([...positions].sort((a, b) => a - b));
	expect(primer).toContain("notebook_index");
	expect(primer).toContain("notebook_read");
	expect(primer).toContain("nextInstruction");
});

test("before_agent_start writes the notebook contract into the primer section", async () => {
	const fixture = await shippedRunner();

	const sections = await sectionsAfterBeforeAgentStart(fixture);

	expect(sections.schematic).toContain("### Notebook — two-tier cache for this work stream\nPages are a cache for this stream, not an archive");
});

test("before_agent_start writes the live topic and notebook page listing", async () => {
	const fixture = await shippedRunner();
	await fixture.command("notebook").handler("oauth", fixture.runner.createCommandContext());
	await fixture.tool("notebook_write").execute("1", { name: "alpha", content: "first line\nsecond line" });

	const sections = await sectionsAfterBeforeAgentStart(fixture);

	expect(sections.schematic_topic).toContain("Current topic: `oauth`");
	expect(sections.schematic_notebook).toContain("alpha: first line");
});

// Cached-prefix invariant: pi renders sections in key order, so the anchor sits
// after the static primer and before every dynamic section, exactly once. A
// notebook page first line may contain the same heading text, so the count
// matches only full anchor blocks and excludes the notebook listing section.
test("before_agent_start places date anchor after primer and before dynamic sections", async () => {
	const fixture = await shippedRunner();
	await fixture.command("notebook").handler("oauth", fixture.runner.createCommandContext());
	await fixture.tool("notebook_write").execute("1", { name: "decoy", content: "## Current date decoy" });

	const sections = await sectionsAfterBeforeAgentStart(fixture);

	const schematicNames = Object.keys(sections).filter((name) => name.startsWith("schematic"));
	expect(schematicNames.slice(0, 3)).toStrictEqual(["schematic", "schematic_date", "schematic_topic"]);
	// Extension-owned anchors only: skip the notebook listing, whose page text
	// may reuse the heading, then count blocks that parse as a real anchor.
	const anchorCount = Object.entries(sections)
		.filter(([name]) => name.startsWith("schematic") && name !== "schematic_notebook")
		.reduce((count, [, body]) => count + (body.match(/## Current date\n\d{4}-\d{2}-\d{2} \(\w+\)/g)?.length ?? 0), 0);
	expect(anchorCount).toBe(1);
});

test("does not copy the base prompt into schematic's sections", async () => {
	const fixture = await shippedRunner();

	const sections = await sectionsAfterBeforeAgentStart(fixture, "Base system prompt.");

	const schematicBodies = Object.entries(sections)
		.filter(([name]) => name.startsWith("schematic"))
		.map(([, body]) => body);
	expect(schematicBodies.length).toBeGreaterThan(0);
	expect(schematicBodies.filter((body) => body.includes("Base system prompt."))).toStrictEqual([]);
});
