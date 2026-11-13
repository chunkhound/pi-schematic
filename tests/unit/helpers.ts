// ── Shared test helpers ──────────────────────────────────────────
// Imported by other test files via `./helpers.js`
// Includes the real-API test host (see ./test-host.js), test utilities, theme constants, readonly helpers, etc.

import {
	CONFIG_DIR_NAME,
	ModelRegistry,
	SessionManager,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionToolContext,
	type ExtensionUIContext,
	type Theme,
	type ToolCallEventResult,
	type ToolDefinition,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import os from "node:os";
import { test as base, expect, vi } from "vitest";
import { createState, resetState } from "../../state.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { assertPresent, isRecord } from "../assertions.js";
import { AGENT_DIR_ENV_KEY } from "../paths.js";
import { createTestHost, type TestPI } from "./test-host.js";

export const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export const EMPTY_CHILD_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A failure after the child session exists is returned as an error result, not thrown. */
export function assertErrorResult(result: any, text: string, usage: unknown): void {
	expect(result.isError).toBe(true);
	expect(result.content).toStrictEqual([{ type: "text", text }]);
	expect(result.details.outcome).toBe("error");
	expect(result.usage).toStrictEqual(usage);
}

export const ansiTheme = {
	fg: (_name: string, text: string) => `\u001b[38;5;245m${text}\u001b[39m`,
	bg: (_name: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
	bold: (text: string) => text,
} as unknown as Theme;

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {delete process.env[key];}
	else {process.env[key] = value;}
}

// pi resolves its agent directory from PI_CODING_AGENT_DIR before HOME, so the home helpers clear
// it; otherwise an exported variable redirects global paths away from the temp home.
export function setTempHome(home: string): () => void {
	const snapshot = Object.fromEntries(HOME_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<typeof HOME_ENV_KEYS[number], string | undefined>;
	const previousAgentDir = process.env[AGENT_DIR_ENV_KEY];
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.HOMEDRIVE;
	delete process.env.HOMEPATH;
	delete process.env[AGENT_DIR_ENV_KEY];
	return () => {
		for (const key of HOME_ENV_KEYS) {restoreEnv(key, snapshot[key]);}
		restoreEnv(AGENT_DIR_ENV_KEY, previousAgentDir);
	};
}

/**
 * An untyped render context for a collapsed call `tool-call-1` with images shown
 * (`showImages: true`), no previous component and a no-op `invalidate`; the
 * overrides replace these members, and unlike `createToolRenderContext` an
 * override set to `undefined` replaces the default too. New tests use
 * `createToolRenderContext`.
 */
export function createRenderContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		expanded: false,
		showImages: true,
		toolCallId: "tool-call-1",
		lastComponent: undefined,
		invalidate: vi.fn(),
		...overrides,
	};
}

/** The render context pi passes a tool's `renderCall` and `renderResult` (not exported from pi's package root). */
export type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/**
 * A `RenderContext` for a finished, collapsed call `tool-call-1`: arguments and
 * state empty, no error, no previous component, `invalidate` a no-op. Members
 * whose override is `undefined` keep these defaults.
 */
export function createToolRenderContext(overrides: Partial<RenderContext> = {}): RenderContext {
	// Newer pi versions add the keybinding formatters `keyText` and `keyHint` to the
	// render context. Spreading them from a variable keeps the literal valid against
	// versions without them; calling one throws naming it.
	const keybindingHints = {
		keyText: unstubbed("context.keyText"),
		keyHint: unstubbed("context.keyHint"),
	};
	return {
		...keybindingHints,
		args: {},
		toolCallId: "tool-call-1",
		invalidate: () => undefined,
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		...definedOverrides(overrides),
	};
}

export function createSession(messages: any[]) {
	return {
		messages,
		subscribe: () => vi.fn(),
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: vi.fn(() => Promise.resolve()),
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
			abort: vi.fn(() => Promise.resolve()),
		} as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
		emit: (event: any) => handler?.(event),
	};
}

