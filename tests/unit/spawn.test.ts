import { beforeEach, expect, test, vi, type MockInstance } from "vitest";
import {
	createExtensionRuntime,
	type AgentSession,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type ModelRegistry,
	type SessionManager,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { assertInstanceOf, assertPresent, expectPrefix, expectSuffix, isRecord } from "../assertions.js";
import { resolve } from "node:path";
import { createState, resetState, type SchematicState } from "../../state.js";
import { buildChildToolNames, createChildTools, executeSpawn, normalizeSpawnRequirements, registerSpawnTool, type SpawnParameters } from "../../spawn/index.js";
import type { SpawnResultDetails, SpawnToolResult } from "../../spawn/shared.js";
import { SpawnRouteError } from "../../model-groups/router.js";
import { createConstraintRegistry, type ConstraintRegistry } from "../../model-groups/constraints/registry.js";
import { IsObject, type TObject, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { testMaxBudget, testMinContext } from "./model-groups-constraints-fixture.js";
import { group } from "./model-groups-helpers.js";
import { createDeferred } from "../support/deferred.js";
import { assertErrorResult } from "../support/tool-result.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";
import { createRunner, toolInfo, type RunnerFixture } from "../support/runner.js";
import { createModelRegistry } from "../support/model-registry.js";
import { assistantMessage, createChildSession, toolResultMessage, userMessage, type ChildSession, type ChildSessionOptions } from "../support/session.js";

let h: TestHarness;

// ── Test helpers ─────────────────────────────────────────────────────

/** The working directory of the parent and of every child. */
const CWD = "/tmp";

/** The provider the test registries register their models under; no pi built-in provider uses it. */
const PROVIDER = "spawn-test";

/** The usage of a child whose entries record none. */
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A chat model with `fields` over placeholder metadata: no reasoning, text input, zero cost. */
function spawnModel(fields: Partial<Model<Api>> & Pick<Model<Api>, "id">): Model<Api> {
	return {
		name: fields.id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://localhost.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
		...fields,
	};
}

/** A registry whose `PROVIDER` has an API key and offers `models`, each a text model without reasoning unless it says otherwise. */
function registryWith(models: (Pick<Model<Api>, "id"> & Partial<Pick<Model<Api>, "input" | "reasoning" | "contextWindow">>)[]): Promise<ModelRegistry> {
	return createModelRegistry({
		[PROVIDER]: {
			baseUrl: "http://localhost.invalid",
			api: "openai-completions",
			apiKey: "test-key",
			models: models.map((model) => ({
				name: model.id,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
				...model,
			})),
		},
	});
}

/** The model `registry` returns for `id` under `PROVIDER`; fails the test when there is none. */
function registeredModel(registry: ModelRegistry, id: string): Model<Api> {
	const model = registry.find(PROVIDER, id);
	assertPresent(model, `the test registry has no model ${id}`);
	return model;
}

interface SpawnRunnerOptions {
	state: SchematicState;
	sessionFactory?: Parameters<typeof registerSpawnTool>[2];
	constraintRegistry?: ConstraintRegistry;
	/** The parent model `ctx.model` reports; none when omitted. */
	model?: Model<Api>;
	modelRegistry?: ModelRegistry;
	/** What `pi.getActiveTools()` reports; none when omitted. */
	activeTools?: string[];
	/** What `pi.getAllTools()` reports; every active tool as a built-in when omitted. */
	allTools?: ToolInfo[];
	/** Binds a UI, so `ctx.hasUI` is true and the fixture records notifications. */
	ui?: boolean;
}

type SpawnHost = RunnerFixture & { pi: Parameters<typeof registerSpawnTool>[0]; state: SchematicState };

/** A runner fixture that loads only the spawn tool, registered over `options.state`, with the parent thinking at "medium". */
async function spawnRunner(options: SpawnRunnerOptions): Promise<SpawnHost> {
	let api: Parameters<typeof registerSpawnTool>[0] | undefined;
	const activeTools = options.activeTools ?? [];
	const fixture = await createRunner({
		cwd: CWD,
		mode: options.ui === true ? "tui" : "print",
		factories: [
			(pi) => {
				api = pi;
				registerSpawnTool(pi, options.state, options.sessionFactory, options.constraintRegistry);
			},
		],
		modelRegistry: options.modelRegistry,
		context: { getModel: () => options.model },
		activeTools,
		actions: {
			getAllTools: () => options.allTools ?? activeTools.map((name) => toolInfo(name, "builtin")),
			getThinkingLevel: () => "medium",
		},
		ui: options.ui === true ? {} : undefined,
	});
	if (api === undefined) {
		throw new Error("The spawn factory did not run.");
	}
	// Assigned onto the fixture: a copy would read its getters, which throw until there is something to report.
	return Object.assign(fixture, { pi: api, state: options.state });
}

// Throws on details without the members every spawn result and update carries.
function assertSpawnDetails(details: unknown): asserts details is SpawnResultDetails {
	if (
		!isRecord(details) ||
		typeof details.model !== "string" ||
		typeof details.thinking !== "string" ||
		typeof details.truncated !== "boolean" ||
		typeof details.outcome !== "string"
	) {
		throw new Error(`Expected spawn result details, got ${JSON.stringify(details)}.`);
	}
}

function assertSpawnToolResult(result: unknown): asserts result is SpawnToolResult {
	if (!isRecord(result) || !isRecord(result.usage) || !Array.isArray(result.content)) {
		throw new Error("Expected a spawn result with content and usage.");
	}
	assertSpawnDetails(result.details);
	for (const block of result.content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
			throw new Error(`Expected text content, got ${JSON.stringify(block)}.`);
		}
	}
}

/** Runs the registered spawn tool as pi runs it and narrows its result to the spawn result shape. */
async function executeSpawnTool(
	host: RunnerFixture,
	toolCallId: string,
	params: SpawnParameters,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<SpawnToolResult> {
	const result: unknown = await host.tool("spawn").execute(toolCallId, params, signal, onUpdate);
	assertSpawnToolResult(result);
	return result;
}

/** Runs `executeSpawn` with the fixture's extension API, a tool context for `toolCallId` and the parent thinking "medium". */
function runExecuteSpawn(
	host: SpawnHost,
	toolCallId: string,
	params: SpawnParameters,
	sessionFactory: NonNullable<Parameters<typeof executeSpawn>[8]>,
	call: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<SpawnResultDetails> } = {},
): Promise<SpawnToolResult> {
	return executeSpawn(
		toolCallId,
		host.pi,
		host.runner.createToolContext(toolCallId, call.signal),
		host.state,
		params,
		call.signal,
		call.onUpdate,
		"medium",
		sessionFactory,
	);
}

/** What the child-session factory resolves to for `session`, with no extensions loaded. */
function sessionResult(session: AgentSession): CreateAgentSessionResult {
	return { session, extensionsResult: { extensions: [], errors: [], runtime: createExtensionRuntime() } };
}

/** An assistant message with the text `text` that ends its turn. */
function assistantText(text: string) {
	return assistantMessage([{ type: "text", text }]);
}

interface ChildOptions extends Partial<ChildSessionOptions> {
	/** The transcript once the prompt resolved; one assistant message "child result" when omitted. */
	result?: AgentSession["messages"];
	/** Records the child's entries in its session manager before spawn runs it. */
	entries?: (manager: SessionManager) => void;
}

type FactoryChild = ChildSession & { entryReads: MockInstance<SessionManager["getEntries"]> };

/**
 * A child-session factory that builds a new child from `options` on every call, its thinking level
 * "medium" unless `options` sets one; `children` lists the children in call order, each with a spy
 * on its manager's `getEntries`.
 */
function childFactory(options: ChildOptions = {}) {
	const children: FactoryChild[] = [];
	const factory = vi.fn((_config?: CreateAgentSessionOptions) => {
		const child = createChildSession(CWD, {
			thinkingLevel: options.thinkingLevel ?? "medium",
			prompt: async (text) => {
				await options.prompt?.(text);
				child.messages.push(...(options.result ?? [assistantText("child result")]));
			},
			abort: options.abort,
			dispose: options.dispose,
		});
		options.entries?.(child.sessionManager);
		const entryReads = vi.spyOn(child.sessionManager, "getEntries");
		children.push({ ...child, entryReads });
		return Promise.resolve(sessionResult(child.session));
	});
	return Object.assign(factory, { children });
}

/** The config the factory received on its first call; fails the test when it was not called. */
function firstConfig(factory: ReturnType<typeof childFactory>): CreateAgentSessionOptions {
	const config = factory.mock.calls[0]?.[0];
	assertPresent(config, "the child-session factory received a config");
	return config;
}

// The `constraints` schema of the registered spawn tool's parameters.
function spawnConstraintsSchema(host: RunnerFixture): TObject {
	const parameters = host.registeredTool("spawn").definition.parameters;
	if (!IsObject(parameters)) {
		throw new Error("The spawn parameters are not an object schema.");
	}
	const constraints = parameters.properties.constraints;
	if (!IsObject(constraints)) {
		throw new Error("The spawn constraints are not an object schema.");
	}
	return constraints;
}

function schemaDescription(schema: TSchema): string {
	if (!("description" in schema) || typeof schema.description !== "string") {
		throw new Error("The schema has no description.");
	}
	return schema.description;
}

// The `thinking` schema of the registered spawn tool's parameters, as it goes over the wire.
function thinkingWireSchema(host: RunnerFixture): Record<string, unknown> {
	const schema: unknown = JSON.parse(JSON.stringify(host.registeredTool("spawn").definition.parameters));
	if (!isRecord(schema) || !isRecord(schema.properties) || !isRecord(schema.properties.thinking)) {
		throw new Error("The spawn schema has no thinking property schema.");
	}
	return schema.properties.thinking;
}

beforeEach(() => {
	h = createTestHarness();
	return () => {
		h.teardown();
	};
});

/**
 * Starts a spawn whose child prompt fails with `primaryFailure` and whose dispose fails with
 * `cleanupFailure`. A "recording" or "throwing" UI binds one; "throwing" makes `ctx.ui.notify` throw.
 */
async function executeWithFailingCleanup(primaryFailure: unknown, cleanupFailure: unknown, ui: "headless" | "recording" | "throwing" = "headless") {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"], ui: ui !== "headless" });
	const notify = vi.spyOn(host.runner.getUIContext(), "notify");
	if (ui === "throwing") {
		notify.mockImplementation(() => {
			throw new Error("notify exploded");
		});
	}
	const factory = childFactory({
		// Rejects with any value, primitives included, on purpose; prefer-promise-reject-errors refuses Promise.reject with a non-Error.
		prompt: () =>
			new Promise<never>(() => {
				throw primaryFailure;
			}),
		dispose: () => {
			throw cleanupFailure;
		},
	});
	return {
		execution: runExecuteSpawn(host, "spawn-cleanup-failure", { prompt: "Do the task" }, factory),
		state,
		host,
		notify,
	};
}

function assertChildRegistriesCleared(state: ReturnType<typeof createState>): void {
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
}

test("spawn execute passes broad active registered tool formula to child session", async () => {
	const state = createState();
	const factory = childFactory();
	const host = await spawnRunner({
		state,
		sessionFactory: factory,
		model: spawnModel({ id: "mock-model" }),
		activeTools: ["read", "bash", "spawn", "handoff", "project_search", "phantom_tool"],
		allTools: [
			toolInfo("read", "builtin"),
			toolInfo("bash", "builtin"),
			toolInfo("spawn", "builtin"),
			toolInfo("handoff", "builtin"),
			toolInfo("project_search", "project"),
			toolInfo("inactive_registered", "extension"),
		],
	});

	await executeSpawnTool(host, "spawn-1", { prompt: "Do the task", thinking: "high" });

	const seenConfig = firstConfig(factory);
	assertPresent(seenConfig.sessionManager);
	expect(seenConfig.model?.id).toBe("mock-model");
	expect(seenConfig.thinkingLevel).toBe("high");
	expect(seenConfig.cwd).toBe(CWD);
	expect(seenConfig.sessionManager.getCwd(), "child session manager resolves ctx.cwd through Pi's native path semantics").toBe(resolve(CWD));
	expect(seenConfig.sessionManager.isPersisted(), "child transcript remains in-memory and isolated").toBe(false);
	expect(seenConfig.sessionManager.getSessionFile(), "child transcript has no parent session file").toBeUndefined();
	expect(seenConfig.sessionManager.getEntries(), "child transcript starts independently empty").toStrictEqual([]);
	expect(new Set(seenConfig.tools)).toStrictEqual(new Set(["read", "bash", "project_search", "notebook_write", "notebook_read", "notebook_index"]));
	expect(seenConfig.customTools?.map((tool) => tool.name)).toStrictEqual(["notebook_write", "notebook_read", "notebook_index"]);
});

test("spawn forwards requested thinking and reports the session effective thinking", async () => {
	const state = createState();
	const updates: AgentToolResult<unknown>[] = [];
	const factory = childFactory({ thinkingLevel: "off" });
	const host = await spawnRunner({
		state,
		sessionFactory: factory,
		model: spawnModel({ id: "non-reasoning-model", reasoning: false }),
		activeTools: ["read", "spawn"],
	});

	const result = await executeSpawnTool(host, "spawn-effective-thinking", { prompt: "Do the task", thinking: "max" }, undefined, (update) =>
		updates.push(update),
	);

	const runningDetails = updates[0].details;
	assertSpawnDetails(runningDetails);
	expect(firstConfig(factory).thinkingLevel, "requested thinking is forwarded unchanged").toBe("max");
	expect(runningDetails.thinking, "running details report Pi's effective thinking").toBe("off");
	expect(result.details.thinking, "final details report Pi's effective thinking").toBe("off");
	expect(result.details.route).toStrictEqual({ status: "inherited" });
});

test("spawn execute composes Model Group routing with readonly child guards", async () => {
	const state = createState();
	state.readonlyEnabled = true;
	const parentRegistry = await registryWith([{ id: "gpt-routed", reasoning: true }]);
	const routedModel = registeredModel(parentRegistry, "gpt-routed");
	state.modelGroups.groups = [group("review", { models: [{ provider: PROVIDER, modelId: "gpt-routed", thinkingLevel: "low" }] })];
	let seenPrompt = "";
	const factory = childFactory({
		prompt: (p) => {
			seenPrompt = p;
			return Promise.resolve();
		},
	});
	const host = await spawnRunner({
		state,
		sessionFactory: factory,
		model: spawnModel({ id: "parent" }),
		modelRegistry: parentRegistry,
		activeTools: ["read", "bash", "write", "edit", "powershell", "spawn", "handoff"],
	});

	const result = await executeSpawnTool(host, "spawn-routed", { prompt: "Do the task", group: "review", thinking: "xhigh" });

	const seenConfig = firstConfig(factory);
	expect(seenConfig.model).toStrictEqual(routedModel);
	expect(seenConfig.thinkingLevel).toBe("low");
	// Neither member is part of the options type; the copy lets the test read them.
	const configMembers: Record<string, unknown> = { ...seenConfig };
	const { modelRegistry, authStorage } = configMembers;
	expect({ modelRegistry, authStorage, modelRuntime: seenConfig.modelRuntime }).toStrictEqual({
		modelRegistry: undefined,
		authStorage: undefined,
		modelRuntime: undefined,
	});
	expect(new Set(seenConfig.tools)).toStrictEqual(new Set(["read", "bash", "notebook_write", "notebook_read", "notebook_index"]));
	expect(seenConfig.customTools).toContainEqual(expect.objectContaining({ name: "bash" }));
	expect(seenConfig.tools).not.toContain("write");
	expect(seenConfig.tools).not.toContain("edit");
	expect(seenConfig.tools).not.toContain("powershell");
	expect(seenConfig.tools).not.toContain("spawn");
	expect(seenConfig.tools).not.toContain("handoff");
	expect(seenPrompt).toMatch(/inherit readonly authority/i);
	expect(seenPrompt).toContain("[readonly] write/edit/powershell blocked; bash writes/deletions outside temp blocked");
	expect(result.details.route).toStrictEqual({ status: "routed", group: "review", provider: "spawn-test", modelId: "gpt-routed" });
});

test("readonly child without a bash tool gets the no-shell summary and no bash rules", async () => {
	const state = createState();
	state.readonlyEnabled = true;
	let seenPrompt = "";
	const host = await spawnRunner({
		state,
		sessionFactory: childFactory({
			prompt: (p) => {
				seenPrompt = p;
				return Promise.resolve();
			},
		}),
		model: spawnModel({ id: "parent" }),
		activeTools: ["read", "powershell", "edit", "write"],
	});

	await executeSpawnTool(host, "spawn-no-shell", { prompt: "Do the task" });

	expect(seenPrompt).toContain("[readonly] write/edit/powershell blocked; this readonly child has no shell tool.");
	expect(seenPrompt).not.toContain("bash writes/deletions outside temp blocked");
});

test("spawn routes capability requirements to capable members via random selection on the filtered pool", async () => {
	const state = createState();
	state.modelGroups.groups = [
		{
			...group("multi", {
				models: [
					{ provider: PROVIDER, modelId: "gpt-cap-a" },
					{ provider: PROVIDER, modelId: "gpt-cap-b" },
					{ provider: PROVIDER, modelId: "gpt-text" },
				],
				constraints: { modalities: ["text", "image"] },
			}),
			modalities: { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] },
		},
	];
	const factory = childFactory();
	const host = await spawnRunner({
		state,
		sessionFactory: factory,
		model: spawnModel({ id: "parent" }),
		modelRegistry: await registryWith([
			{ id: "gpt-cap-a", reasoning: true, input: ["text", "image"] },
			{ id: "gpt-cap-b", reasoning: true, input: ["text", "image"] },
			{ id: "gpt-text", reasoning: true, input: ["text"] },
		]),
		activeTools: ["read", "bash", "spawn"],
	});
	// Deterministic random draws: first spawn lands on the first capable member,
	// the second on the second — proving selection is random over the filtered pool.
	const originalRandom = Math.random;
	let draw = 0;
	Math.random = () => (draw++ === 0 ? 0.05 : 0.95);
	try {
		await executeSpawnTool(host, "spawn-a", { prompt: "t", group: "multi", constraints: { modalities: { required: ["image"] } } });
		await executeSpawnTool(host, "spawn-b", { prompt: "t", group: "multi", constraints: { modalities: { required: ["image"] } } });
	} finally {
		Math.random = originalRandom;
	}
	const seenModels = factory.mock.calls.map(([config]) => config?.model?.id);
	expect(seenModels, "each spawn draws a capable member from the filtered pool; non-capable members are never selected").toStrictEqual([
		"gpt-cap-a",
		"gpt-cap-b",
	]);
});

