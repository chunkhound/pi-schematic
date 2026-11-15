// Runs a real child session through the spawn tool for integration tests: pi's real
// createAgentSession, offline, under temp directories, against a deterministic probe provider.

import { CONFIG_DIR_NAME, SessionManager, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import os from "node:os";
import { createState, resetState } from "../../state.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { createRunner, toolInfo } from "./runner.js";

export interface RealChildInvocationResult {
	result: AgentToolResult<unknown>;
	results: AgentToolResult<unknown>[];
	expectedText: string;
	modelId: string;
	probeCalls: number;
	streamCalls: number;
	observedToolSets: string[][];
	bashWriteExists: boolean;
	outboundFetches: string[];
	/** Internally-created state, exposed so tests can assert childSessions bookkeeping. */
	state: ReturnType<typeof createState>;
	/** onUpdate payloads recorded from the spawn tool (real invocation). */
	updates: unknown[];
	/** Full text of every message the child session sent to the deterministic provider. */
	observedMessages: string[];
	/** Requested thinking level forwarded to the provider per stream call (may be empty if the SDK omits it). */
	observedThinking: (string | undefined)[];
}

// The probe extension runs in its own module scope, so the fixture and the probe share these globals.
const PROBE_GLOBALS = [
	"__agenticE2eProbeCalls",
	"__agenticE2eStreamCalls",
	"__agenticE2eToolSets",
	"__agenticE2eInvokeReadonlyBash",
	"__agenticE2eNoOutput",
	"__agenticE2eResetDuringPrompt",
	"__agenticE2eAbortMidPrompt",
	"__agenticE2eReset",
	"__agenticE2eState",
	"__agenticE2eController",
	"__agenticE2eMessages",
	"__agenticE2eThinking",
] as const;

type ProbeGlobal = (typeof PROBE_GLOBALS)[number];

function setProbeGlobal(name: ProbeGlobal, value: unknown): void {
	Reflect.set(globalThis, name, value);
}

function probeGlobal(name: ProbeGlobal): unknown {
	const value: unknown = Reflect.get(globalThis, name);
	return value;
}

function probeNumber(name: ProbeGlobal): number {
	const value = probeGlobal(name);
	if (typeof value !== "number") {
		throw new Error(`The probe left ${name} as ${typeof value}, not a number.`);
	}
	return value;
}

// The probe global `name` as an array of items `isItem` accepts. An unset global throws unless `unsetAsEmpty`
// is true, which reads it as an empty array.
function probeArray<T>(name: ProbeGlobal, isItem: (item: unknown) => item is T, unsetAsEmpty = false): T[] {
	const value = unsetAsEmpty ? (probeGlobal(name) ?? []) : probeGlobal(name);
	if (!Array.isArray(value)) {
		throw new Error(`The probe left ${name} as ${typeof value}, not an array.`);
	}
	const items: unknown[] = value;
	if (!items.every(isItem)) {
		throw new Error(`The probe left an unexpected item in ${name}.`);
	}
	return items;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

/**
 * Run a real child session via the E2E probe pattern:
 * offline mode, temp dirs, deterministic provider.
 * Uses real `createAgentSession` (no mocks).
 *
 * The probe extension registers a deterministic provider that drives a fixed
 * tool-call loop: the model calls `agentic_e2e_probe`, receives a sentinel,
 * then stops. For readonly tests, the provider instead calls `bash` and
 * inspects the guard result. All counters are stored on `globalThis` because
 * child sessions run in the same process but separate module scopes.
 *
 * `cwdOutsideTemp` makes the child attempt a write outside `os.tmpdir()`.
 * Its working directory stays under the fixture's temp root, so the fixture
 * remains portable when $HOME is restricted; the guard still sees a real
 * non-temp mutation target.
 */
export async function runRealChildInvocation(params: {
	prompt: string;
	thinking?: "max";
	/** Register the probe model as reasoning-capable, so a requested thinking level is not clamped to "off". */
	reasoning?: boolean;
	readonly?: boolean;
	activeTools?: string[];
	invokeReadonlyBash?: boolean;
	cwdOutsideTemp?: boolean;
	abortBeforeStart?: boolean;
	resetOnRunningUpdate?: boolean;
	prompts?: string[];
	resultText?: string;
	/** Return an assistant message with empty text so spawn throws "Child agent produced no output.". */
	noOutput?: boolean;
	/** Notebook pages seeded onto state before spawn, to exercise the prompt-injection contract. */
	notebookPages?: Record<string, string>;
	/** Inside the FIRST stream call, reset state — makes the child stale and spawn rejects with /invalidated by reset/. */
	resetDuringPrompt?: boolean;
	/** Inside the FIRST stream call, abort the parent controller — spawn rejects with /mid-prompt abort/. */
	abortMidPrompt?: boolean;
}): Promise<RealChildInvocationResult> {
	const tempRoot = await mkdtemp(join(os.tmpdir(), "pi-schematic-runtime-"));
	const cwd = join(tempRoot, "project");
	// M3: For cwdOutsideTemp the write target is placed OUTSIDE os.tmpdir() so the
	// readonly bash guard (which only permits writes under the session temp root)
	// actually fires. The child's working dir still lives under the fixture temp
	// root, so the fixture stays portable under a restricted $HOME.
	const readonlyWriteTarget =
		params.cwdOutsideTemp === true ? resolve(os.tmpdir(), "..", `readonly-child-escape-${process.pid}-${Date.now()}`) : "readonly-child-escape";
	const agentDir = join(tempRoot, "agent");
	const extensionDir = join(cwd, CONFIG_DIR_NAME, "extensions");
	const sentinel = "AGENTIC_E2E_PROBE_OK";
	const provider = "agentic-e2e";
	const modelId = "agentic-e2e-model";
	const resultText = params.resultText ?? `${provider}/${modelId}:${sentinel}`;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
	const previousFetch = globalThis.fetch;
	const outboundFetches: string[] = [];

	try {
		await mkdir(cwd, { recursive: true });
		await mkdir(extensionDir, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(
			join(extensionDir, "agentic-e2e-probe.js"),
			`
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
const usage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export default function(pi) {
	pi.registerProvider("${provider}", {
		api: "agentic-e2e-api", apiKey: "test-key", baseUrl: "http://localhost.invalid",
		models: [{
			id: "${modelId}", name: "Agentic E2E Model", reasoning: ${String(params.reasoning ?? false)},
			input: ["text"], cost: usage.cost, contextWindow: 128000, maxTokens: 1024,
		}],
		streamSimple(model, context, options) {
			globalThis.__agenticE2eStreamCalls = (globalThis.__agenticE2eStreamCalls ?? 0) + 1;
			const effectiveToolNames = getCurrentTools(context.messages).map((tool) => tool.name);
			globalThis.__agenticE2eToolSets = [...(globalThis.__agenticE2eToolSets ?? []), effectiveToolNames];
			// Content may be a block array (assistant/user) or a plain string (system/user text); normalize both.
			globalThis.__agenticE2eMessages = [...(globalThis.__agenticE2eMessages ?? []), ...context.messages.flatMap((message) => {
				const content = message.content;
				if (Array.isArray(content)) return content.filter((block) => block.type === "text").map((block) => block.text);
				return typeof content === "string" ? [content] : [];
			})];
			globalThis.__agenticE2eThinking = options?.reasoning !== undefined
				? [...(globalThis.__agenticE2eThinking ?? []), options.reasoning]
				: (globalThis.__agenticE2eThinking ?? []);
			if (globalThis.__agenticE2eStreamCalls === 1) {
				if (globalThis.__agenticE2eResetDuringPrompt) {
					globalThis.__agenticE2eReset(globalThis.__agenticE2eState);
				}
				if (globalThis.__agenticE2eAbortMidPrompt) {
					// Fire the parent controller abort. The real SDK does not reject the
					// in-flight session.prompt here; spawn records an aborted outcome.
					globalThis.__agenticE2eController.abort(new Error("mid-prompt abort"));
				}
			}
			const bashResult = context.messages.find((message) =>
				message.role === "toolResult" && message.toolName === "bash"
			);
			const probeResult = context.messages.find((message) =>
				message.role === "toolResult" && message.toolName === "agentic_e2e_probe"
			);
			const noOutput = globalThis.__agenticE2eNoOutput;
			const content = noOutput
				? [{ type: "text", text: "" }]
				: bashResult
					? [{ type: "text", text: model.provider + "/" + model.id + ":READONLY_BASH_BLOCKED:" + JSON.stringify(bashResult.content) }]
					: probeResult
						? [{ type: "text", text: ${JSON.stringify(resultText)} }]
						: globalThis.__agenticE2eInvokeReadonlyBash
							? [{ type: "toolCall", id: "bash-call-1", name: "bash", arguments: { command: "touch ${readonlyWriteTarget}" } }]
							: [{ type: "toolCall", id: "probe-call-1", name: "agentic_e2e_probe", arguments: {} }];
			const message = {
				role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage, stopReason: noOutput || bashResult || probeResult ? "stop" : "toolUse", timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			});
			return stream;
		},
	});
	pi.registerTool({
		name: "agentic_e2e_probe", label: "Agentic E2E Probe",
		description: "Return the deterministic compatibility sentinel.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			globalThis.__agenticE2eProbeCalls = (globalThis.__agenticE2eProbeCalls ?? 0) + 1;
			return { content: [{ type: "text", text: "${sentinel}" }], details: {} };
		},
	});
}
`,
		);

		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.OPENAI_API_KEY = "test-openai-key";
		globalThis.fetch = (input: Parameters<typeof fetch>[0]) => {
			outboundFetches.push(input instanceof Request ? input.url : String(input));
			return Promise.reject(new Error(`offline fixture blocked outbound fetch: ${String(outboundFetches.at(-1))}`));
		};
		setProbeGlobal("__agenticE2eProbeCalls", 0);
		setProbeGlobal("__agenticE2eStreamCalls", 0);
		setProbeGlobal("__agenticE2eToolSets", []);
		setProbeGlobal("__agenticE2eInvokeReadonlyBash", params.invokeReadonlyBash ?? false);
		setProbeGlobal("__agenticE2eNoOutput", params.noOutput ?? false);
		setProbeGlobal("__agenticE2eResetDuringPrompt", params.resetDuringPrompt ?? false);
		setProbeGlobal("__agenticE2eAbortMidPrompt", params.abortMidPrompt ?? false);
		setProbeGlobal("__agenticE2eReset", resetState);
		setProbeGlobal("__agenticE2eMessages", []);
		setProbeGlobal("__agenticE2eThinking", []);
		const model: Model<Api> = {
			id: modelId,
			name: "Agentic E2E Model",
			api: "agentic-e2e-api",
			provider,
			baseUrl: "http://localhost.invalid",
			reasoning: params.reasoning ?? false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1024,
		};
		const activeTools = params.activeTools ?? ["read", "agentic_e2e_probe", "spawn"];
		const state = createState();
		state.readonlyEnabled = params.readonly ?? false;
		if (params.notebookPages) {
			for (const [pageName, pageContent] of Object.entries(params.notebookPages)) {
				state.notebookPages.set(pageName, pageContent);
			}
		}
		// The probe tool comes from the project; every other active tool is a built-in.
		const toolSources: Record<string, string> = { agentic_e2e_probe: "project" };
		const fixture = await createRunner({
			cwd,
			mode: "print",
			factories: [
				(api) => {
					registerSpawnTool(api, state);
				},
			],
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			context: { getModel: () => model },
			activeTools,
			actions: {
				getAllTools: () => activeTools.map((name) => toolInfo(name, toolSources[name] ?? "builtin")),
				getThinkingLevel: () => "medium",
			},
		});
		const controller = new AbortController();
		if (params.abortBeforeStart === true) {
			controller.abort(new Error("fixture abort"));
		}
		// Expose live references for the provider (separate module scope) to act on.
		setProbeGlobal("__agenticE2eState", state);
		setProbeGlobal("__agenticE2eController", controller);
		const prompts = params.prompts ?? [params.prompt];
		const updates: unknown[] = [];
		const onUpdate =
			params.resetOnRunningUpdate === true
				? (result: unknown) => {
						updates.push(result);
						resetState(state);
					}
				: (result: unknown) => {
						updates.push(result);
					};
		let results;
		try {
			const spawn = fixture.tool("spawn");
			results = await Promise.all(
				prompts.map((prompt, index) =>
					spawn.execute(`spawn-${params.thinking ?? "inherited"}-${index}`, { prompt, thinking: params.thinking }, controller.signal, onUpdate),
				),
			);
		} catch (error) {
			// Attach the partial proof so rejecting tests can assert bookkeeping
			// (e.g. that no update was published before an early abort).
			// A primitive or null rejection cannot carry the proof and is rethrown unchanged.
			if (typeof error === "object" && error !== null) {
				Object.assign(error, {
					proof: {
						state,
						updates,
						observedMessages: probeGlobal("__agenticE2eMessages") ?? [],
						observedThinking: probeGlobal("__agenticE2eThinking") ?? [],
					},
				});
			}
			throw error;
		}
		const bashWriteExists = existsSync(readonlyWriteTarget);
		return {
			result: results[0],
			results,
			expectedText: `${provider}/${modelId}:${sentinel}`,
			modelId,
			probeCalls: probeNumber("__agenticE2eProbeCalls"),
			streamCalls: probeNumber("__agenticE2eStreamCalls"),
			observedToolSets: probeArray("__agenticE2eToolSets", isStringArray),
			bashWriteExists,
			outboundFetches,
			state,
			updates,
			observedMessages: probeArray("__agenticE2eMessages", isString, true),
			observedThinking: probeArray("__agenticE2eThinking", isOptionalString, true),
		};
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiApiKey;
		}
		globalThis.fetch = previousFetch;
		for (const name of PROBE_GLOBALS) {
			Reflect.deleteProperty(globalThis, name);
		}
		await rm(tempRoot, { recursive: true, force: true });
		await rm(readonlyWriteTarget, { force: true });
	}
}