export function stripAnsi(text: string): string {
	return stripTerminalSequences(text);
}

export function getRenderedLine(lines: string[], match: (plain: string) => boolean): string {
	const line = lines.find(candidate => match(stripAnsi(candidate)));
	assertPresent(line);
	expect(line).not.toBe("");
	return line;
}

export function getLineContaining(lines: string[], text: string): string {
	const line = lines.find(candidate => candidate.includes(text));
	assertPresent(line);
	expect(line).not.toBe("");
	return line;
}

export function assertShellBackgroundPreserved(line: string): void {
	expect(line).not.toContain("\u001b[0m");
	expect(line).toMatch(/\u001b\[48;/);
}

export function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

/**
 * Run every handler registered for `event` in registration order. Unlike pi, which
 * catches each handler's error and runs the rest, a throwing handler stops the run
 * and fails the test. Throws when no handler is registered, so an unregistered
 * event cannot pass vacuously.
 */
export async function emitAll(pi: TestPI, event: string, payload: unknown, ctx: unknown): Promise<void> {
	const handlers = pi.handlers.get(event);
	if (!handlers?.length) {throw new Error(`No handlers registered for "${event}"`);}
	for (const handler of handlers) {
		await handler(payload, ctx);
	}
}

/**
 * Like `emitAll`, but returns each handler's result in registration order. Each
 * handler sees the same payload: pi's chaining of boundary results between
 * handlers is not emulated.
 */
export async function callHandlers(pi: TestPI, event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
	const handlers = pi.handlers.get(event);
	if (!handlers?.length) {throw new Error(`No handlers registered for "${event}"`);}
	const results: unknown[] = [];
	for (const handler of handlers) {
		results.push(await handler(payload, ctx));
	}
	return results;
}

/** A tool result message for `toolCallId`, as pi passes it in `TurnEndEvent.toolResults`. */
export function handoffToolResult(toolCallId: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "handoff",
		content: [{ type: "text", text: isError ? "Handoff rejected." : "Handoff staged." }],
		isError,
		timestamp: 0,
	};
}

/** A completed `turn_end` event with an empty boundary chain; override any field. */
export function turnEndEvent(overrides: Partial<TurnEndEvent> = {}): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		},
		toolResults: [],
		messageEntryId: "assistant-entry",
		toolResultEntryIds: [],
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
		outcome: "completed",
		...overrides,
	};
}

// ── Typed extension contexts ─────────────────────────────────────────
// Each method a test leaves out fails when the code under test calls it, naming the
// method: a method whose pi type returns a promise returns a rejected one, every
// other method throws. The unstubbed model registry is the exception: reading any
// of its members throws, whatever the member returns. So a test that reaches a
// method it did not stub fails, unless the code under test catches the error (spawn
// cleanup swallows a throwing ctx.ui.notify). Data members get the values pi
// reports for a session without UI; optional ones such as `thinkingLevel` are left
// out and read as `undefined`. An override whose value is `undefined` counts as
// left out.

function unstubbedError(member: string): Error {
	let where = "pass it in the overrides";
	if (member.startsWith("ctx.ui.")) {where = "pass it to createUIContext and that context as `ui`";}
	// The pinned pi's render context type has no keybinding formatters, so an override cannot name them.
	if (member.startsWith("context.")) {where = "assign it to the context createToolRenderContext returned";}
	return new Error(`${member} is not stubbed in this test context; ${where}.`);
}

function unstubbed(member: string): () => never {
	return () => {
		throw unstubbedError(member);
	};
}

function unstubbedAsync(member: string): () => Promise<never> {
	return () => Promise.reject(unstubbedError(member));
}

// The overrides without the members whose value is `undefined`, so spreading them
// over the defaults keeps a default instead of replacing it with `undefined`.
function definedOverrides<T extends object>(overrides: Partial<T>): Partial<T> {
	const defined: Partial<T> = {};
	for (const key in overrides) {
		if (Object.hasOwn(overrides, key) && overrides[key] !== undefined) {defined[key] = overrides[key];}
	}
	return defined;
}