test("spawn injects a capability ceiling notice for a routed group with image disabled", async () => {
	const state = createState();
	state.notebookPages.set("entry-a", "preview\nbody");
	state.modelGroups.groups = [
		{
			...group("quick", { models: [{ provider: PROVIDER, modelId: "gpt-vision" }], constraints: { modalities: ["text", "reasoning"] } }),
			modalities: {
				common: ["text", "reasoning"],
				supported: ["text", "image", "reasoning"],
				effective: ["text", "reasoning"],
			},
		},
	];
	let seenPrompt = "";
	const host = await spawnRunner({
		state,
		sessionFactory: childFactory({
			prompt: (p) => {
				seenPrompt = p;
				return Promise.resolve();
			},
		}),
		model: spawnModel({ id: "parent" }),
		modelRegistry: await registryWith([{ id: "gpt-vision", reasoning: true, input: ["text", "image"] }]),
		activeTools: ["read", "bash", "spawn"],
	});
	await executeSpawnTool(host, "spawn-quick", { prompt: "Read the image in file.png", group: "quick" });
	expect(seenPrompt).toMatch(/## Model Group capability ceiling/i);
	expect(seenPrompt).toMatch(/image input is disabled/i);
	expect(seenPrompt).toMatch(/report the capability mismatch/i);
});

test("spawn injects descriptor-provided scalar capability ceilings", async () => {
	const state = createState();
	state.modelGroups.groups = [
		{
			...group("context-capped", {
				models: [
					{ provider: PROVIDER, modelId: "small" },
					{ provider: PROVIDER, modelId: "large" },
				],
				constraints: { testMinContext: 50 },
			}),
			modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
		},
	];
	let seenPrompt = "";
	const host = await spawnRunner({
		state,
		sessionFactory: childFactory({
			prompt: (prompt) => {
				seenPrompt = prompt;
				return Promise.resolve();
			},
		}),
		constraintRegistry: createConstraintRegistry([testMinContext]),
		model: spawnModel({ id: "parent", contextWindow: 100 }),
		modelRegistry: await registryWith([
			{ id: "small", contextWindow: 10 },
			{ id: "large", contextWindow: 100 },
		]),
		activeTools: ["read", "bash", "spawn"],
	});
	await executeSpawnTool(host, "spawn-context-cap", { prompt: "Do the task", group: "context-capped" });
	expect(seenPrompt).toMatch(/## Model Group capability ceiling/i);
	expect(seenPrompt).toMatch(/minimum context is capped at 50 tokens/i);
});

test("spawn execute builds prompt with notebook pages and task", async () => {
	const state = createState();
	state.notebookPages.set("entry-a", "preview line\nfull body");

	let seenPrompt = "";
	const host = await spawnRunner({
		state,
		sessionFactory: childFactory({
			prompt: (p) => {
				seenPrompt = p;
				return Promise.resolve();
			},
		}),
		model: spawnModel({ id: "mock-model" }),
		activeTools: ["read", "bash", "spawn"],
	});

	await executeSpawnTool(host, "spawn-1", { prompt: "Do the task" });

	// Verify user-facing invariants: task text is included, notebook pages are referenced
	expect(seenPrompt).toMatch(/Do the task/);
	expect(seenPrompt).toMatch(/entry-a: preview line/);
	expect(seenPrompt).toMatch(/durable shared memory for the parent and future contexts/i);
	expectSuffix(seenPrompt, "Keep the result under 2000 lines / 50 KiB (51200 bytes).");
});

test("spawn emits no capability notice when the routed group has no explicit override", async () => {
	const state = createState();
	state.modelGroups.groups = [group("open", { models: [{ provider: PROVIDER, modelId: "gpt-vision" }] })];
	let seenPrompt = "";
	const host = await spawnRunner({
		state,
		sessionFactory: childFactory({
			prompt: (p) => {
				seenPrompt = p;
				return Promise.resolve();
			},
		}),
		model: spawnModel({ id: "parent" }),
		modelRegistry: await registryWith([{ id: "gpt-vision", reasoning: true, input: ["text", "image"] }]),
		activeTools: ["read", "bash", "spawn"],
	});
	await executeSpawnTool(host, "spawn-open", { prompt: "Do the task", group: "open" });
	expect(seenPrompt).not.toMatch(/capability ceiling/i);
	expect(seenPrompt).not.toMatch(/image input is disabled/i);
});

// ── Build child tool names ─────────────────────────────────────────

test.each([
	{
		label: "MCP extension",
		parentToolNames: ["read", "chunkhound_code_research", "mcp_status"],
		availableTools: [toolInfo("read", "builtin"), toolInfo("chunkhound_code_research", "extension"), toolInfo("mcp_status", "extension")],
		expected: ["read", "chunkhound_code_research", "mcp_status", "notebook_write", "notebook_read", "notebook_index"],
	},
	{
		label: "project package and local extension",
		parentToolNames: ["project_search", "package_lint", "local_helper"],
		availableTools: [toolInfo("project_search", "project"), toolInfo("package_lint", "package"), toolInfo("local_helper", "local")],
		expected: ["project_search", "package_lint", "local_helper", "notebook_write", "notebook_read", "notebook_index"],
	},
])("child tool names inherit active registered extension tools: $label", async ({ parentToolNames, availableTools, expected }) => {
	const state = createState();
	const host = await spawnRunner({ state });
	expect(buildChildToolNames(parentToolNames, createChildTools(host.pi, state), availableTools)).toStrictEqual(expected);
});

test("spawn execute derives result stats from the child entries", async () => {
	const state = createState();

	const updates: AgentToolResult<unknown>[] = [];
	const host = await spawnRunner({
		state,
		sessionFactory: childFactory({
			thinkingLevel: "high",
			entries: (manager) => {
				manager.appendMessage(
					assistantMessage([{ type: "text", text: "child result" }], {
						usage: {
							input: 11,
							output: 22,
							cacheRead: 3,
							cacheWrite: 4,
							totalTokens: 999,
							cost: { input: 0.1, output: 0.2, cacheRead: 0.1, cacheWrite: 0.1, total: 0.5 },
						},
					}),
				);
			},
		}),
		model: spawnModel({ id: "mock-model" }),
		activeTools: ["read", "bash", "spawn"],
	});

	const result = await executeSpawnTool(host, "spawn-1", { prompt: "Do the task", thinking: "high" }, undefined, (update) => updates.push(update));

	expect(updates).toStrictEqual([
		{
			content: [],
			details: { model: "mock-model", thinking: "high", truncated: false, outcome: "running", route: { status: "inherited" } },
		},
	]);
	expect(result.content[0].text).toBe("child result");
	expect(result.details.outcome).toBe("success");
	expect(result.details.stats).toStrictEqual({
		inputTokens: 11,
		outputTokens: 22,
		cacheReadTokens: 3,
		cacheWriteTokens: 4,
		totalTokens: 40,
		cost: 0.5,
		turns: 1,
	});
});

// ── Child usage ──────────────────────────────────────────────────────

/** `error` as a SpawnRouteError; fails the test unless it is one. */
function routeErrorOf(error: unknown, message?: string): SpawnRouteError {
	assertInstanceOf(error, SpawnRouteError, message);
	return error;
}

/** Runs the registered spawn tool for a parent "mock-model" with a child built from `opts`. */
async function executeWithChild(opts: ChildOptions = {}) {
	const state = createState();
	const host = await spawnRunner({
		state,
		sessionFactory: childFactory(opts),
		model: spawnModel({ id: "mock-model" }),
		activeTools: ["read", "bash", "spawn"],
	});
	return executeSpawnTool(host, "spawn-usage", { prompt: "Do the task" });
}

/** A usage with these token counts and `cost`, without the optional splits. */
function usageOf(input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number, cost: Usage["cost"]): Usage {
	return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

test("spawn execute returns the child usage summed over every counted entry kind", async () => {
	// Each entry kind owns one decimal place, so a missing or doubled entry shows in the totals.
	const result = await executeWithChild({
		entries: (manager) => {
			manager.appendMessage(userMessage("task"));
			const answerId = manager.appendMessage(
				assistantMessage([{ type: "text", text: "child result" }], {
					usage: { ...usageOf(1, 2, 3, 4, 10, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 }), cacheWrite1h: 1 },
				}),
			);
			manager.appendCompaction("s", answerId, 1, undefined, false, {
				...usageOf(100, 200, 300, 400, 1000, { input: 500, output: 600, cacheRead: 700, cacheWrite: 800, total: 2600 }),
				reasoning: 100,
			});
			manager.branchWithSummary(
				answerId,
				"s",
				undefined,
				false,
				usageOf(1000, 2000, 3000, 4000, 10000, { input: 5000, output: 6000, cacheRead: 7000, cacheWrite: 8000, total: 26000 }),
			);
			manager.appendMessage(
				toolResultMessage("ext", "ext_tool", {
					...usageOf(10, 20, 30, 40, 100, { input: 50, output: 60, cacheRead: 70, cacheWrite: 80, total: 260 }),
					reasoning: 10,
				}),
			);
			manager.appendMessage(toolResultMessage("plain", "read"));
			manager.appendUsage("cache_warm", "p", "m", {
				...usageOf(10000, 20000, 30000, 40000, 100000, { input: 50000, output: 60000, cacheRead: 70000, cacheWrite: 80000, total: 260000 }),
				cacheWrite1h: 10000,
			});
			manager.appendModelChange("p", "m2");
		},
	});

	expect(result.usage).toStrictEqual({
		input: 11111,
		output: 22222,
		cacheRead: 33333,
		cacheWrite: 44444,
		cacheWrite1h: 10001,
		reasoning: 110,
		totalTokens: 111110,
		cost: { input: 55555, output: 66666, cacheRead: 77777, cacheWrite: 88888, total: 288886 },
	});
});

test("spawn execute omits cacheWrite1h and reasoning when no counted usage reports them", async () => {
	const result = await executeWithChild({
		entries: (manager) => {
			manager.appendMessage(
				assistantMessage([{ type: "text", text: "child result" }], {
					usage: usageOf(7, 3, 0, 0, 10, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }),
				}),
			);
			manager.appendUsage("cache_warm", "p", "m", usageOf(1, 0, 2, 0, 3, { input: 1, output: 0, cacheRead: 1, cacheWrite: 0, total: 2 }));
		},
	});

	expect(result.usage).toStrictEqual({
		input: 8,
		output: 3,
		cacheRead: 2,
		cacheWrite: 0,
		totalTokens: 13,
		cost: { input: 2, output: 2, cacheRead: 1, cacheWrite: 0, total: 5 },
	});
	expect(result.usage).not.toHaveProperty("cacheWrite1h");
	expect(result.usage).not.toHaveProperty("reasoning");
});

test("an undefined optional child usage field is treated as absent", async () => {
	const result = await executeWithChild({
		entries: (manager) => {
			manager.appendMessage(
				assistantMessage([{ type: "text", text: "child result" }], {
					usage: { ...usageOf(7, 3, 2, 1, 13, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }), cacheWrite1h: undefined },
				}),
			);
		},
	});

	expect(result.usage).toStrictEqual({
		input: 7,
		output: 3,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 13,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	});
});

