import { expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext, ExtensionFactory, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { applyPromptSections, createPromptSectionRegistry } from "../../prompt-sections.js";
import { modelGroupsPath } from "../../model-groups/store.js";
import { assertPresent } from "../assertions.js";
import { createBeforeAgentStartEvent, createTestHost, emitBeforeAgentStart, getCommand, getHandler, getTool } from "./test-host.js";
import { withTemp } from "./model-groups-helpers.js";
import { boundaryEntries, callHandlers, createCommandContext, handoffToolResult, makeTUICtx, turnEndEvent } from "./helpers.js";

type HostContext = ExtensionCommandContext & ExtensionToolContext;

// The contexts these tests pass carry only the members the code under test uses. Reading a member a
// context lacks yields undefined; calling or dereferencing one throws a TypeError. Only that the value
// is an object can be checked at run time.
function assertHostContext(value: unknown): asserts value is HostContext {
	if (typeof value !== "object" || value === null) {throw new Error("Expected a context object.");}
}

function hostContext(value: unknown): HostContext {
	assertHostContext(value);
	return value;
}

// ── Registry ────────────────────────────────────────────────────────

test("renders sections in registration order", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic", render: () => "first" });
	registry.register({ name: "schematic_b", render: () => "second" });
	registry.register({ name: "schematic_a", render: () => "third" });

	expect(registry.render().map((section) => section.name)).toStrictEqual(["schematic", "schematic_b", "schematic_a"]);
});

test("omits a section whose body is undefined", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic_one", render: () => "body-one" });
	registry.register({ name: "schematic_absent", render: () => undefined });
	registry.register({ name: "schematic_two", render: () => "body-two" });

	expect(registry.render().map((section) => section.name)).toStrictEqual(["schematic_one", "schematic_two"]);
});

test("omits a section whose body is empty", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic_one", render: () => "body-one" });
	registry.register({ name: "schematic_empty", render: () => "" });
	registry.register({ name: "schematic_two", render: () => "body-two" });

	expect(registry.render().map((section) => section.name)).toStrictEqual(["schematic_one", "schematic_two"]);
});

for (const name of ["schematic", "schematic_model_groups"]) {
	test(`accepts names with the schematic prefix: ${name}`, () => {
		const registry = createPromptSectionRegistry();
		expect(() => { registry.register({ name, render: () => "body" }); }).not.toThrow();
		expect(registry.render()).toStrictEqual([{ name, body: "body" }]);
	});
}

for (const { name, reason } of [
	{ name: "other", reason: "wrong prefix" },
	{ name: "schematic-x", reason: "valid for pi, invalid here" },
	{ name: "schematicfoo", reason: "no underscore separator after the prefix" },
	{ name: "schematic_", reason: "empty part after the separator" },
	{ name: "schematic__x", reason: "empty middle part" },
	{ name: "schematic_Foo", reason: "uppercase letter" },
]) {
	test(`rejects names outside the schematic prefix: ${name} (${reason})`, () => {
		const registry = createPromptSectionRegistry();
		expect(() => { registry.register({ name, render: () => "body" }); }).toThrow(/Invalid schematic prompt section name/);
	});
}

test("rejects a duplicate section name", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic_topic", render: () => "first" });

	expect(() => { registry.register({ name: "schematic_topic", render: () => "second" }); }).toThrow(
		/Duplicate schematic prompt section/,
	);
});

test("propagates a failing section render", () => {
	const registry = createPromptSectionRegistry();
	registry.register({
		name: "schematic",
		render: () => {
			throw new Error("render-failure");
		},
	});

	expect(() => registry.render()).toThrow(/render-failure/);
});

// ── applyPromptSections ─────────────────────────────────────────────

const rendered = [
	{ name: "schematic_one", body: "body-one" },
	{ name: "schematic_two", body: "body-two" },
];

test("writes rendered sections into the prompt options", () => {
	const event = createBeforeAgentStartEvent();

	applyPromptSections(event, rendered);

	expect(event.systemPromptOptions.sections.schematic_one).toBe("body-one");
	expect(event.systemPromptOptions.sections.schematic_two).toBe("body-two");
});

test("leaves the prompt unforced when no earlier handler forced it", () => {
	const event = createBeforeAgentStartEvent();

	expect(applyPromptSections(event, rendered)).toBeUndefined();
});

test("appends section bodies to a prompt an earlier handler forced", () => {
	const event = createBeforeAgentStartEvent();
	event.systemPromptOptions.forceSystemPrompt = "FORCED";

	expect(applyPromptSections(event, rendered)).toStrictEqual({
		systemPrompt: "FORCED\n\n<schematic_one>\nbody-one\n</schematic_one>\n\n<schematic_two>\nbody-two\n</schematic_two>",
	});
});

test("records sections while the prompt is forced", () => {
	const event = createBeforeAgentStartEvent();
	event.systemPromptOptions.forceSystemPrompt = "FORCED";

	applyPromptSections(event, rendered);

	expect(event.systemPromptOptions.sections.schematic_one).toBe("body-one");
});

// ── Through pi's dispatch ───────────────────────────────────────────

test("keeps a section written by a later extension (regression #45)", async () => {
	const probe: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => {
			e.systemPromptOptions.sections.probe = "PROBE-SECTION";
		});
	};

	const { result, prompt } = await emitBeforeAgentStart({ after: [probe] });

	expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
	expect(prompt).toContain("<probe>\nPROBE-SECTION\n</probe>");
	expect(prompt).toContain("<schematic>");
});