// The methods `ModelRegistry` declares; its only data member, `runtime`, is private.
const MODEL_REGISTRY_MEMBERS = new Set(Object.getOwnPropertyNames(ModelRegistry.prototype).filter((name) => name !== "constructor"));

// A model registry on which reading any `ModelRegistry` method throws naming
// `ctx.modelRegistry`. Every other access behaves as on an empty object, so copying,
// comparing, printing or awaiting a context does not throw; only using the registry
// does, on the original context and on every copy.
function unstubbedModelRegistry(): ModelRegistry {
	const target: unknown = Object.create(ModelRegistry.prototype);
	if (!(target instanceof ModelRegistry)) {throw new Error("Object.create did not produce a ModelRegistry instance.");}
	return new Proxy(target, {
		get(registry, property, receiver) {
			if (typeof property === "string" && MODEL_REGISTRY_MEMBERS.has(property)) {throw unstubbedError("ctx.modelRegistry");}
			const value: unknown = Reflect.get(registry, property, receiver);
			return value;
		},
	});
}

/** An `ExtensionUIContext` with `theme` as its theme; every other member fails on call unless overridden. */
export function createUIContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		select: unstubbedAsync("ctx.ui.select"),
		confirm: unstubbedAsync("ctx.ui.confirm"),
		input: unstubbedAsync("ctx.ui.input"),
		notify: unstubbed("ctx.ui.notify"),
		onTerminalInput: unstubbed("ctx.ui.onTerminalInput"),
		setStatus: unstubbed("ctx.ui.setStatus"),
		setWorkingMessage: unstubbed("ctx.ui.setWorkingMessage"),
		setWorkingVisible: unstubbed("ctx.ui.setWorkingVisible"),
		setWorkingIndicator: unstubbed("ctx.ui.setWorkingIndicator"),
		setHiddenThinkingLabel: unstubbed("ctx.ui.setHiddenThinkingLabel"),
		setWidget: unstubbed("ctx.ui.setWidget"),
		setFooter: unstubbed("ctx.ui.setFooter"),
		setHeader: unstubbed("ctx.ui.setHeader"),
		setTitle: unstubbed("ctx.ui.setTitle"),
		custom: unstubbedAsync("ctx.ui.custom"),
		pasteToEditor: unstubbed("ctx.ui.pasteToEditor"),
		setEditorText: unstubbed("ctx.ui.setEditorText"),
		getEditorText: unstubbed("ctx.ui.getEditorText"),
		editor: unstubbedAsync("ctx.ui.editor"),
		addAutocompleteProvider: unstubbed("ctx.ui.addAutocompleteProvider"),
		setEditorComponent: unstubbed("ctx.ui.setEditorComponent"),
		getEditorComponent: unstubbed("ctx.ui.getEditorComponent"),
		theme,
		getAllThemes: unstubbed("ctx.ui.getAllThemes"),
		getTheme: unstubbed("ctx.ui.getTheme"),
		setTheme: unstubbed("ctx.ui.setTheme"),
		getToolsExpanded: unstubbed("ctx.ui.getToolsExpanded"),
		setToolsExpanded: unstubbed("ctx.ui.setToolsExpanded"),
		...definedOverrides(overrides),
	};
}

/**
 * An `ExtensionContext` without UI: `hasUI` false, mode `print`, `cwd` the process
 * directory, no model, an in-memory session manager for `cwd` and `createUIContext()`
 * as `ui`. `modelRegistry` throws on use unless overridden; every method fails on
 * call unless overridden.
 */
