// ── Shared test helpers ──────────────────────────────────────────
// Imported by other test files via `./helpers.js`
// Includes the real-API test host (see ./test-host.js), test utilities, theme constants, readonly helpers, etc.

import {
	CONFIG_DIR_NAME,
	ModelRegistry,
	SessionManager,
	Theme,
	type AgentToolResult,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionToolContext,
	type ExtensionUIContext,
	type KeybindingsManager,
	type ToolCallEventResult,
	type ToolDefinition,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import os from "node:os";
import { test as base, expect, vi } from "vitest";
import { createState, resetState } from "../../state.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { assertPresent, isRecord } from "../assertions.js";
import { AGENT_DIR_ENV_KEY } from "../paths.js";
import { createTestHost, getTool, loadTestKeybindings, type TestPI } from "./test-host.js";

export const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export const EMPTY_CHILD_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** `value` as a record; throws, naming `what`, unless it is an object. */
export function recordOf(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) {throw new Error(`Expected ${what} to be an object.`);}
	return value;
}

/** The details of a tool result; throws unless they are an object. */
export function detailsOf(result: AgentToolResult<unknown>): Record<string, unknown> {
	return recordOf(result.details, "the tool result details");
}

/** The text of the result's first content block; throws unless that block is text. */
export function firstText(result: AgentToolResult<unknown>): string {
	const block = result.content.at(0);
	if (block?.type !== "text") {throw new Error("Expected the tool result to start with a text block.");}
	return block.text;
}

/**
 * An object whose prototype is `prototype`, with `members` as own properties, so it
 * passes `instanceof` checks for the class. Every member left out is the class's own
 * and usually fails, because the object never ran the constructor.
 */
export function stubInstance<T extends object>(prototype: T, members: Partial<T>): T {
	const target: unknown = Object.create(prototype);
	if (!hasPrototype(target, prototype)) {throw new Error("Object.create did not produce an object with the given prototype.");}
	return Object.assign(target, members);
}

function hasPrototype<T extends object>(value: unknown, prototype: T): value is T {
	return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === prototype;
}