test("child turns count assistants but not users or tool results", async () => {
	const result = await executeWithChild({
		entries: (manager) => {
			manager.appendMessage(userMessage("task"));
			manager.appendMessage(
				assistantMessage([{ type: "text", text: "child result" }], {
					usage: usageOf(1, 2, 0, 0, 3, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
				}),
			);
			manager.appendMessage(toolResultMessage("tool-call", "read"));
		},
	});

	expect(result.details.stats?.turns).toBe(1);
});

test("spawn execute counts a compaction or branch summary only when it carries usage", async () => {
	const result = await executeWithChild({
		entries: (manager) => {
			manager.appendCompaction("s", null, 1);
			manager.branchWithSummary(null, "s");
			manager.appendMessage(
				assistantMessage([{ type: "text", text: "child result" }], {
					usage: usageOf(7, 3, 0, 0, 10, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }),
				}),
			);
		},
	});

	expect(result.usage).toStrictEqual({
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
	});
});

test("a spawn whose child entries cannot be read rejects with the read error", async () => {
	const execution = executeWithChild({
		entries: (manager) => {
			vi.spyOn(manager, "getEntries").mockImplementation(() => {
				throw new Error("child entries unreadable");
			});
		},
	});

	await expect(execution).rejects.toThrow(new Error("child entries unreadable"));
});