export function createExtensionContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	const defined = definedOverrides(overrides);
	const cwd = defined.cwd ?? process.cwd();
	return {
		ui: createUIContext(),
		mode: "print",
		hasUI: false,
		cwd,
		sessionManager: defined.sessionManager ?? SessionManager.inMemory(cwd),
		modelRegistry: unstubbedModelRegistry(),
		model: undefined,
		scopedModels: [],
		isIdle: unstubbed("ctx.isIdle"),
		isProjectTrusted: unstubbed("ctx.isProjectTrusted"),
		signal: undefined,
		abort: unstubbed("ctx.abort"),
		hasPendingMessages: unstubbed("ctx.hasPendingMessages"),
		shutdown: unstubbed("ctx.shutdown"),
		getContextUsage: unstubbed("ctx.getContextUsage"),
		compact: unstubbed("ctx.compact"),
		getSystemPrompt: unstubbed("ctx.getSystemPrompt"),
		...defined,
	};
}

/** `createExtensionContext` plus the command members, each failing on call unless overridden. */
export function createCommandContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	const { getSystemPromptOptions, waitForIdle, newSession, fork, navigateTree, switchSession, reload, ...base } = overrides;
	return Object.assign(createExtensionContext(base), {
		getSystemPromptOptions: getSystemPromptOptions ?? unstubbed("ctx.getSystemPromptOptions"),
		waitForIdle: waitForIdle ?? unstubbedAsync("ctx.waitForIdle"),
		newSession: newSession ?? unstubbedAsync("ctx.newSession"),
		fork: fork ?? unstubbedAsync("ctx.fork"),
		navigateTree: navigateTree ?? unstubbedAsync("ctx.navigateTree"),
		switchSession: switchSession ?? unstubbedAsync("ctx.switchSession"),
		reload: reload ?? unstubbedAsync("ctx.reload"),
	});
}

/** `createExtensionContext` plus no callable tools and an `executeTool` that rejects unless overridden. */
export function createToolContext(overrides: Partial<ExtensionToolContext> = {}): ExtensionToolContext {
	const { tools, executeTool, ...base } = overrides;
	return Object.assign(createExtensionContext(base), {
		tools: tools ?? [],
		executeTool: executeTool ?? unstubbedAsync("ctx.executeTool"),
	});
}

// ── Readonly test helpers ────────────────────────────────────────────

/** The composed tool_call handlers: the first blocking result, or `undefined` when none blocks. */
export type ToolCall = (event: { toolName: string; toolCallId?: string; input?: Record<string, unknown> }, ctx: { cwd?: string }) => Promise<ToolCallEventResult | undefined>;

// The tests pass a partial event and context, which the typed handlers do not admit, so each
// handler runs untyped and its result is checked to be a tool_call result or nothing.
type UntypedToolCallHandler = (event: Parameters<ToolCall>[0], ctx: Parameters<ToolCall>[1]) => Promise<unknown>;

function assertToolCallResult(value: unknown): asserts value is ToolCallEventResult | undefined {
	if (value === undefined) {return;}
	if (!isRecord(value) || typeof value.block !== "boolean" || (value.reason !== undefined && typeof value.reason !== "string")) {
		throw new Error("A tool_call handler returned something other than a tool_call result.");
	}
}

/**
 * Create a test PI instance with pi-schematic registered and its tool_call handlers composed as pi runs them.
 */
export async function registerReadonlyPI(): Promise<{ pi: TestPI; toolCall: ToolCall }> {
	const pi = await createTestHost();
	const handlers = pi.handlers.get("tool_call") as UntypedToolCallHandler[];
	// Pi runs tool_call handlers in registration order and the first block wins.
	const toolCall: ToolCall = async (event, ctx) => {
		for (const handler of handlers) {
			const result = await handler(event, ctx);
			assertToolCallResult(result);
			if (result?.block === true) {return result;}
		}
		return undefined;
	};
	return { pi, toolCall };
}

/** A UI command context whose notifications, statuses and widgets go nowhere, with no context usage. */
export function uiCommandContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	return createCommandContext({
		hasUI: true,
		ui: createUIContext({ notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }),
		getContextUsage: () => undefined,
		...overrides,
	});
}

/**
 * Create a minimal UI context with the required shape for tool_call/auth tests.
 */
