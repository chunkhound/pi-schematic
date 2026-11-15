import { expect, onTestFinished, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import registerSchematic from "../../index.js";
import { applyPromptSections, createPromptSectionRegistry } from "../../prompt-sections.js";
import { createModelRegistry } from "../support/model-registry.js";
import { createRunner, type RunnerFixture, type RunnerOptions } from "../support/runner.js";
import { appendDrafts } from "../support/session.js";

/** Fix the clock the date section reads, for the rest of the test. */
function fixClock(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, 12)));
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

/**
 * A headless runner over `factories` (the shipped extension when omitted) in an untrusted project
 * under the current directory, with the clock fixed for the date section.
 */
function promptRunner(options: Partial<RunnerOptions> = {}): Promise<RunnerFixture> {
	fixClock();
	return createRunner({ cwd: process.cwd(), mode: "print", context: { isProjectTrusted: () => false }, ...options });
}

/** Run before_agent_start for a user prompt through the fixture's runner. */
function emitBeforeAgentStart(fixture: RunnerFixture) {
	return fixture.runner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, fixture.systemPromptOptions());
}

/** An extension whose before_agent_start handler adds a `probe` section. */
const probe: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (e) => {
		e.systemPromptOptions.sections.probe = "PROBE-SECTION";
	});
};

/** An extension whose before_agent_start handler forces the prompt it sees plus `FORCED-MARKER`. */
const forcer: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (e) => ({ systemPrompt: `${e.systemPrompt}\n\nFORCED-MARKER` }));
};

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
		expect(() => {
			registry.register({ name, render: () => "body" });
		}).not.toThrow();
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
		expect(() => {
			registry.register({ name, render: () => "body" });
		}).toThrow(/Invalid schematic prompt section name/);
	});
}

test("rejects a duplicate section name", () => {
	const registry = createPromptSectionRegistry();
	registry.register({ name: "schematic_topic", render: () => "first" });

	expect(() => {
		registry.register({ name: "schematic_topic", render: () => "second" });
	}).toThrow(/Duplicate schematic prompt section/);
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

/** An extension that writes `rendered` through applyPromptSections. */
const sectionsWriter: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => applyPromptSections(event, rendered));
};

/** An extension whose before_agent_start handler forces the prompt to `FORCED`. */
const forceFixed: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", () => ({ systemPrompt: "FORCED" }));
};

test("writes rendered sections into the prompt options", async () => {
	const fixture = await promptRunner({ factories: [sectionsWriter] });

	const result = await emitBeforeAgentStart(fixture);

	expect(result.systemPromptOptions.sections.schematic_one).toBe("body-one");
	expect(result.systemPromptOptions.sections.schematic_two).toBe("body-two");
});

test("leaves the prompt unforced when no earlier handler forced it", async () => {
	const fixture = await promptRunner({ factories: [sectionsWriter] });

	const result = await emitBeforeAgentStart(fixture);

	expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
});

test("appends section bodies to a prompt an earlier handler forced", async () => {
	const fixture = await promptRunner({ factories: [forceFixed, sectionsWriter] });

	await emitBeforeAgentStart(fixture);

	expect(fixture.systemPrompt).toBe("FORCED\n\n<schematic_one>\nbody-one\n</schematic_one>\n\n<schematic_two>\nbody-two\n</schematic_two>");
});

test("records sections while the prompt is forced", async () => {
	const fixture = await promptRunner({ factories: [forceFixed, sectionsWriter] });

	const result = await emitBeforeAgentStart(fixture);

	expect(result.systemPromptOptions.sections.schematic_one).toBe("body-one");
});

// ── Through pi's dispatch ───────────────────────────────────────────

test("keeps a section written by a later extension (regression #45)", async () => {
	const fixture = await promptRunner({ factories: [registerSchematic, probe] });

	const result = await emitBeforeAgentStart(fixture);

	expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
	expect(fixture.systemPrompt).toContain("<probe>\nPROBE-SECTION\n</probe>");
	expect(fixture.systemPrompt).toContain("<schematic>");
});

test("keeps a section written by an earlier extension", async () => {
	const fixture = await promptRunner({ factories: [probe, registerSchematic] });

	await emitBeforeAgentStart(fixture);

	expect(fixture.systemPrompt).toContain("<probe>\nPROBE-SECTION\n</probe>");
});

test("appends schematic's content to a prompt an earlier extension forced", async () => {
	const fixture = await promptRunner({ factories: [forcer, registerSchematic] });

	await emitBeforeAgentStart(fixture);

	expect(fixture.systemPrompt).toContain("FORCED-MARKER");
	expect(fixture.systemPrompt).toContain("## Context management");
	expect(fixture.systemPrompt).toContain("<schematic>\n## Context management");
});