/** A failure after the child session exists is returned as an error result, not thrown. */
export function assertErrorResult(result: unknown, text: string, usage: unknown): void {
	if (!isRecord(result)) {throw new Error(`Expected a tool result object, got ${JSON.stringify(result)}.`);}
	expect(result.isError).toBe(true);
	expect(result.content).toStrictEqual([{ type: "text", text }]);
	if (!isRecord(result.details)) {throw new Error(`Expected a tool result with a details object, got ${JSON.stringify(result)}.`);}
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

export function createSession(messages: unknown[]) {
	return {
		messages,
		subscribe: () => vi.fn(),
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: vi.fn(() => Promise.resolve()),
	} as unknown as import("@earendil-works/pi-coding-agent").AgentSession;
}

export function createSubscribableSession(messages: unknown[] = []) {
	let handler: ((event: unknown) => void) | undefined;
	return {
		session: {
			messages,
			subscribe: (cb: (event: unknown) => void) => {
				handler = cb;
				return () => { handler = undefined; };
			},
			getToolDefinition: () => undefined,
			sessionManager: { getCwd: () => process.cwd() },
			abort: vi.fn(() => Promise.resolve()),
		} as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
		emit: (event: unknown) => handler?.(event),
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

// pi stores every handler as a wrapper that passes its arguments on and returns whatever the handler returns,
// a promise or a plain value; only that it is a function can be checked at run time.
function assertRegisteredHandler(value: unknown, event: string): asserts value is (...args: unknown[]) => unknown {
	if (typeof value !== "function") {throw new Error(`A "${event}" handler on the test host is not a function.`);}
}

// The live list of handlers registered for `event`, so a handler appended during a dispatch runs in that
// dispatch. Throws when none is registered.
function registeredHandlers(pi: TestPI, event: string): unknown[] {
	const handlers: unknown[] | undefined = pi.handlers.get(event);
	if (!handlers?.length) {throw new Error(`No handlers registered for "${event}"`);}
	return handlers;
}

/**
 * Run every handler registered for `event` in registration order. Unlike pi, which
 * catches each handler's error and runs the rest, a throwing handler stops the run
 * and fails the test. Throws when no handler is registered, so an unregistered
 * event cannot pass vacuously.
 */
export async function emitAll(pi: TestPI, event: string, payload: unknown, ctx: unknown): Promise<void> {
	for (const handler of registeredHandlers(pi, event)) {
		assertRegisteredHandler(handler, event);
		await handler(payload, ctx);
	}
}

/**
 * Like `emitAll`, but returns each handler's result in registration order. Each
 * handler sees the same payload: pi's chaining of boundary results between
 * handlers is not emulated.
 */
export async function callHandlers(pi: TestPI, event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of registeredHandlers(pi, event)) {
		assertRegisteredHandler(handler, event);
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
// left out, except `modelRegistry: undefined` on `createExtensionContext` and the
// builders on it, which builds a context without a registry.

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

// An instance of `prototype`'s class with `members` as its own; reading any other
// member `prototype` declares, method or accessor, throws `unstubbed(property)`.
// Every other access behaves as on an empty object, so copying, comparing, printing
// or awaiting the instance does not throw.
function guardedInstance<T extends object>(prototype: T, members: Partial<T>, unstubbed: (property: string) => Error): T {
	const declared = new Set(Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor"));
	return new Proxy(stubInstance(prototype, members), {
		get(instance, property, receiver) {
			if (typeof property === "string" && declared.has(property) && !Object.hasOwn(members, property)) {
				throw unstubbed(property);
			}
			const value: unknown = Reflect.get(instance, property, receiver);
			return value;
		},
	});
}

/** A `ModelRegistry` whose methods are `members`; reading any other `ModelRegistry` method throws, naming it. */
export function createModelRegistry(members: Partial<ModelRegistry>): ModelRegistry {
	return guardedInstance(ModelRegistry.prototype, members, (property) => new Error(`modelRegistry.${property} is not stubbed in this test registry; add it to the members.`));
}

// A model registry on which reading any `ModelRegistry` method throws naming
// `ctx.modelRegistry`, on the original context and on every copy.
function unstubbedModelRegistry(): ModelRegistry {
	return guardedInstance(ModelRegistry.prototype, {}, () => unstubbedError("ctx.modelRegistry"));
}

/** A model with `fields` over placeholder metadata: the id as name, a test api and base URL, zero cost and limits. */
export function testModel(fields: Pick<Model<Api>, "provider" | "id" | "input" | "reasoning"> & Partial<Model<Api>>): Model<Api> {
	return {
		name: fields.id, api: "test-api", baseUrl: "http://localhost.invalid",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0, ...fields,
	};
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
 * call unless overridden. `modelRegistry: undefined` is the one override set to
 * `undefined` that counts: it builds a context without a registry, as code that
 * checks for a missing registry sees one.
 */
export function createExtensionContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	const defined = definedOverrides(overrides);
	const cwd = defined.cwd ?? process.cwd();
	const missingRegistry: Partial<Pick<ExtensionContext, "modelRegistry">> = Object.hasOwn(overrides, "modelRegistry") && overrides.modelRegistry === undefined ? { modelRegistry: undefined } : {};
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
		...missingRegistry,
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

/**
 * A `ctx.ui.custom` that builds the component with a TUI whose `requestRender` does
 * nothing, `renderTheme` and pi's default keybindings, then runs `onOpen` with it.
 * As pi does, the first `done` disposes a built component that has a `dispose`
 * method. It resolves to the value the component passed to the first `done` by the
 * time `onOpen` finished, and rejects when the component did not call `done` by then.
 */
export function createCustomUI(renderTheme: Theme, onOpen: (component: Component) => void | Promise<void>): ExtensionUIContext["custom"] {
	const tui = stubInstance(TuiMainScreen.prototype, { requestRender: () => undefined });
	return async <T,>(factory: (tui: TuiMainScreen, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>): Promise<T> => {
		const keybindings = await loadTestKeybindings();
		const results: T[] = [];
		let built: Component | undefined;
		const component = await factory(tui, renderTheme, keybindings, (result) => {
			results.push(result);
			if (results.length === 1 && built !== undefined) {disposeComponent(built);}
		});
		built = component;
		await onOpen(component);
		if (results.length === 0) {throw new Error("The custom component did not call done.");}
		return results[0];
	};
}

// pi's `Component` type declares no `dispose`; pi calls it when a component has one.
function disposeComponent(component: Component): void {
	const dispose: unknown = Reflect.get(component, "dispose");
	if (typeof dispose === "function") {Reflect.apply(dispose, component, []);}
}

// ── Readonly test helpers ────────────────────────────────────────────

/** The composed tool_call handlers: the first blocking result, or `undefined` when none blocks. */
export type ToolCall = (event: { toolName: string; toolCallId?: string; input?: Record<string, unknown> }, ctx: { cwd?: string }) => Promise<ToolCallEventResult | undefined>;

// The tests pass a partial event and context, which the typed handlers do not admit, so each
// handler runs untyped and its result is checked to be a tool_call result or nothing.
function assertToolCallResult(value: unknown): asserts value is ToolCallEventResult | undefined {
	if (value === undefined) {return;}
	if (
		!isRecord(value)
		|| typeof value.block !== "boolean"
		|| (value.reason !== undefined && typeof value.reason !== "string")
		|| (value.terminate !== undefined && typeof value.terminate !== "boolean")
	) {
		throw new Error(`A tool_call handler returned something other than a tool_call result: ${JSON.stringify(value)}.`);
	}
}

/**
 * Create a test PI instance with pi-schematic registered and its tool_call handlers composed as pi runs them.
 */
export async function registerReadonlyPI(): Promise<{ pi: TestPI; toolCall: ToolCall }> {
	const pi = await createTestHost();
	// Pi runs tool_call handlers in registration order and the first block wins.
	const toolCall: ToolCall = async (event, ctx) => {
		for (const handler of registeredHandlers(pi, "tool_call")) {
			assertRegisteredHandler(handler, "tool_call");
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
	if (typeof value !== "number") {throw new Error(`The probe left ${name} as ${typeof value}, not a number.`);}
	return value;
}

// The probe global `name` as an array of items `isItem` accepts. An unset global throws unless `unsetAsEmpty`
// is true, which reads it as an empty array.
function probeArray<T>(name: ProbeGlobal, isItem: (item: unknown) => item is T, unsetAsEmpty = false): T[] {
	const value = unsetAsEmpty ? probeGlobal(name) ?? [] : probeGlobal(name);
	if (!Array.isArray(value)) {throw new Error(`The probe left ${name} as ${typeof value}, not an array.`);}
	const items: unknown[] = value;
	if (!items.every(isItem)) {throw new Error(`The probe left an unexpected item in ${name}.`);}
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
			id: modelId, name: "Agentic E2E Model", api: "agentic-e2e-api", provider, baseUrl: "http://localhost.invalid",
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
		setProbeGlobal("__agenticE2eState", state);
		setProbeGlobal("__agenticE2eController", controller);
		const prompts = params.prompts ?? [params.prompt];
		const updates: unknown[] = [];
		const onUpdate = params.resetOnRunningUpdate
			? (result: unknown) => {
				updates.push(result);
				resetState(state);
			}
			: (result: unknown) => { updates.push(result); };
		let results;
		try {
			const spawn = getTool(pi, "spawn");
			results = await Promise.all(prompts.map((prompt, index) => spawn.execute(
				`spawn-${params.thinking ?? "inherited"}-${index}`,
				{ prompt, thinking: params.thinking },
				controller.signal,
				onUpdate,
				createToolContext({ model, cwd }),
			)));
		} catch (error) {
			// Attach the partial proof so rejecting tests can assert bookkeeping
			// (e.g. that no update was published before an early abort).
			throw Object.assign(error as Error, {
				proof: {
					state,
					updates,
					observedMessages: probeGlobal("__agenticE2eMessages") ?? [],
					observedThinking: probeGlobal("__agenticE2eThinking") ?? [],
				},
			});
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
		if (previousAgentDir === undefined) {delete process.env.PI_CODING_AGENT_DIR;}
		else {process.env.PI_CODING_AGENT_DIR = previousAgentDir;}
		if (previousOpenAiApiKey === undefined) {delete process.env.OPENAI_API_KEY;}
		else {process.env.OPENAI_API_KEY = previousOpenAiApiKey;}
		globalThis.fetch = previousFetch;
		for (const name of PROBE_GLOBALS) {Reflect.deleteProperty(globalThis, name);}
		await rm(tempRoot, { recursive: true, force: true });
		await rm(readonlyWriteTarget, { force: true });
	}
}

// ── TUI context factory ───────────────────────────────────────────────

// The theme of `makeTUICtx`: `fg` marks the color as `[name:text]`; reading any other `Theme` member throws, naming it.
const tuiTheme = guardedInstance(
	Theme.prototype,
	{ fg: (name: string, text: string) => `[${name}:${text}]` },
	(property) => new Error(`theme.${property} is not stubbed in the makeTUICtx theme; it stubs only fg.`),
);

function isOptionalStringArray(value: unknown): value is string[] | undefined {
	return value === undefined || isStringArray(value);
}

/**
 * A TUI command and tool context: UI on (mode `tui`) unless `hasUI` is false (mode
 * `print`), `tuiTheme` as the theme, `setStatus` and `setWidget` recorded into
 * `record`, `notify` a no-op, every other UI member as `createUIContext` builds it,
 * `ui` over those, and context usage at `percent` (none when `percent` is null, the
 * default). It has no model registry, so code that refreshes model groups skips
 * them. `setWidget` throws for a component widget, which `record` cannot hold.
 */
export function makeTUICtx(
	overrides: Partial<{
		percent: number | null;
		hasUI: boolean;
		record: { statuses: Map<string, string | undefined>; widgets: Map<string, string[] | undefined> };
		ui: Partial<ExtensionUIContext>;
	}> = {},
): ExtensionCommandContext & ExtensionToolContext {
	const record = overrides.record ?? { statuses: new Map(), widgets: new Map() };
	const hasUI = overrides.hasUI ?? true;
	const percent = overrides.percent !== undefined ? overrides.percent : null;
	const ui = createUIContext({
		theme: tuiTheme,
		notify: vi.fn(),
		setStatus: (key, status) => { record.statuses.set(key, status); },
		setWidget: (key: string, content: unknown) => {
			if (!isOptionalStringArray(content)) {throw new Error(`makeTUICtx records only string widgets; "${key}" got a component.`);}
			record.widgets.set(key, content);
		},
		...definedOverrides(overrides.ui ?? {}),
	});
	return Object.assign(
		createCommandContext({
			hasUI,
			mode: hasUI ? "tui" : "print",
			ui,
			modelRegistry: undefined,
			getContextUsage: () => (percent !== null ? { tokens: null, contextWindow: 0, percent } : undefined),
		}),
		{ tools: [], executeTool: unstubbedAsync("ctx.executeTool") },
	);
}
