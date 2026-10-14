import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { applyPromptSections, createPromptSectionRegistry } from "../../prompt-sections.js";
import { modelGroupsPath } from "../../model-groups/store.js";
import { createBeforeAgentStartEvent, createTestHost, emitBeforeAgentStart } from "./test-host.js";
import { withTemp } from "./model-groups-helpers.js";
import { makeTUICtx } from "./helpers.js";

// ── Registry ────────────────────────────────────────────────────────

test("renders sections in registration order", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic", render: () => "first" });
	registry.register({ name: "schematic_b", render: () => "second" });
	registry.register({ name: "schematic_a", render: () => "third" });

	assert.deepEqual(registry.render().map((section) => section.name), ["schematic", "schematic_b", "schematic_a"]);
});

test("omits a section whose body is undefined", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic_one", render: () => "body-one" });
	registry.register({ name: "schematic_absent", render: () => undefined });
	registry.register({ name: "schematic_two", render: () => "body-two" });

	assert.deepEqual(registry.render().map((section) => section.name), ["schematic_one", "schematic_two"]);
});

test("omits a section whose body is empty", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic_one", render: () => "body-one" });
	registry.register({ name: "schematic_empty", render: () => "" });
	registry.register({ name: "schematic_two", render: () => "body-two" });

	assert.deepEqual(registry.render().map((section) => section.name), ["schematic_one", "schematic_two"]);
});

for (const name of ["schematic", "schematic_model_groups"]) {
	test(`accepts names with the schematic prefix: ${name}`, () => {
		const registry = createPromptSectionRegistry();
		assert.doesNotThrow(() => registry.register({ name, render: () => "body" }));
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
		assert.throws(() => registry.register({ name, render: () => "body" }), /Invalid schematic prompt section name/);
	});
}

test("rejects a duplicate section name", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic_topic", render: () => "first" });

	assert.throws(
		() => registry.register({ name: "schematic_topic", render: () => "second" }),
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

	assert.throws(() => registry.render(), /render-failure/);
});

// ── applyPromptSections ─────────────────────────────────────────────

const rendered = [
	{ name: "schematic_one", body: "body-one" },
	{ name: "schematic_two", body: "body-two" },
];

test("writes rendered sections into the prompt options", () => {
	const event = createBeforeAgentStartEvent();

	applyPromptSections(event, rendered);

	assert.equal(event.systemPromptOptions.sections.schematic_one, "body-one");
	assert.equal(event.systemPromptOptions.sections.schematic_two, "body-two");
});

test("leaves the prompt unforced when no earlier handler forced it", () => {
	const event = createBeforeAgentStartEvent();

	assert.equal(applyPromptSections(event, rendered), undefined);
});

test("appends section bodies to a prompt an earlier handler forced", () => {
	const event = createBeforeAgentStartEvent();
	event.systemPromptOptions.forceSystemPrompt = "FORCED";

	assert.deepEqual(applyPromptSections(event, rendered), {
		systemPrompt: "FORCED\n\n<schematic_one>\nbody-one\n</schematic_one>\n\n<schematic_two>\nbody-two\n</schematic_two>",
	});
});

test("records sections while the prompt is forced", () => {
	const event = createBeforeAgentStartEvent();
	event.systemPromptOptions.forceSystemPrompt = "FORCED";

	applyPromptSections(event, rendered);

	assert.equal(event.systemPromptOptions.sections.schematic_one, "body-one");
});

// ── Through pi's dispatch ───────────────────────────────────────────

test("keeps a section written by a later extension (regression #45)", async () => {
	const probe: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => {
			e.systemPromptOptions.sections.probe = "PROBE-SECTION";
		});
	};

	const { result, prompt } = await emitBeforeAgentStart({ after: [probe] });

	assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
	assert.ok(prompt.includes("<probe>\nPROBE-SECTION\n</probe>"));
	assert.ok(prompt.includes("<schematic>"));
});

test("keeps a section written by an earlier extension", async () => {
	const probe: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => {
			e.systemPromptOptions.sections.probe = "PROBE-SECTION";
		});
	};

	const { prompt } = await emitBeforeAgentStart({ before: [probe] });

	assert.ok(prompt.includes("<probe>\nPROBE-SECTION\n</probe>"));
});

test("appends schematic's content to a prompt an earlier extension forced", async () => {
	const forcer: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => ({ systemPrompt: `${e.systemPrompt}\n\nFORCED-MARKER` }));
	};

	const { prompt } = await emitBeforeAgentStart({ before: [forcer] });

	assert.ok(prompt.includes("FORCED-MARKER"));
	assert.ok(prompt.includes("## Context management"));
	assert.ok(prompt.includes("<schematic>\n## Context management"));
});

test("hands a later extension a prompt that already holds schematic's content", async () => {
	const forcer: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (e) => ({ systemPrompt: `${e.systemPrompt}\n\nFORCED-MARKER` }));
	};

	const { prompt } = await emitBeforeAgentStart({ after: [forcer] });

	const contentIndex = prompt.indexOf("## Context management");
	const markerIndex = prompt.indexOf("FORCED-MARKER");
	assert.ok(contentIndex >= 0, "schematic's content is missing from the prompt");
	assert.ok(markerIndex >= 0, "the later extension's marker is missing from the prompt");
	assert.ok(contentIndex < markerIndex, "schematic's content must precede the later extension's marker");
	assert.ok(prompt.includes("## Context management"));
});

// ── Handler level ───────────────────────────────────────────────────

test("keeps the primer section byte-identical while the topic and notebook sections change", async () => {
	const pi = await createTestHost();
	const handler = pi.handlers.get("before_agent_start")![0];
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const beforeEvent = createBeforeAgentStartEvent();
	await handler(beforeEvent, ctx);
	const before = beforeEvent.systemPromptOptions.sections;
	assert.ok(before.schematic !== undefined);

	await pi.tools.get("notebook_write").execute("1", { name: "alpha", content: "first line" }, undefined, undefined, makeTUICtx());
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	const afterEvent = createBeforeAgentStartEvent();
	await handler(afterEvent, ctx);
	const after = afterEvent.systemPromptOptions.sections;

	assert.equal(after.schematic, before.schematic);
	assert.notEqual(after.schematic_topic, before.schematic_topic);
	assert.ok(after.schematic_notebook !== undefined && before.schematic_notebook === undefined);
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
		await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
		await pi.tools.get("notebook_write").execute("1", { name: "alpha", content: "first line" }, undefined, undefined, makeTUICtx());
		const handler = pi.handlers.get("before_agent_start")![0];
		const event = createBeforeAgentStartEvent();

		await handler(event, { hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry, getContextUsage: () => null });

		const body = event.systemPromptOptions.sections[sectionName];
		assert.ok(body !== undefined, `section ${sectionName} is missing`);
		assert.equal(body, body.trim());
	}));
}