test("aborted spawn returns the partial child usage", async () => {
	const state = createState();
	const controller = new AbortController();
	let promptStarted!: () => void;
	let resolvePrompt!: () => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	// Pi's prompt resolves once an abort stops the run, leaving an aborted assistant message.
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		},
		abort: () => {
			resolvePrompt();
			return Promise.resolve();
		},
		result: [assistantMessage([], { stopReason: "aborted" })],
		entries: (manager) => {
			manager.appendMessage(
				assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }], {
					stopReason: "toolUse",
					usage: usageOf(40, 5, 0, 0, 45, { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5 }),
				}),
			);
			manager.appendMessage(
				assistantMessage([], { stopReason: "aborted", usage: usageOf(60, 2, 10, 0, 72, { input: 6, output: 1, cacheRead: 1, cacheWrite: 0, total: 8 }) }),
			);
		},
	});
	const host = await spawnRunner({ state, sessionFactory: factory, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });

	const execution = executeSpawnTool(host, "spawn-aborted-usage", { prompt: "Do the task" }, controller.signal);
	await started;
	controller.abort();
	const result = await execution;

	expect(result.details.outcome).toBe("aborted");
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toBe("Child agent aborted: This operation was aborted");
	expect(result.usage).toStrictEqual({
		input: 100,
		output: 7,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: 117,
		cost: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, total: 13 },
	});
	expect(factory.children[0].dispose, "mid-prompt abort disposes exactly once").toHaveBeenCalledOnce();
	assertChildRegistriesCleared(state);
});

test("a child model error keeps its failure message and earlier partial text", async () => {
	const result = await executeWithChild({
		result: [assistantText("partial answer"), assistantMessage([], { stopReason: "error", errorMessage: "provider failed" })],
	});

	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("error");
	expect(result.content[0].text).toBe("Child agent failed: provider failed\n\npartial answer");
});

test("a child model error without text still names the failure", async () => {
	const result = await executeWithChild({ result: [assistantMessage([], { stopReason: "error" })] });

	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("error");
	expect(result.content[0].text).toBe("Child agent failed: no error message");
});

test("a child model error with an empty error message reports no error message", async () => {
	const result = await executeWithChild({ result: [assistantMessage([], { stopReason: "error", errorMessage: "" })] });

	expect(result.isError).toBe(true);
	expect(result.content).toStrictEqual([{ type: "text", text: "Child agent failed: no error message" }]);
});

test("a child abort includes its reported error message", async () => {
	const result = await executeWithChild({
		result: [assistantMessage([], { stopReason: "aborted", errorMessage: "cancelled by provider" })],
	});

	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("Child agent aborted: cancelled by provider");
});

test("a failed child abort during the prompt is reported through the UI notice", async () => {
	const state = createState();
	const controller = new AbortController();
	let promptStarted!: () => void;
	let resolvePrompt!: () => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		},
		abort: () =>
			new Promise<never>(() => {
				resolvePrompt();
				throw new Error("abort failed");
			}),
	});
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), ui: true });
	const execution = runExecuteSpawn(host, "spawn-abort-failure", { prompt: "Do the task" }, factory, { signal: controller.signal });
	await started;
	controller.abort();

	const result = await execution;
	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("Child agent aborted: This operation was aborted\n\nchild result");
	expect(host.ui.notifications).toStrictEqual([{ message: "Spawn cleanup failed: abort failed", type: "error" }]);
});

// ── Usage of a spawn that fails ──────────────────────────────────────

function appendFailedChildEntries(manager: SessionManager): void {
	manager.appendMessage(
		assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }], {
			stopReason: "toolUse",
			usage: usageOf(30, 4, 2, 0, 36, { input: 3, output: 1, cacheRead: 1, cacheWrite: 0, total: 5 }),
		}),
	);
	manager.appendMessage(assistantMessage([], { usage: usageOf(50, 0, 8, 1, 59, { input: 5, output: 0, cacheRead: 2, cacheWrite: 1, total: 8 }) }));
}

const FAILED_CHILD_USAGE = {
	input: 80,
	output: 4,
	cacheRead: 10,
	cacheWrite: 1,
	totalTokens: 95,
	cost: { input: 8, output: 1, cacheRead: 3, cacheWrite: 1, total: 13 },
};

function failedSpawnResult(text: string) {
	return {
		content: [{ type: "text", text }],
		details: {
			model: "mock-model",
			thinking: "high",
			truncated: false,
			outcome: "error",
			route: { status: "inherited" },
			stats: { inputTokens: 80, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 1, totalTokens: 95, cost: 13, turns: 2 },
		},
		usage: FAILED_CHILD_USAGE,
		isError: true,
	};
}

/**
 * A spawn tool for a parent "mock-model" whose child runs at "high" thinking with the failed child's
 * entries unless `opts` says otherwise; `hostOptions` replaces the parent model or binds a UI.
 */
async function hostWithFailedUsage(opts: ChildOptions, hostOptions: Pick<SpawnRunnerOptions, "model" | "ui"> = {}) {
	const state = createState();
	const factory = childFactory({ thinkingLevel: "high", entries: appendFailedChildEntries, ...opts });
	const host = await spawnRunner({
		state,
		sessionFactory: factory,
		model: spawnModel({ id: "mock-model" }),
		activeTools: ["read", "bash", "spawn"],
		...hostOptions,
	});
	return {
		state,
		host,
		factory,
		/** How often spawn read the entries of its one child. */
		get entryReads() {
			return factory.children[0].entryReads.mock.calls.length;
		},
		execute: (toolCallId: string, signal?: AbortSignal) => executeSpawnTool(host, toolCallId, { prompt: "Do the task", thinking: "high" }, signal),
	};
}

test("a spawn whose child prompt fails returns an error result with the child usage read once", async () => {
	const host = await hostWithFailedUsage({
		prompt: () =>
			new Promise<never>(() => {
				throw new Error("prompt failed");
			}),
	});

	expect(await host.execute("spawn-prompt-error")).toStrictEqual(failedSpawnResult("prompt failed"));
	expect(host.entryReads).toBe(1);
	assertChildRegistriesCleared(host.state);
});

test("a spawn whose child prompt rejects with a non-Error value returns its string form as an error result", async () => {
	const host = await hostWithFailedUsage({
		prompt: () =>
			new Promise<never>(() => {
				throw "boom-string";
			}),
	});

	expect(await host.execute("spawn-prompt-non-error")).toStrictEqual(failedSpawnResult("boom-string"));
	assertChildRegistriesCleared(host.state);
});

test("a spawn whose child produces no output returns an error result with the child usage", async () => {
	const host = await hostWithFailedUsage({ result: [] });

	expect(await host.execute("spawn-no-output")).toStrictEqual(failedSpawnResult("Child agent produced no output."));
	assertChildRegistriesCleared(host.state);
});

