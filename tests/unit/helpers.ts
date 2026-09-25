// ── Shared test helpers ──────────────────────────────────────────
// Imported by other test files via `./helpers.js`
// Includes the real-API test host (see ./test-host.js), test utilities, theme constants, readonly helpers, etc.

import type { Theme } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import os from "node:os";
import { createState, resetState } from "../../state.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { createTestHost, type TestPI } from "./test-host.js";

export const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export const ansiTheme = {
	fg: (_name: string, text: string) => `\u001b[38;5;245m${text}\u001b[39m`,
	bg: (_name: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
	bold: (text: string) => text,
} as unknown as Theme;

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;

export function setTempHome(home: string): () => void {
	const snapshot = Object.fromEntries(HOME_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<typeof HOME_ENV_KEYS[number], string | undefined>;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.HOMEDRIVE;
	delete process.env.HOMEPATH;
	return () => {
		for (const key of HOME_ENV_KEYS) {
			const value = snapshot[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

export function createRenderContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		expanded: false,
		showImages: true,
		toolCallId: "tool-call-1",
		lastComponent: undefined,
		invalidate: () => {},
		...overrides,
	};
}

export function createSession(messages: any[]) {
	return {
		messages,
		subscribe: () => () => {},
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as unknown as import("@earendil-works/pi-coding-agent").AgentSession;
}

export function createSubscribableSession(messages: any[] = []) {
	let handler: ((event: any) => void) | undefined;
	return {
		session: {
			messages,
			subscribe: (cb: (event: any) => void) => {
				handler = cb;
				return () => { handler = undefined; };
			},
			getToolDefinition: () => undefined,
			sessionManager: { getCwd: () => process.cwd() },
			abort: async () => {},
		} as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
		emit: (event: any) => handler?.(event),
	};
}

export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export function getRenderedLine(lines: string[], match: (plain: string) => boolean): string {
	const line = lines.find(candidate => match(stripAnsi(candidate)));
	assert.ok(line);
	return line;
}

export function getLineContaining(lines: string[], text: string): string {
	const line = lines.find(candidate => candidate.includes(text));
	assert.ok(line);
	return line;
}

export function assertShellBackgroundPreserved(line: string): void {
	assert.equal(line.includes("\u001b[0m"), false);
	assert.match(line, /\u001b\[48;/);
}

export function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

// ── Readonly test helpers ────────────────────────────────────────────

export type ToolCall = (event: { toolName: string; input?: Record<string, unknown> }, ctx: { cwd?: string }) => Promise<any>;

/**
 * Create a test PI instance with agenticoding registered and the tool_call handler extracted.
 */
export async function registerReadonlyPI(): Promise<{ pi: TestPI; toolCall: ToolCall }> {
	const pi = await createTestHost();
	const [toolCall] = pi.handlers.get("tool_call") as ToolCall[];
	return { pi, toolCall };
}

/**
 * Create a minimal UI context with the required shape for tool_call/auth tests.
 */
export function makeReadonlyUICtx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_name: string, text: string) => text },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
		...overrides,
	};
}

// ── Temp directory helpers ──────────────────────────────────────────

export async function tmpDir(): Promise<string> {
	return mkdtemp(join(os.tmpdir(), "pi-test-"));
}

export async function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const homeDir = await tmpDir();
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
	try {
		return await run(homeDir);
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(homeDir, { recursive: true, force: true });
	}
}

// ── Real child invocation helper ────────────────────────────────────

export interface RealChildInvocationResult {
	result: any;
	results: any[];
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
	updates: any[];
	/** Full text of every message the child session sent to the deterministic provider. */
	observedMessages: string[];
	/** Requested thinking level forwarded to the provider per stream call (may be empty if the SDK omits it). */
	observedThinking: (string | undefined)[];
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
	const tempRoot = await mkdtemp(join(os.tmpdir(), "pi-agenticoding-runtime-"));
	const cwd = join(tempRoot, "project");
	// M3: For cwdOutsideTemp the write target is placed OUTSIDE os.tmpdir() so the
	// readonly bash guard (which only permits writes under the session temp root)
	// actually fires. The child's working dir still lives under the fixture temp
	// root, so the fixture stays portable under a restricted $HOME.
	const readonlyWriteTarget = params.cwdOutsideTemp
		? resolve(os.tmpdir(), "..", `readonly-child-escape-${process.pid}-${Date.now()}`)
		: "readonly-child-escape";
	const agentDir = join(tempRoot, "agent");
	const extensionDir = join(cwd, ".pi", "extensions");
	const sentinel = "AGENTIC_E2E_PROBE_OK";
	const provider = "agentic-e2e";
	const modelId = "agentic-e2e-model";
	const resultText = params.resultText ?? `${provider}/${modelId}:${sentinel}`;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
	const previousPiOffline = process.env.PI_OFFLINE;
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
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const usage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export default function(pi) {
	pi.registerProvider("${provider}", {
		api: "agentic-e2e-api", apiKey: "test-key", baseUrl: "http://localhost.invalid",
		models: [{
			id: "${modelId}", name: "Agentic E2E Model", reasoning: false,
			input: ["text"], cost: usage.cost, contextWindow: 128000, maxTokens: 1024,
		}],
		streamSimple(model, context, options) {
			globalThis.__agenticE2eStreamCalls = (globalThis.__agenticE2eStreamCalls ?? 0) + 1;
			// Pi <=0.86 passes tools as context.tools; 0.87+ carries the tool set in the
			// transcript's system message (toolsAdded/toolsRemoved). Replay both so the
			// fixture observes the same effective tool set across Pi versions.
			const effectiveToolNames = (() => {
				const names = (context.tools ?? []).map((tool) => tool.name);
				for (const message of context.messages ?? []) {
					if (message.role !== "system") continue;
					for (const tool of message.toolsAdded ?? []) if (!names.includes(tool.name)) names.push(tool.name);
					for (const removed of message.toolsRemoved ?? []) {
						const index = names.indexOf(removed.name);
						if (index !== -1) names.splice(index, 1);
					}
				}
				return names;
			})();
			globalThis.__agenticE2eToolSets = [...(globalThis.__agenticE2eToolSets ?? []), effectiveToolNames];
			// Content may be a block array (assistant/user) or a plain string (system/user text); normalize both.
			globalThis.__agenticE2eMessages = [...(globalThis.__agenticE2eMessages ?? []), ...(context.messages ?? []).flatMap((message) => {
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
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			outboundFetches.push(input instanceof Request ? input.url : String(input));
			throw new Error(`offline fixture blocked outbound fetch: ${outboundFetches.at(-1)}`);
		}) as typeof fetch;
		(globalThis as any).__agenticE2eProbeCalls = 0;
		(globalThis as any).__agenticE2eStreamCalls = 0;
		(globalThis as any).__agenticE2eToolSets = [];
		(globalThis as any).__agenticE2eInvokeReadonlyBash = params.invokeReadonlyBash ?? false;
		(globalThis as any).__agenticE2eNoOutput = params.noOutput ?? false;
		(globalThis as any).__agenticE2eResetDuringPrompt = params.resetDuringPrompt ?? false;
		(globalThis as any).__agenticE2eAbortMidPrompt = params.abortMidPrompt ?? false;
		(globalThis as any).__agenticE2eReset = resetState;
		(globalThis as any).__agenticE2eMessages = [];
		(globalThis as any).__agenticE2eThinking = [];
		const model = {
			id: modelId, name: "Agentic E2E Model", api: "agentic-e2e-api", provider,
			reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 1024,
		};
		const activeTools = params.activeTools ?? ["read", "agentic_e2e_probe", "spawn"];
		const state = createState();
		state.readonlyEnabled = params.readonly ?? false;
		if (params.notebookPages) {
			for (const [pageName, pageContent] of Object.entries(params.notebookPages)) {
				state.notebookPages.set(pageName, pageContent);
			}
		}
		const pi = await createTestHost((api) => registerSpawnTool(api, state), {
			toolSources: { agentic_e2e_probe: "project" },
			activeTools,
			allTools: activeTools,
		});
		const controller = new AbortController();
		if (params.abortBeforeStart) controller.abort(new Error("fixture abort"));
		// Expose live references for the provider (separate module scope) to act on.
		(globalThis as any).__agenticE2eState = state;
		(globalThis as any).__agenticE2eController = controller;
		const prompts = params.prompts ?? [params.prompt];
		const updates: any[] = [];
		const onUpdate = params.resetOnRunningUpdate
			? (result: any) => {
				updates.push(result);
				resetState(state);
			}
			: (result: any) => { updates.push(result); };
		let results;
		try {
			results = await Promise.all(prompts.map((prompt, index) => pi.tools.get("spawn").execute(
				`spawn-${params.thinking ?? "inherited"}-${index}`,
				{ prompt, thinking: params.thinking },
				controller.signal,
				onUpdate,
				{ model, cwd },
			)));
		} catch (error) {
			// Attach the partial proof so rejecting tests can assert bookkeeping
			// (e.g. that no update was published before an early abort).
			throw Object.assign(error as Error, {
				proof: {
					state,
					updates,
					observedMessages: (globalThis as any).__agenticE2eMessages ?? [],
					observedThinking: (globalThis as any).__agenticE2eThinking ?? [],
				},
			});
		}
		const bashWriteExists = existsSync(readonlyWriteTarget);
		return {
			result: results[0],
			results,
			expectedText: `${provider}/${modelId}:${sentinel}`,
			modelId,
			probeCalls: (globalThis as any).__agenticE2eProbeCalls,
			streamCalls: (globalThis as any).__agenticE2eStreamCalls,
			observedToolSets: (globalThis as any).__agenticE2eToolSets,
			bashWriteExists,
			outboundFetches,
			state,
			updates,
			observedMessages: (globalThis as any).__agenticE2eMessages ?? [],
			observedThinking: (globalThis as any).__agenticE2eThinking ?? [],
		};
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
		if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousPiOffline;
		globalThis.fetch = previousFetch;
		delete (globalThis as any).__agenticE2eProbeCalls;
		delete (globalThis as any).__agenticE2eStreamCalls;
		delete (globalThis as any).__agenticE2eToolSets;
		delete (globalThis as any).__agenticE2eInvokeReadonlyBash;
		delete (globalThis as any).__agenticE2eNoOutput;
		delete (globalThis as any).__agenticE2eResetDuringPrompt;
		delete (globalThis as any).__agenticE2eAbortMidPrompt;
		delete (globalThis as any).__agenticE2eReset;
		delete (globalThis as any).__agenticE2eState;
		delete (globalThis as any).__agenticE2eController;
		delete (globalThis as any).__agenticE2eMessages;
		delete (globalThis as any).__agenticE2eThinking;
		await rm(tempRoot, { recursive: true, force: true });
		await rm(readonlyWriteTarget, { force: true });
	}
}

// ── TUI context factory ───────────────────────────────────────────────

export function makeTUICtx(
	overrides: Partial<{
		percent: number | null;
		hasUI: boolean;
		record: { statuses: Map<string, string | undefined>; widgets: Map<string, string[] | undefined> };
	}> = {},
): any {
	const record = overrides.record ?? { statuses: new Map(), widgets: new Map() };
	const hasUI = overrides.hasUI ?? true;
	const percent = overrides.percent !== undefined ? overrides.percent : null;
	return {
		hasUI,
		ui: {
			theme: {
				fg: (name: string, text: string) => `[${name}:${text}]`,
			},
			setStatus: (key: string, status: string | undefined) => { record.statuses.set(key, status); },
			setWidget: (key: string, content: string[] | undefined) => { record.widgets.set(key, content); },
		},
		getContextUsage: () => (percent !== null ? { percent } : null),
	};
}