export function makeReadonlyUICtx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			theme: { fg: (_name: string, text: string) => text },
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
		getContextUsage: () => null,
		...overrides,
	};
}

/** The denial phrase each platform's OS sandbox puts in a blocked write's error. */
export const SANDBOX_DENIAL_PHRASES: Partial<Record<NodeJS.Platform, string>> = {
	darwin: "Operation not permitted",
	linux: "Read-only file system",
};

/** Build a result shaped like pi's bash tool result for a command that exited with code 1. */
export function bashResult(output: string, isError = true) {
	return {
		content: [{ type: "text" as const, text: `${output}\n\nCommand exited with code 1` }],
		structuredContent: { output, truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
		isError,
	};
}

/** Join the text of a tool result's text blocks. */
export function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

// ── Temp directory helpers ──────────────────────────────────────────

export async function tmpDir(): Promise<string> {
	return mkdtemp(join(os.tmpdir(), "pi-test-"));
}

/**
 * `test` with a `dir` fixture: a fresh temp directory, created only for tests
 * that take `dir` and removed after the test, also when a check failed.
 */
export const testWithDir = base.extend<{ dir: string }>({
	dir: async ({}, use) => {
		const dir = await tmpDir();
		await use(dir);
		await rm(dir, { recursive: true, force: true });
	},
});

export async function withTempHome<T>(run: (homeDir: string) => T | Promise<T>): Promise<T> {
	const homeDir = await tmpDir();
	const restore = setTempHome(homeDir);
	try {
		return await run(homeDir);
	} finally {
		restore();
		await rm(homeDir, { recursive: true, force: true });
	}
}

/** Nest inside `withTempHome`, not around it: `withTempHome` clears `PI_CODING_AGENT_DIR` for its run. */
export async function withTempAgentDir<T>(run: (agentDir: string) => T | Promise<T>): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV_KEY];
	const agentDir = await tmpDir();
	process.env[AGENT_DIR_ENV_KEY] = agentDir;
	try {
		return await run(agentDir);
	} finally {
		restoreEnv(AGENT_DIR_ENV_KEY, previousAgentDir);
		await rm(agentDir, { recursive: true, force: true });
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
	const readonlyWriteTarget = params.cwdOutsideTemp
		? resolve(os.tmpdir(), "..", `readonly-child-escape-${process.pid}-${Date.now()}`)
		: "readonly-child-escape";
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
			id: "${modelId}", name: "Agentic E2E Model", reasoning: ${params.reasoning ?? false},
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
		globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
			outboundFetches.push(input instanceof Request ? input.url : String(input));
			return Promise.reject(new Error(`offline fixture blocked outbound fetch: ${outboundFetches.at(-1)}`));
		});
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
			reasoning: params.reasoning ?? false, input: ["text"],
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
		const pi = await createTestHost((api) => { registerSpawnTool(api, state); }, {
			toolSources: { agentic_e2e_probe: "project" },
			activeTools,
			allTools: activeTools,
		});
		const controller = new AbortController();
		if (params.abortBeforeStart) {controller.abort(new Error("fixture abort"));}
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
		if (previousAgentDir === undefined) {delete process.env.PI_CODING_AGENT_DIR;}
		else {process.env.PI_CODING_AGENT_DIR = previousAgentDir;}
		if (previousOpenAiApiKey === undefined) {delete process.env.OPENAI_API_KEY;}
		else {process.env.OPENAI_API_KEY = previousOpenAiApiKey;}
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
		notify: (message: string, level: string) => void;
		custom: (build: any) => Promise<unknown>;
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
			notify: overrides.notify ?? vi.fn(),
			setStatus: (key: string, status: string | undefined) => { record.statuses.set(key, status); },
			setWidget: (key: string, content: string[] | undefined) => { record.widgets.set(key, content); },
			...(overrides.custom !== undefined ? { custom: overrides.custom } : {}),
		},
		getContextUsage: () => (percent !== null ? { percent } : null),
	};
}