test("a completed spawn whose dispose fails returns the dispose error with the child usage read once", async () => {
	const host = await hostWithFailedUsage({
		dispose: () => {
			throw new Error("dispose failed");
		},
	});

	expect(await host.execute("spawn-dispose-failure")).toStrictEqual(failedSpawnResult("dispose failed"));
	expect(host.entryReads).toBe(1);
	assertChildRegistriesCleared(host.state);
});

test("a spawn invalidated by a reset after its prompt started returns an error result with the child usage", async () => {
	const resetInPrompt: { run: () => void } = { run: vi.fn() };
	const host = await hostWithFailedUsage({
		prompt: () => {
			resetInPrompt.run();
			return Promise.resolve();
		},
	});
	resetInPrompt.run = () => {
		resetState(host.state);
	};

	expect(await host.execute("spawn-reset-mid-run")).toStrictEqual(failedSpawnResult("Spawn invalidated by reset."));
	assertChildRegistriesCleared(host.state);
});

test("a parent abort between child creation and the prompt returns an aborted result", async () => {
	const controller = new AbortController();
	const reason = new Error("aborted before start");
	controller.abort(reason);
	let prompts = 0;
	const host = await hostWithFailedUsage({
		prompt: () => {
			prompts++;
			return Promise.resolve();
		},
	});

	const result = await host.execute("spawn-aborted-early", controller.signal);
	expect(result.isError).toBe(true);
	expect(result.details).toStrictEqual({
		model: "mock-model",
		thinking: "high",
		truncated: false,
		outcome: "aborted",
		route: { status: "inherited" },
		stats: { inputTokens: 80, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 1, totalTokens: 95, cost: 13, turns: 2 },
	});
	expect(result.content[0].text).toBe("Child agent aborted: aborted before start");
	expect(result.usage).toStrictEqual(FAILED_CHILD_USAGE);
	expect(prompts).toBe(0);
	expect(host.entryReads).toBe(1);
});

// ── Result truncation ───────────────────────────────────────────────

// pi's DEFAULT_MAX_LINES is 2000 and DEFAULT_MAX_BYTES is 51200 (50 KiB); the sizes below are those limits written out.
const TRUNCATION_MARKER = "\n\n[Result truncated to 2000 lines / 50 KiB (51200 bytes). Spawn a new child with a narrower request if more is needed.]";

async function executeWithChildText(text: string) {
	return executeWithChild({ result: [assistantText(text)] });
}

test("spawn result over the line limit keeps the first lines up to the limit and names the limits", async () => {
	const lines = Array.from({ length: 2001 }, (_, i) => `line ${i}`);
	expect(Buffer.byteLength(lines.slice(0, 2000).join("\n")), "kept lines must fit in the byte limit").toBeLessThanOrEqual(51200);
	const result = await executeWithChildText(lines.join("\n"));

	expect(result.details.truncated).toBe(true);
	expect(result.content[0].text).toBe(lines.slice(0, 2000).join("\n") + TRUNCATION_MARKER);
});

test("spawn result at the line limit is not truncated", async () => {
	const text = Array(2000).fill("x").join("\n");
	expect(Buffer.byteLength(text), "text must fit in the byte limit").toBeLessThanOrEqual(51200);
	const result = await executeWithChildText(text);

	expect(result.details.truncated).toBe(false);
});

test("spawn result at the byte limit is not truncated", async () => {
	const result = await executeWithChildText("a".repeat(51200));

	expect(result.details.truncated).toBe(false);
	expect(result.content[0].text).toBe("a".repeat(51200));
});

test("spawn result retains an untruncated lone surrogate", async () => {
	const text = "ab\uD800cd";
	const result = await executeWithChildText(text);

	expect(result.details.truncated).toBe(false);
	expect(result.content[0].text).toBe(text);
});

test.each([
	{
		name: "spawn result one byte over the byte limit is truncated",
		input: "a".repeat(51201),
		expectedText: "a".repeat(51200) + TRUNCATION_MARKER,
	},
	{
		name: "spawn result keeps the head of an oversized first line when more lines follow",
		input: "z".repeat(51201) + "\nsecond",
		expectedText: "z".repeat(51200) + TRUNCATION_MARKER,
	},
	{
		// 17 067 characters take 51 201 bytes; the byte limit falls inside the last one, so the cut backs off to 17 066.
		name: "spawn result cuts an oversized line of 3-byte characters on a character boundary",
		input: "語".repeat(17067),
		expectedText: "語".repeat(17066) + TRUNCATION_MARKER,
	},
	{
		// One byte and 12 800 emoji take 51 201 bytes; the byte limit falls inside the last emoji, so the cut backs off to 12 799.
		name: "spawn result cuts an oversized line of surrogate pairs without splitting one",
		input: "x" + "😀".repeat(12800),
		expectedText: "x" + "😀".repeat(12799) + TRUNCATION_MARKER,
	},
])("$name", async ({ input, expectedText }) => {
	const result = await executeWithChildText(input);

	expect(result.details.truncated).toBe(true);
	expect(result.content[0].text).toBe(expectedText);
});

test("a long prompt failure is truncated at the result byte limit", async () => {
	const host = await hostWithFailedUsage({
		prompt: () =>
			new Promise<never>(() => {
				throw new Error("a".repeat(51201));
			}),
	});

	const result = await host.execute("spawn-long-error");

	expect(result.isError).toBe(true);
	expect(result.details.truncated).toBe(true);
	expect(result.content[0].text).toBe("a".repeat(51200) + TRUNCATION_MARKER);
});

test("spawn result trims a trailing newline before applying result limits", async () => {
	const expected = Array(2000).fill("x").join("\n");
	expect(Buffer.byteLength(expected), "trimmed text must fit in the byte limit").toBeLessThanOrEqual(51200);
	const result = await executeWithChildText("x\n".repeat(2000));

	expect(result.content[0].text).toBe(expected);
});

test("spawn result over the byte limit keeps the byte-limited head", async () => {
	// 513 lines of 100 bytes each with its newline pass the byte limit and stay within the line limit.
	const result = await executeWithChildText(Array(513).fill("a".repeat(99)).join("\n"));

	expect(result.details.truncated).toBe(true);
	expectSuffix(result.content[0].text, TRUNCATION_MARKER);
	expect(Buffer.byteLength(result.content[0].text.slice(0, -TRUNCATION_MARKER.length))).toBe(51200);
});

test("spawn result keeps a UTF-8-safe head when a multi-byte line straddles the byte limit", async () => {
	// 51 197 bytes, a newline and two 3-byte euro signs end 4 bytes past the limit, which falls inside the first euro sign.
	const result = await executeWithChildText("a".repeat(51197) + "\n€€");

	expect(result.details.truncated).toBe(true);
	expect(result.content[0].text).toBe("a".repeat(51197) + "\n" + TRUNCATION_MARKER);
});

test("spawn result retains the byte-limited prefix of a long second line", async () => {
	const result = await executeWithChildText(`short\n${"b".repeat(51200)}`);
	expectSuffix(result.content[0].text, TRUNCATION_MARKER);
	const content = result.content[0].text.slice(0, -TRUNCATION_MARKER.length);

	expect(Buffer.byteLength(content)).toBe(51200);
	expectPrefix(content, "short\nb");
});

test("headless spawn aggregates Error and cleanup failures without mutating the primary error", async () => {
	const originalCause = new Error("original cause");
	const primaryFailure = new Error("prompt failed", { cause: originalCause });
	const cleanupFailure = new Error("dispose failed");
	Object.freeze(primaryFailure);
	const { execution, state } = await executeWithFailingCleanup(primaryFailure, cleanupFailure);

	assertErrorResult(await execution, "Spawn failed and cleanup failed: prompt failed; dispose failed", ZERO_USAGE);
	expect(primaryFailure.cause).toBe(originalCause);
	assertChildRegistriesCleared(state);
});

test("headless spawn aggregates primitive and cleanup failures", async () => {
	const primaryFailure = "prompt failed";
	const cleanupFailure = new Error("dispose failed");
	const { execution, state } = await executeWithFailingCleanup(primaryFailure, cleanupFailure);

	assertErrorResult(await execution, "Spawn failed and cleanup failed: prompt failed; dispose failed", ZERO_USAGE);
	assertChildRegistriesCleared(state);
});

test("UI spawn notifies when cleanup also fails after a primary failure", async () => {
	const { execution, state, host } = await executeWithFailingCleanup(new Error("prompt failed"), new Error("dispose failed"), "recording");

	assertErrorResult(await execution, "prompt failed", ZERO_USAGE);
	expect(host.ui.notifications).toStrictEqual([{ message: "Spawn cleanup failed: dispose failed", type: "error" }]);
	assertChildRegistriesCleared(state);
});

test("UI spawn names both failures when the cleanup notice throws", async () => {
	const { execution, state, notify } = await executeWithFailingCleanup(new Error("prompt failed"), new Error("dispose failed"), "throwing");

	assertErrorResult(await execution, "Spawn failed and cleanup failed: prompt failed; dispose failed", ZERO_USAGE);
	expect(notify).toHaveBeenCalledOnce();
	assertChildRegistriesCleared(state);
});

test("spawn execute fails explicitly without a configured model", async () => {
	const host = await hostWithFailedUsage({}, { model: undefined });
	await expect(host.execute("spawn-1")).rejects.toThrow(/No model configured\. Cannot spawn child agent\./);
	expect(host.factory, "no child session is created before the rejection").toHaveBeenCalledTimes(0);
});