test("hands a later extension a prompt that already holds schematic's content", async () => {
	const fixture = await promptRunner({ factories: [registerSchematic, forcer] });

	await emitBeforeAgentStart(fixture);

	const prompt = fixture.systemPrompt;
	const contentIndex = prompt.indexOf("## Context management");
	const markerIndex = prompt.indexOf("FORCED-MARKER");
	expect(contentIndex, "schematic's content is missing from the prompt").toBeGreaterThanOrEqual(0);
	expect(markerIndex, "the later extension's marker is missing from the prompt").toBeGreaterThanOrEqual(0);
	expect(contentIndex, "schematic's content must precede the later extension's marker").toBeLessThan(markerIndex);
});

// ── Handler level ───────────────────────────────────────────────────

test("keeps the primer section byte-identical while the topic and notebook sections change", async () => {
	const fixture = await promptRunner();
	const before = (await emitBeforeAgentStart(fixture)).systemPromptOptions.sections;
	expect(before.schematic).toBeDefined();

	await fixture.tool("notebook_write").execute("1", { name: "alpha", content: "first line" });
	await fixture.command("notebook").handler("oauth", fixture.runner.createCommandContext());
	const after = (await emitBeforeAgentStart(fixture)).systemPromptOptions.sections;

	expect(after.schematic).toBe(before.schematic);
	expect(after.schematic_topic).not.toBe(before.schematic_topic);
	expect(after.schematic_notebook).toBeDefined();
	expect(before.schematic_notebook).toBeUndefined();
});

test("renders every schematic section body without surrounding whitespace", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-schematic-prompt-sections-"));
	onTestFinished(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	const configPath = path.join(cwd, ".pi", "pi-schematic", "model-groups.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		JSON.stringify({ version: 2, groups: { review: { models: [{ provider: "prompt-sections-test", modelId: "vision" }] } } }),
		"utf8",
	);
	const modelRegistry = await createModelRegistry({
		"prompt-sections-test": {
			api: "openai-completions",
			apiKey: "test-key",
			baseUrl: "http://prompt-sections-test.invalid",
			models: [
				{
					id: "vision",
					name: "Vision",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 1024,
				},
			],
		},
	});
	const fixture = await promptRunner({ cwd, modelRegistry, context: { isProjectTrusted: () => true } });
	await fixture.command("notebook").handler("oauth", fixture.runner.createCommandContext());
	await fixture.tool("notebook_write").execute("1", { name: "alpha", content: "first line" });

	const { sections } = (await emitBeforeAgentStart(fixture)).systemPromptOptions;

	const schematicSections = Object.entries(sections).filter(([name]) => name.startsWith("schematic"));
	expect(schematicSections.map(([name]) => name).sort()).toStrictEqual([
		"schematic",
		"schematic_date",
		"schematic_model_groups",
		"schematic_notebook",
		"schematic_topic",
	]);
	expect(schematicSections.filter(([, body]) => body !== body.trim())).toStrictEqual([]);
});

const ELIGIBLE_USAGE = { tokens: 50_000, percent: 25, contextWindow: 200_000 };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const TURN_MESSAGE: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "handoff", name: "handoff", arguments: {} }],
	api: "faux",
	provider: "faux",
	model: "faux",
	usage: ZERO_USAGE,
	stopReason: "toolUse",
	timestamp: 0,
};
const HANDOFF_RESULT: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "handoff",
	toolName: "handoff",
	content: [{ type: "text", text: "Handoff staged." }],
	isError: false,
	timestamp: 0,
};

test("re-renders the topic and notebook sections after a handoff completes", async () => {
	const session = SessionManager.inMemory(process.cwd());
	const fixture = await promptRunner({
		sessionManager: session,
		context: { isProjectTrusted: () => false, getContextUsage: () => ELIGIBLE_USAGE, isIdle: () => true, getSignal: () => undefined, abort: () => undefined },
		activeTools: [],
	});
	await fixture.command("notebook").handler("oauth", fixture.runner.createCommandContext());
	await fixture.tool("notebook_write").execute("1", { name: "stale", content: "obsolete finding" });
	await fixture.tool("notebook_write").execute("2", { name: "keep", content: "durable decision" });
	const beforeHandoff = (await emitBeforeAgentStart(fixture)).systemPromptOptions.sections;
	expect(beforeHandoff.schematic_topic).toContain("Current topic: `oauth`");
	expect(beforeHandoff.schematic_notebook).toContain("  stale: obsolete finding");

	await fixture.tool("handoff").execute("handoff", { nextInstruction: "continue without the stale page", discardPages: ["stale"] });
	const boundary = await fixture.runner.emitBoundary(
		{
			type: "turn_end",
			turnIndex: 0,
			message: TURN_MESSAGE,
			toolResults: [HANDOFF_RESULT],
			messageEntryId: "assistant-entry",
			toolResultEntryIds: [],
			outcome: "completed",
		},
		() => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true }),
	);
	appendDrafts(session, boundary.entries);
	await fixture.runner.emit({ type: "turn_start", turnIndex: 1, timestamp: 0 });
	const sections = (await emitBeforeAgentStart(fixture)).systemPromptOptions.sections;

	expect(sections.schematic_topic).toContain("No active notebook topic is set.");
	expect(sections.schematic_notebook).toContain("  keep: durable decision");
	expect(sections.schematic_notebook).not.toContain("stale");
});