test("keeps a section written by an earlier extension", async () => {
	const probe: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => {
			e.systemPromptOptions.sections.probe = "PROBE-SECTION";
		});
	};

	const { prompt } = await emitBeforeAgentStart({ before: [probe] });

	expect(prompt).toContain("<probe>\nPROBE-SECTION\n</probe>");
});

test("appends schematic's content to a prompt an earlier extension forced", async () => {
	const forcer: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => ({ systemPrompt: `${e.systemPrompt}\n\nFORCED-MARKER` }));
	};

	const { prompt } = await emitBeforeAgentStart({ before: [forcer] });

	expect(prompt).toContain("FORCED-MARKER");
	expect(prompt).toContain("## Context management");
	expect(prompt).toContain("<schematic>\n## Context management");
});

test("hands a later extension a prompt that already holds schematic's content", async () => {
	const forcer: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => ({ systemPrompt: `${e.systemPrompt}\n\nFORCED-MARKER` }));
	};

	const { prompt } = await emitBeforeAgentStart({ after: [forcer] });

	const contentIndex = prompt.indexOf("## Context management");
	const markerIndex = prompt.indexOf("FORCED-MARKER");
	expect(contentIndex, "schematic's content is missing from the prompt").toBeGreaterThanOrEqual(0);
	expect(markerIndex, "the later extension's marker is missing from the prompt").toBeGreaterThanOrEqual(0);
	expect(contentIndex, "schematic's content must precede the later extension's marker").toBeLessThan(markerIndex);
	expect(prompt).toContain("## Context management");
});

// ── Handler level ───────────────────────────────────────────────────

test("keeps the primer section byte-identical while the topic and notebook sections change", async () => {
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const beforeEvent = createBeforeAgentStartEvent();
	await handler(beforeEvent, ctx);
	const before = beforeEvent.systemPromptOptions.sections;
	expect(before.schematic).toBeDefined();

	await getTool(pi, "notebook_write").execute("1", { name: "alpha", content: "first line" }, undefined, undefined, makeTUICtx());
	await getCommand(pi, "notebook").handler("oauth", createCommandContext());
	const afterEvent = createBeforeAgentStartEvent();
	await handler(afterEvent, ctx);
	const after = afterEvent.systemPromptOptions.sections;

	expect(after.schematic).toBe(before.schematic);
	expect(after.schematic_topic).not.toBe(before.schematic_topic);
	expect(after.schematic_notebook).toBeDefined();
	expect(before.schematic_notebook).toBeUndefined();
});

for (const sectionName of ["schematic", "schematic_topic", "schematic_model_groups", "schematic_notebook"]) {
	test(`renders each section body without surrounding whitespace: ${sectionName}`, async () => withTemp(async ({ cwd }) => {
		fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
		fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { review: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
		const models = [{ provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } }];
		const modelRegistry = {
			getAll: () => models,
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: () => true,
		};
		const pi = await createTestHost();
		await getCommand(pi, "notebook").handler("oauth", createCommandContext());
		await getTool(pi, "notebook_write").execute("1", { name: "alpha", content: "first line" }, undefined, undefined, makeTUICtx());
		const handler = getHandler(pi, "before_agent_start");
		const event = createBeforeAgentStartEvent();

		await handler(event, hostContext({ hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry, getContextUsage: () => null }));

		const body = event.systemPromptOptions.sections[sectionName];
		assertPresent(body, `section ${sectionName} is missing`);
		expect(body).toBe(body.trim());
	}));
}

test("re-renders the topic and notebook sections after a handoff completes", async () => {
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	await getCommand(pi, "notebook").handler("oauth", createCommandContext());
	await getTool(pi, "notebook_write").execute("1", { name: "stale", content: "obsolete finding" }, undefined, undefined, makeTUICtx());
	await getTool(pi, "notebook_write").execute("2", { name: "keep", content: "durable decision" }, undefined, undefined, makeTUICtx());
	const beforeHandoff = createBeforeAgentStartEvent();
	await handler(beforeHandoff, ctx);
	expect(beforeHandoff.systemPromptOptions.sections.schematic_topic).toContain("Current topic: `oauth`");
	expect(beforeHandoff.systemPromptOptions.sections.schematic_notebook).toContain("  stale: obsolete finding");

	let branch: unknown[] = [];
	const handoffCtx = hostContext({
		getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
		hasUI: false,
		sessionManager: { getBranch: () => branch },
	});
	await getTool(pi, "handoff").execute(
		"handoff",
		{ nextInstruction: "continue without the stale page", discardPages: ["stale"] },
		undefined,
		undefined,
		handoffCtx,
	);
	const results = await callHandlers(pi, "turn_end", turnEndEvent({ toolResults: [handoffToolResult("handoff")] }), handoffCtx);
	branch = boundaryEntries(results).map((entry, index) => ({ ...entry, id: `entry-${index}` }));
	await callHandlers(pi, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 }, handoffCtx);
	const afterHandoff = createBeforeAgentStartEvent();
	await handler(afterHandoff, ctx);

	const sections = afterHandoff.systemPromptOptions.sections;
	expect(sections.schematic_topic).toContain("No active notebook topic is set.");
	expect(sections.schematic_notebook).toContain("  keep: durable decision");
	expect(sections.schematic_notebook).not.toContain("stale");
});