test("a rejecting child session factory rejects spawn before a session exists", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }) });

	await expect(
		runExecuteSpawn(
			host,
			"spawn-factory-rejection",
			{ prompt: "Do the task" },
			() =>
				new Promise<never>(() => {
					throw new Error("factory unavailable");
				}),
		),
	).rejects.toThrow(/factory unavailable/);
	assertChildRegistriesCleared(state);
});

test.each([
	{
		label: "no-usable-models",
		unusable: { ...group("broken", { models: [{ provider: "spawn-test-missing", modelId: "missing" }] }), sourcePath: "<test>" },
		reason: "no-usable-models",
	},
	{ label: "empty", unusable: group("broken"), reason: "empty" },
])("executeSpawn propagates unusable-group errors before creating child work: $label", async ({ unusable, reason }) => {
	const state = createState();
	state.modelGroups.groups = [{ ...unusable, validation: { ...unusable.validation, degraded: true } }];
	const host = await spawnRunner({
		state,
		model: spawnModel({ id: "parent" }),
		modelRegistry: await createModelRegistry({}),
		activeTools: ["read", "bash", "spawn"],
	});
	const sessionFactory = vi.fn(
		() =>
			new Promise<never>(() => {
				throw new Error("sessionFactory must not be called");
			}),
	);

	await expect(runExecuteSpawn(host, "spawn-route-error", { prompt: "Do the task", group: "broken" }, sessionFactory)).rejects.toSatisfy((error: unknown) => {
		const routeError = routeErrorOf(error, "route error must propagate without wrapping");
		expect(routeError.kind).toBe("unusable-group");
		expect(routeError.group).toBe("broken");
		expect(routeError.reason).toBe(reason);
		return true;
	});

	expect(sessionFactory, "sessionFactory must not be called on routing failure").not.toHaveBeenCalled();
	expect(state.childSessions.size, "no child session registered").toBe(0);
	expect(state.liveChildSessions.size, "no live child session registered").toBe(0);
});

test("executeSpawn propagates missing modalities before creating child work", async () => {
	const state = createState();
	state.modelGroups.groups = [
		{
			name: "text-only",
			scope: "project",
			sourcePath: "<test>",
			models: [{ provider: PROVIDER, modelId: "text" }],
			modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
			validation: { unavailableRefs: [], shadowedByProject: false, degraded: false },
			evaluations: [],
		},
	];
	const host = await spawnRunner({
		state,
		model: spawnModel({ id: "parent", input: ["text"], reasoning: false }),
		modelRegistry: await registryWith([{ id: "text" }]),
	});
	const sessionFactory = vi.fn(
		() =>
			new Promise<never>(() => {
				throw new Error("must not create child");
			}),
	);
	await expect(
		runExecuteSpawn(
			host,
			"missing-modality",
			{ prompt: "Do the task", group: "text-only", constraints: { modalities: { required: ["image"] } } },
			sessionFactory,
		),
	).rejects.toSatisfy((error: unknown) => {
		expect(routeErrorOf(error).reason).toBe("missing-modality");
		return true;
	});
	expect(sessionFactory).not.toHaveBeenCalled();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("executeSpawn rejects unknown requirements before factory or session publication", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "parent", input: ["text"], reasoning: false }) });
	const sessionFactory = vi.fn(
		() =>
			new Promise<never>(() => {
				throw new Error("must not create child");
			}),
	);
	await expect(runExecuteSpawn(host, "unknown-constraint", { prompt: "Do the task", constraints: { unknown: {} } }, sessionFactory)).rejects.toThrow(
		/Unknown spawn constraint/,
	);
	expect(sessionFactory).not.toHaveBeenCalled();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("registered spawn tool rejects missing modalities before creating child work", async () => {
	const state = createState();
	state.modelGroups.groups = [
		{
			name: "text-only",
			scope: "project",
			sourcePath: "<test>",
			models: [{ provider: PROVIDER, modelId: "text" }],
			modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
			validation: { unavailableRefs: [], shadowedByProject: false, degraded: false },
			evaluations: [],
		},
	];
	const sessionFactory = vi.fn(
		() =>
			new Promise<never>(() => {
				throw new Error("sessionFactory must not be called");
			}),
	);
	const host = await spawnRunner({
		state,
		sessionFactory,
		model: spawnModel({ id: "parent", input: ["text"], reasoning: false }),
		modelRegistry: await registryWith([{ id: "text" }]),
		activeTools: ["read", "bash", "spawn"],
	});

	await expect(
		executeSpawnTool(host, "registered-missing-modality", { prompt: "Do the task", group: "text-only", constraints: { modalities: { required: ["image"] } } }),
	).rejects.toSatisfy((error: unknown) => {
		const routeError = routeErrorOf(error);
		expect(routeError.kind).toBe("unusable-group");
		expect(routeError.reason).toBe("missing-modality");
		return true;
	});
	expect(sessionFactory).not.toHaveBeenCalled();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("registered spawn tool rejects injected scalar group and model requirements before publication", async () => {
	const state = createState();
	const sessionFactory = vi.fn(
		() =>
			new Promise<never>(() => {
				throw new Error("sessionFactory must not be called");
			}),
	);
	state.modelGroups.groups = [
		{
			name: "small",
			scope: "project",
			sourcePath: "<test>",
			models: [{ provider: PROVIDER, modelId: "small" }],
			modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
			validation: { unavailableRefs: [], shadowedByProject: false, degraded: false },
			evaluations: [],
		},
	];
	const host = await spawnRunner({
		state,
		sessionFactory,
		constraintRegistry: createConstraintRegistry([testMinContext]),
		model: spawnModel({ id: "parent", input: ["text"], reasoning: false, contextWindow: 100 }),
		modelRegistry: await registryWith([{ id: "small", contextWindow: 10 }]),
		activeTools: ["spawn"],
	});
	await expect(executeSpawnTool(host, "registered-scalar", { prompt: "Do the task", group: "small", constraints: { testMinContext: 20 } })).rejects.toSatisfy(
		(error: unknown) => {
			const routeError = routeErrorOf(error);
			expect(routeError.reason).toBe("constraint-unsatisfied");
			expect(routeError.constraintUnsatisfied).toHaveLength(2);
			expect(routeError.missingModalities).toHaveLength(0);
			expect(routeError.missingFromGroup).toHaveLength(0);
			expect(routeError.missingFromModel).toHaveLength(0);
			return true;
		},
	);
	expect(sessionFactory).not.toHaveBeenCalled();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("registered spawn tool schema accepts injected scalar requirements", async () => {
	const host = await spawnRunner({ state: createState(), constraintRegistry: createConstraintRegistry([testMinContext]) });
	const schema = host.registeredTool("spawn").definition.parameters;
	expect(
		Value.Check(schema, { prompt: "Do the task", constraints: { testMinContext: 20 } }),
		"the registered schema accepts an injected descriptor's scalar requirement",
	).toBe(true);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { testMinContext: 0 } }), "the injected descriptor retains its requirement schema").toBe(
		false,
	);
	expect(
		Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["text"] } } }),
		"the injected registry, not the production registry, defines the registered schema",
	).toBe(false);
});

test("spawn requirements validate the canonical envelope and keep its shape", () => {
	expect(normalizeSpawnRequirements({ constraints: { modalities: { required: ["image", "text"] } } })).toStrictEqual({
		modalities: { required: ["image", "text"] },
	});
	expect(() => normalizeSpawnRequirements({ constraints: { unknown: {} } })).toThrow(/Unknown spawn constraint/);
	expect(() => {
		// @ts-expect-error A string is outside the constraints parameter type.
		normalizeSpawnRequirements({ constraints: '{"modalities":{"required":["text"]}}' });
	}).toThrow(/must be an object/);
	expect(() => normalizeSpawnRequirements({ constraints: { modalities: ["text"] } })).toThrow(/must be an object with required modalities/);
	expect(() => normalizeSpawnRequirements({ constraints: { modalities: ["required", ["text"]] } })).toThrow(/must be an object with required modalities/);
	expect(normalizeSpawnRequirements({})).toStrictEqual({});
});

test("spawn tool schema validates constraints via Value.Check", async () => {
	const host = await spawnRunner({ state: createState() });
	const schema = host.registeredTool("spawn").definition.parameters;
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["text", "image"] } } }), "valid generic envelope accepted").toBe(
		true,
	);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { unknown: {} } }), "unknown generic requirement rejected").toBe(false);
	expect(Value.Check(schema, { prompt: "Do the task" }), "omitted constraints allowed").toBe(true);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: [] } } }), "empty array allowed").toBe(true);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["text", "text"] } } }), "duplicates rejected").toBe(false);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["audio"] } } }), "out-of-vocabulary rejected").toBe(false);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: "text" } }), "non-object requirement rejected").toBe(false);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: '{"modalities":{"required":["text"]}}' }), "stringified constraints rejected").toBe(false);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: ["text", "image"] } }), "bare-array modalities rejected").toBe(false);
	expect(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: ["required", ["text"]] } }), "array-with-embedded-required rejected").toBe(
		false,
	);
});

test("spawn constraints description enumerates injected registry keys", async () => {
	const host = await spawnRunner({ state: createState(), constraintRegistry: createConstraintRegistry([testMinContext]) });
	const constraintsDesc = schemaDescription(spawnConstraintsSchema(host));
	expect(constraintsDesc, "description names the injected registry's constraint key").toContain("Keys: testMinContext");
});

test("spawn prompt guidelines name the keys of the injected constraint registry", async () => {
	const host = await spawnRunner({ state: createState(), constraintRegistry: createConstraintRegistry([testMinContext, testMaxBudget]) });
	expect(host.registeredTool("spawn").definition.promptGuidelines).toContain(
		"A constraint is keyed by its exact name (testMinContext, testMaxBudget); values must match the key's schema — unknown keys or invalid values are rejected before any child is created.",
	);
});

test("spawn schema advertises the thinking levels as a plain string enum", async () => {
	const thinkingSchema = thinkingWireSchema(await spawnRunner({ state: createState() }));
	expect(thinkingSchema.type).toBe("string");
	expect(thinkingSchema.enum).toStrictEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	expect(JSON.stringify(thinkingSchema)).not.toMatch(/"(?:anyOf|const)"\s*:/);
});

test("spawn schema accepts a prompt without thinking", async () => {
	const host = await spawnRunner({ state: createState() });
	expect(Value.Check(host.registeredTool("spawn").definition.parameters, { prompt: "work" })).toBe(true);
});

test("spawn schema rejects an unknown thinking level", async () => {
	const host = await spawnRunner({ state: createState() });
	expect(Value.Check(host.registeredTool("spawn").definition.parameters, { prompt: "work", thinking: "ultra" })).toBe(false);
});

test("spawn schema accepts a group with explicit thinking", async () => {
	const host = await spawnRunner({ state: createState() });
	expect(Value.Check(host.registeredTool("spawn").definition.parameters, { prompt: "work", group: "review", thinking: "max" })).toBe(true);
});

test("executeSpawn runs the child when the inherited route satisfies the constraints", async () => {
	const state = createState();
	const sessionFactory = childFactory();
	const host = await spawnRunner({
		state,
		sessionFactory,
		model: spawnModel({ id: "parent", input: ["text", "image"], reasoning: false }),
		activeTools: ["read", "spawn"],
	});
	const result = await runExecuteSpawn(
		host,
		"spawn-inherited-rm",
		{ prompt: "Do the task", constraints: { modalities: { required: ["text", "image"] } } },
		sessionFactory,
	);
	expect(result.details.outcome).toBe("success");
	expect(result.details.route).toStrictEqual({ status: "inherited" });
	expect(sessionFactory, "inherited route with satisfied requirements creates one child").toHaveBeenCalledOnce();
});

test("executeSpawn reports the unknown-fallback route with the requested group and the parent model", async () => {
	const host = await spawnRunner({
		state: createState(),
		sessionFactory: childFactory(),
		model: spawnModel({ provider: "spawn-parent", id: "parent-model" }),
		activeTools: ["read"],
	});

	const result = await executeSpawnTool(host, "spawn-unknown-group", { prompt: "Do the task", group: "missing-group" });

	expect(result.details.route).toStrictEqual({
		status: "unknown-fallback",
		requestedGroup: "missing-group",
		provider: "spawn-parent",
		modelId: "parent-model",
	});
});

test("spawn execute aborts child session when signal fires during execution", async () => {
	const state = createState();

	let resolvePrompt!: () => void;
	let promptStarted!: () => void;
	const abort = vi.fn(() => {
		resolvePrompt();
		return Promise.resolve();
	});
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		},
		result: [assistantText("aborted mid-flight")],
		abort,
	});

	const host = await spawnRunner({ state, sessionFactory: factory, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });

	const controller = new AbortController();
	const executePromise = executeSpawnTool(host, "spawn-1", { prompt: "Do the task" }, controller.signal);

	await started;
	controller.abort();

	const result = await executePromise;
	expect(abort).toHaveBeenCalled();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
	expect(result.content[0].text).toBe("Child agent aborted: This operation was aborted\n\naborted mid-flight");
	expect(result.details.outcome).toBe("aborted");
	expect(result.isError).toBe(true);
	expect(factory.children[0].dispose, "mid-prompt abort disposes exactly once").toHaveBeenCalledOnce();
});

test("a completed child error after parent cancellation is reported as aborted", async () => {
	const state = createState();
	const controller = new AbortController();
	let promptStarted!: () => void;
	let resolvePrompt!: () => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		},
		abort: () => {
			resolvePrompt();
			return Promise.resolve();
		},
		result: [assistantMessage([], { stopReason: "error", errorMessage: "This operation was aborted" })],
	});
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }) });
	const execution = runExecuteSpawn(host, "spawn-provider-error-after-abort", { prompt: "Do the task" }, factory, { signal: controller.signal });
	await started;
	controller.abort(new Error("parent cancelled"));

	const result = await execution;
	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("Child agent aborted: parent cancelled");
});

test("a real prompt failure that races with a parent abort keeps its text under the aborted outcome", async () => {
	const state = createState();
	const controller = new AbortController();
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const promptError = new Error("prompt failed despite abort");
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => {
				rejectPrompt = reject;
			});
		},
	});
	const host = await spawnRunner({ state, sessionFactory: factory, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });

	const execution = executeSpawnTool(host, "spawn-abort-real-error", { prompt: "Do the task" }, controller.signal);
	await started;
	controller.abort();
	rejectPrompt(promptError);

	const result = await execution;
	expect(result.isError).toBe(true);
	expect(result.content).toStrictEqual([{ type: "text", text: "prompt failed despite abort" }]);
	expect(result.details.outcome).toBe("aborted");
	expect(result.usage).toStrictEqual(ZERO_USAGE);
	expect(factory.children[0].dispose).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("spawn invalidation wins the abort and prompt-rejection race", async () => {
	const state = createState();
	const controller = new AbortController();
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => {
				rejectPrompt = reject;
			});
		},
	});
	const host = await spawnRunner({ state, sessionFactory: factory, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });

	const execution = executeSpawnTool(host, "spawn-abort-reset-race", { prompt: "Do the task" }, controller.signal);
	await started;
	controller.abort();
	resetState(state);
	rejectPrompt(new Error("prompt rejected after abort and reset"));

	assertErrorResult(await execution, "Spawn invalidated by reset.", ZERO_USAGE);
	expect(factory.children[0].abort, "signal cancellation and reset share one abort").toHaveBeenCalledOnce();
	expect(factory.children[0].dispose, "the raced child disposes exactly once").toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("reset before registration returns the invalidation and abort failure", async () => {
	const state = createState();
	let factoryCalled = false;
	const abortError = new Error("abort failed");
	const child = createChildSession(CWD, {
		thinkingLevel: "medium",
		abort: () =>
			new Promise<never>(() => {
				throw abortError;
			}),
	});
	const factoryReady = createDeferred();
	const mockFactory = async () => {
		factoryCalled = true;
		await factoryReady.promise;
		return sessionResult(child.session);
	};

	const host = await spawnRunner({ state, sessionFactory: mockFactory, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });

	const execution = executeSpawnTool(host, "spawn-pre-reg-abort-reject", { prompt: "Do the task" });

	// Reset while the factory is still producing the session
	resetState(state);
	// Allow the factory to resolve — session is immediately stale
	factoryReady.resolve();

	assertErrorResult(await execution, "Spawn invalidated by reset; child abort failed.", ZERO_USAGE);
	expect(factoryCalled, "factory was called").toBe(true);
	expect(child.abort, "abort was called exactly once").toHaveBeenCalledOnce();
	expect(child.dispose, "child disposed exactly once").toHaveBeenCalledOnce();
	assertChildRegistriesCleared(state);
});

test("reset during prompt reports a failed abort once through the UI", async () => {
	const state = createState();
	const abortError = new Error("abort failed");
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => {
				rejectPrompt = reject;
			});
		},
		abort: () =>
			new Promise<never>(() => {
				throw abortError;
			}),
	});
	const host = await spawnRunner({ state, sessionFactory: factory, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"], ui: true });

	const execution = executeSpawnTool(host, "spawn-reset-prompt-abort-reject-ui", { prompt: "Do the task" });
	await started;
	resetState(state);
	rejectPrompt(new Error("prompt rejected"));

	assertErrorResult(await execution, "Spawn invalidated by reset; child abort failed.", ZERO_USAGE);
	expect(host.ui.notifications).toStrictEqual([{ message: "Spawn cleanup failed: abort failed", type: "error" }]);
	expect(factory.children[0].abort).toHaveBeenCalledOnce();
	expect(factory.children[0].dispose).toHaveBeenCalledOnce();
	assertChildRegistriesCleared(state);
});

test("a throwing notice for a failed reset abort does not emit an unhandled rejection", async () => {
	const state = createState();
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const abortError = new Error("abort failed");
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const factory = childFactory({
			prompt: async () => {
				promptStarted();
				await new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject;
				});
			},
			abort: () =>
				new Promise<never>(() => {
					throw abortError;
				}),
		});
		const host = await spawnRunner({
			state,
			sessionFactory: factory,
			model: spawnModel({ id: "mock-model" }),
			activeTools: ["read", "bash", "spawn"],
			ui: true,
		});
		const notify = vi.spyOn(host.runner.getUIContext(), "notify").mockImplementation(() => {
			throw new Error("notify exploded");
		});

		const execution = executeSpawnTool(host, "spawn-throwing-notify", { prompt: "Do the task" });
		await started;
		resetState(state);
		rejectPrompt(new Error("prompt rejected"));

		assertErrorResult(await execution, "Spawn invalidated by reset; child abort failed.", ZERO_USAGE);
		// Give any detached microtasks a chance to flush
		await new Promise((resolve) => setImmediate(resolve));

		expect(notify).toHaveBeenCalledOnce();
		expect(unhandled, `no unhandled abort rejections: ${unhandled.map((e) => String(e)).join(", ")}`).toHaveLength(0);
		assertChildRegistriesCleared(state);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
});

test("concurrent spawn executions produce independent results", async () => {
	const state = createState();

	let resolveA!: () => void;
	let resolveB!: () => void;
	let markStartedA!: () => void;
	let markStartedB!: () => void;
	const gateA = new Promise<void>((resolve) => {
		resolveA = resolve;
	});
	const gateB = new Promise<void>((resolve) => {
		resolveB = resolve;
	});
	const startedA = new Promise<void>((resolve) => {
		markStartedA = resolve;
	});
	const startedB = new Promise<void>((resolve) => {
		markStartedB = resolve;
	});
	const started: string[] = [];
	const outputs = new Map([
		["task A", "result-alpha"],
		["task B", "result-beta"],
	]);
	const sharedFactory = () => {
		const child = createChildSession(CWD, {
			thinkingLevel: "medium",
			prompt: async (prompt: string) => {
				const task = /## Task\n\n([\s\S]*?)\n\nWhen complete/.exec(prompt)?.[1] ?? "";
				started.push(task);
				if (task === "task A") {
					markStartedA();
					await gateA;
				}
				if (task === "task B") {
					markStartedB();
					await gateB;
				}
				child.messages.push(assistantText(outputs.get(task) ?? task));
			},
		});
		return Promise.resolve(sessionResult(child.session));
	};

	const host = await spawnRunner({ state, sessionFactory: sharedFactory, model: spawnModel({ id: "mock" }) });

	const resultP1 = executeSpawnTool(host, "spawn-A", { prompt: "task A" });
	const resultP2 = executeSpawnTool(host, "spawn-B", { prompt: "task B" });

	await Promise.all([startedA, startedB]);
	expect(started.sort()).toStrictEqual(["task A", "task B"]);
	resolveA();
	resolveB();

	const [r1, r2] = await Promise.all([resultP1, resultP2]);

	expect(r1.content[0].text).toBe("result-alpha");
	expect(r2.content[0].text).toBe("result-beta");
	expect([...state.childSessions.keys()]).not.toContain("spawn-A");
	expect([...state.childSessions.keys()]).not.toContain("spawn-B");
});

test("executeSpawn detects stale session before session creation", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });

	let resolveFactory!: (value: unknown) => void;
	const factoryReady = new Promise<unknown>((resolve) => {
		resolveFactory = resolve;
	});
	let factoryCalled = false;
	const child = createChildSession(CWD, { thinkingLevel: "medium" });

	const executePromise = runExecuteSpawn(host, "spawn-1", { prompt: "Do the task" }, async () => {
		factoryCalled = true;
		await factoryReady;
		return sessionResult(child.session);
	});

	// Reset state while executeSpawn is awaiting the factory
	resetState(state);
	// Now allow the factory to resolve — session should be immediately stale
	resolveFactory({});

	assertErrorResult(await executePromise, "Spawn invalidated by reset.", ZERO_USAGE);
	expect(factoryCalled).toBe(true);
	expect(child.abort).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("executeSpawn does not prompt when onUpdate synchronously resets the child epoch", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });
	const factory = childFactory();

	const execution = runExecuteSpawn(host, "spawn-1", { prompt: "Do the task" }, factory, {
		onUpdate: () => {
			resetState(state);
		},
	});

	assertErrorResult(await execution, "Spawn invalidated by reset.", ZERO_USAGE);
	const [child] = factory.children;
	expect(child.prompt).not.toHaveBeenCalled();
	expect(child.abort).toHaveBeenCalledOnce();
	expect(child.dispose).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("executeSpawn does not prompt when onUpdate synchronously aborts the signal", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });
	const controller = new AbortController();
	const reason = new Error("cancelled during update");
	const factory = childFactory();

	const execution = runExecuteSpawn(host, "spawn-1", { prompt: "Do the task" }, factory, {
		signal: controller.signal,
		onUpdate: () => {
			controller.abort(reason);
		},
	});

	const result = await execution;
	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("Child agent aborted: cancelled during update");
	expect(result.usage).toStrictEqual(ZERO_USAGE);
	const [child] = factory.children;
	expect(child.prompt).not.toHaveBeenCalled();
	expect(child.abort).toHaveBeenCalledOnce();
	expect(child.dispose).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("an abort during a running update notifies a failed child abort once", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), ui: true });
	const controller = new AbortController();
	const factory = childFactory({
		abort: () =>
			new Promise<never>(() => {
				throw new Error("abort failed");
			}),
	});
	const result = await runExecuteSpawn(host, "spawn-update-abort-failure", { prompt: "Do the task" }, factory, {
		signal: controller.signal,
		onUpdate: () => {
			controller.abort(new Error("cancelled during update"));
		},
	});

	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("abort failed");
	expect(host.ui.notifications).toStrictEqual([{ message: "Spawn cleanup failed: abort failed", type: "error" }]);
	expect(factory.children[0].prompt).not.toHaveBeenCalled();
});

test("reset during a running update reports one failed abort", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), ui: true });
	const factory = childFactory({
		abort: () =>
			new Promise<never>(() => {
				throw new Error("abort failed");
			}),
	});
	const result = await runExecuteSpawn(host, "spawn-reset-abort-failure", { prompt: "Do the task" }, factory, {
		onUpdate: () => {
			resetState(state);
		},
	});

	assertErrorResult(result, "Spawn invalidated by reset; child abort failed.", ZERO_USAGE);
	expect(host.ui.notifications).toStrictEqual([{ message: "Spawn cleanup failed: abort failed", type: "error" }]);
	expect(factory.children[0].prompt).not.toHaveBeenCalled();
});

test("executeSpawn aborts stale child when resetState fires during prompt", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });

	let rejectPrompt!: (err: Error) => void;
	let resolvePromptStarted!: () => void;
	const promptStartedPromise = new Promise<void>((r) => {
		resolvePromptStarted = r;
	});
	const factory = childFactory({
		prompt: async () => {
			resolvePromptStarted();
			await new Promise<void>((_resolve, reject) => {
				rejectPrompt = reject;
			});
		},
		abort: () => {
			rejectPrompt(new Error("aborted"));
			return Promise.resolve();
		},
	});

	const executePromise = runExecuteSpawn(host, "spawn-1", { prompt: "Do the task" }, factory);

	// Wait for session to be created and prompt to start
	await promptStartedPromise;
	// Reset cleanup starts the shared abort, then prompt rejection reaches invalidation.
	resetState(state);

	assertErrorResult(await executePromise, "Spawn invalidated by reset.", ZERO_USAGE);
	expect(factory.children[0].abort, "reset and invalidation share one abort").toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
	expect(factory.children[0].dispose, "prompt-reset invalidation disposes exactly once").toHaveBeenCalledOnce();
});

test("executeSpawn suppresses a successful stale prompt that ignores reset abort", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), activeTools: ["read", "bash", "spawn"] });
	let resolvePrompt!: () => void;
	let promptStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	const updates: AgentToolResult<SpawnResultDetails>[] = [];
	const factory = childFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		},
		result: [assistantText("stale success")],
	});

	const execution = runExecuteSpawn(host, "spawn-1", { prompt: "Do the task" }, factory, {
		onUpdate: (update) => {
			updates.push(update);
		},
	});

	await started;
	resetState(state);
	resolvePrompt();

	assertErrorResult(await execution, "Spawn invalidated by reset.", ZERO_USAGE);
	expect(factory.children[0].abort).toHaveBeenCalledOnce();
	expect(factory.children[0].dispose).toHaveBeenCalledOnce();
	expect(updates, "no stale completion update is published").toHaveLength(1);
	expect(updates[0].content).toStrictEqual([]);
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

// ── Tool registration tests ──────────────────────────────────────────

test("registered spawn tool keeps pi's default execution mode and draws its own shell", async () => {
	const definition = (await spawnRunner({ state: createState() })).registeredTool("spawn").definition;
	expect(definition.executionMode, "spawn should not be sequential").toBeUndefined();
	expect(definition.renderShell).toBe("self");
});

// ── Abort cleanup and dispose failure coverage ───────────────────────

test("spawn abort before its prompt returns the failed abort and notifies the UI", async () => {
	const state = createState();
	const host = await spawnRunner({ state, model: spawnModel({ id: "mock-model" }), ui: true });
	const abortError = new Error("abort failed");
	const factory = childFactory({
		abort: () =>
			new Promise<never>(() => {
				throw abortError;
			}),
	});
	const controller = new AbortController();
	controller.abort(new Error("parent aborted"));

	const result = await runExecuteSpawn(host, "spawn-abort-cleanup", { prompt: "Do the task" }, factory, { signal: controller.signal });
	expect(result.isError).toBe(true);
	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("abort failed");
	expect(result.usage).toStrictEqual(ZERO_USAGE);
	expect(host.ui.notifications).toStrictEqual([{ message: "Spawn cleanup failed: abort failed", type: "error" }]);
});

test("a completed UI spawn whose dispose fails returns the dispose error without a notice", async () => {
	const failed = await hostWithFailedUsage(
		{
			dispose: () => {
				throw new Error("dispose failed");
			},
		},
		{ ui: true },
	);

	const result = await failed.execute("spawn-dispose-only-ui");

	expect(result).toStrictEqual(failedSpawnResult("dispose failed"));
	expect(failed.host.ui.notifications).toStrictEqual([]);
	assertChildRegistriesCleared(failed.state);
});
