// ── Real-API test host ───────────────────────────────────────────────
// Drives the extension through pi's real loader-built `ExtensionAPI` instead
// of a hand-maintained API mirror. The api object returned here is the exact
// object the extension receives, augmented with test-only accessors.
//
// The api is captured through `DefaultResourceLoader` inline extension
// factories: each factory is wrapped so the wrapper sees the api pi passes it.
// The loader drops every discovered resource and runs with an untrusted project,
// a process-wide temp agent directory and in-memory settings, so no installed or
// project resource loads.

import type {
	AgentBeforeSettleEventResult,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	CacheWarmingDecisionEventResult,
	ContextEventResult,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionHandler,
	ExtensionRuntime,
	ExtensionShortcut,
	InputEventResult,
	KeybindingsManager,
	MessageEndEventResult,
	ModelRegistry,
	NormalizedBuildSystemPromptOptions,
	RegisteredCommand,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	Skill,
	SlashCommandInfo,
	ToolCallEventResult,
	ToolDefinition,
	ToolInfo,
	ToolResultEventResult,
	TurnEndEventResult,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import registerSchematic from "../../index.js";
import { piManifestPath } from "../../pi-packages.mjs";

// `ThinkingLevel` is not re-exported from the package root; derive it from the
// api surface so the harness stays pinned to whatever Pi exposes.
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

// Resolving the shipped dist path pins Pi's internal layout. Fail with the
// expected path + fix when Pi reorganizes it, instead of an opaque import error.
async function importInternal<T>(relativePath: string, exportNames: readonly string[]): Promise<T> {
	const guidance = "This host pins Pi's internal dist layout; update tests/unit/test-host.ts for the installed Pi version.";
	const url = pathToFileURL(join(dirname(piManifestPath), "dist", relativePath)).href;
	let mod: Record<string, unknown>;
	try {
		mod = (await import(url)) as Record<string, unknown>;
	} catch (cause) {
		throw new Error(`The test host could not load pi's internal module at ${url}. ${guidance}`, { cause });
	}
	for (const exportName of exportNames) {
		if (typeof mod[exportName] !== "function") {
			throw new Error(`pi's internal module at ${url} does not export ${exportName} as a function. ${guidance}`);
		}
	}
	return mod as T;
}

interface InternalSystemPrompt {
	normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions;
	buildSystemPrompt(input: BuildSystemPromptOptions): string;
}

const { normalizeBuildSystemPromptOptions, buildSystemPrompt } = await importInternal<InternalSystemPrompt>(
	"core/system-prompt.js",
	["normalizeBuildSystemPromptOptions", "buildSystemPrompt"],
);

// pi's package root exports `KeybindingsManager` as a type only.
interface InternalKeybindings {
	KeybindingsManager: typeof KeybindingsManager;
}

const internalKeybindings = await importInternal<InternalKeybindings>("core/keybindings.js", ["KeybindingsManager"]);

/** pi's keybindings with the default bindings, for the `keybindings` argument of a `ctx.ui.custom` factory. */
export const testKeybindings: KeybindingsManager = new internalKeybindings.KeybindingsManager();

/** The tool definitions the extension registered, by tool name. */
export type TestToolMap = Map<string, ToolDefinition>;

/**
 * Test-only accessors stamped onto the real api. Registration state is backed by
 * the real `Extension` maps; host actions are backed by `HostState`. The surface
 * exists so tests can observe registration and drive host side effects.
 */
export interface TestAccessors {
	handlers: Extension["handlers"];
	tools: TestToolMap;
	commands: Extension["commands"];
	shortcuts: Extension["shortcuts"];
	sentUserMessages: SentUserMessage[];
	sentMessages: SentMessage[];
	appendedEntries: AppendedEntry[];
	activeTools: string[];
	setCommands(commands: SlashCommandInfo[]): void;
}

export type TestPI = ExtensionAPI & TestAccessors;

/** A `pi.sendUserMessage` call the host recorded. */
export interface SentUserMessage {
	content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
	options?: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

/** A `pi.sendMessage` call the host recorded. */
export interface SentMessage {
	message: Parameters<ExtensionAPI["sendMessage"]>[0];
	options?: Parameters<ExtensionAPI["sendMessage"]>[1];
}

/** A `pi.appendEntry` call the host recorded. */
export interface AppendedEntry {
	customType: string;
	data: unknown;
}

/**
 * Every event `pi.on` accepts a handler for, except `project_trust`, whose handler
 * receives a different context.
 */
export type HostEventName = Exclude<ExtensionEvent["type"], "project_trust">;

export type HostEvent<K extends HostEventName> = Extract<ExtensionEvent, { type: K }>;

// The result type of each `pi.on` overload whose handler returns one. Handlers of the
// other events return nothing.
interface HostEventResults {
	resources_discover: ResourcesDiscoverResult;
	session_before_switch: SessionBeforeSwitchResult;
	session_before_fork: SessionBeforeForkResult;
	session_before_compact: SessionBeforeCompactResult;
	session_before_tree: SessionBeforeTreeResult;
	context: ContextEventResult;
	context_with_system: ContextEventResult;
	cache_warming_decision: CacheWarmingDecisionEventResult;
	before_provider_request: BeforeProviderRequestEventResult;
	before_agent_start: BeforeAgentStartEventResult;
	agent_before_settle: AgentBeforeSettleEventResult;
	turn_end: TurnEndEventResult;
	message_end: MessageEndEventResult;
	tool_call: ToolCallEventResult;
	tool_result: ToolResultEventResult;
	user_bash: UserBashEventResult;
	input: InputEventResult;
}

export type HostEventResult<K extends HostEventName> = K extends keyof HostEventResults ? HostEventResults[K] : undefined;

/** A handler as `pi.on(event, handler)` types it. */
export type HostHandler<K extends HostEventName> = ExtensionHandler<HostEvent<K>, HostEventResult<K>>;

/**
 * What the extension sees from its host: the values the host actions report once
 * loading finished, and the project directory pi works in.
 */
export interface TestHostSeed {
	/**
	 * The project directory pi's loader uses, which is also where a factory's
	 * `pi.exec` call runs during registration (after loading, the host replaces
	 * `pi.exec` with a stub that throws). Defaults to `process.cwd()`. Only
	 * `createTestHost` reads it; helpers that build their own context, event,
	 * session or host use `process.cwd()`.
	 */
	cwd?: string;
	activeTools?: string[];
	allTools?: string[];
	toolSources?: Record<string, string>;
	thinkingLevel?: ThinkingLevel;
}

interface HostState {
	activeTools: string[];
	allToolNames: string[];
	toolSources: Map<string, string>;
	commands: SlashCommandInfo[];
	thinkingLevel: ThinkingLevel;
	sentUserMessages: SentUserMessage[];
	sentMessages: SentMessage[];
	appendedEntries: AppendedEntry[];
}

function defaultToolSource(): string {
	return "builtin";
}

function applyActiveTools(state: HostState, tools: string[]): void {
	state.activeTools.length = 0;
	state.activeTools.push(...tools);
	for (const name of tools) {
		if (!state.toolSources.has(name)) {state.toolSources.set(name, defaultToolSource());}
	}
}

function applyAllTools(state: HostState, tools: string[]): void {
	state.allToolNames.length = 0;
	state.allToolNames.push(...tools);
	for (const name of tools) {
		if (!state.toolSources.has(name)) {state.toolSources.set(name, defaultToolSource());}
	}
}

// Synthesizes `getAllTools()` entries. Production reads only `.name` (see
// getInheritableParentToolNames); the remaining fields are placeholders so the
// `ToolInfo` shape stays valid.
function buildAllTools(state: HostState): ToolInfo[] {
	const names = state.allToolNames.length ? state.allToolNames : state.activeTools;
	return names.map((name) => ({
		name,
		description: "",
		exposure: "direct" as const,
		parameters: Type.Object({}),
		sourceInfo: {
			path: `<${state.toolSources.get(name) ?? defaultToolSource()}:${name}>`,
			source: state.toolSources.get(name) ?? defaultToolSource(),
			scope: "temporary" as const,
			origin: "top-level" as const,
		},
	}));
}

function createHostState(seed: TestHostSeed): HostState {
	const state: HostState = {
		activeTools: [],
		allToolNames: [],
		toolSources: new Map(),
		commands: [],
		thinkingLevel: seed.thinkingLevel ?? "medium",
		sentUserMessages: [],
		sentMessages: [],
		appendedEntries: [],
	};
	for (const [name, source] of Object.entries(seed.toolSources ?? {})) {state.toolSources.set(name, source);}
	if (seed.activeTools) {applyActiveTools(state, seed.activeTools);}
	if (seed.allTools) {applyAllTools(state, seed.allTools);}
	return state;
}

// The real api delegates every action to `runtime.*` at call time, except
// `exec`, which runs pi's command directly. Binding after the load makes
// post-load calls observable and overridable, while a call made during
// registration still gets pi's own unbound-runtime error — for every action
// except `exec`, where a registration-time call runs a real command.
function bindHostActions(runtime: ExtensionRuntime, state: HostState): void {
	bindConversationActions(runtime, state);
	bindToolAndModelActions(runtime, state);
}

// Conversation/entry side effects tests assert on.
function bindConversationActions(runtime: ExtensionRuntime, state: HostState): void {
	Object.assign(runtime, {
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			state.sentMessages.push({ message, options });
		},
		sendUserMessage: (content: SentUserMessage["content"], options?: SentUserMessage["options"]) => {
			state.sentUserMessages.push({ content, options });
		},
		appendEntry: (customType: string, data?: unknown) => {
			state.appendedEntries.push({ customType, data });
		},
		setSessionName: () => { /* No test reads the session name back. */ },
		getSessionName: () => undefined,
		setLabel: () => { /* No test reads labels back. */ },
	});
}

// Tool/command/model state backing post-load reads.
function bindToolAndModelActions(runtime: ExtensionRuntime, state: HostState): void {
	Object.assign(runtime, {
		getActiveTools: () => [...state.activeTools],
		getAllTools: () => buildAllTools(state),
		setActiveTools: (names: string[]) => {
			applyActiveTools(state, names);
		},
		getCommands: () => [...state.commands],
		setModel: () => Promise.resolve(true),
		getThinkingLevel: () => state.thinkingLevel,
		setThinkingLevel: (level: ThinkingLevel) => {
			state.thinkingLevel = level;
		},
	});
}

function deriveTools(extension: Extension): TestToolMap {
	const tools: TestToolMap = new Map();
	for (const [name, registered] of extension.tools) {
		tools.set(name, registered.definition);
	}
	return tools;
}

// The extension and host state behind each host `createTestHost` returned, for the typed getters below.
const hosts = new WeakMap<ExtensionAPI, { extension: Extension; state: HostState }>();

function stampAccessors(api: ExtensionAPI, extension: Extension, state: HostState): TestPI {
	hosts.set(api, { extension, state });
	const pi = api as TestPI;
	pi.handlers = extension.handlers;
	pi.commands = extension.commands;
	pi.shortcuts = extension.shortcuts;
	pi.sentUserMessages = state.sentUserMessages;
	pi.sentMessages = state.sentMessages;
	pi.appendedEntries = state.appendedEntries;
	Object.defineProperty(pi, "tools", { get: () => deriveTools(extension), configurable: true });
	Object.defineProperty(pi, "activeTools", {
		get: () => state.activeTools,
		set: (tools: string[]) => { applyActiveTools(state, tools); },
		configurable: true,
	});
	pi.setCommands = (commands: SlashCommandInfo[]) => {
		state.commands = [...commands];
	};
	pi.exec = () => {
		return Promise.reject(new Error("pi.exec is not available in the test host; override pi.exec in the test if needed."));
	};
	return pi;
}

let agentDir: string | undefined;

// One empty agent directory per process: pi requires one, and a fresh path keeps
// the real agent directory out of the load. Removed at exit; a run killed by a
// signal leaves it behind.
function testAgentDir(): string {
	if (agentDir === undefined) {
		const dir = mkdtempSync(join(tmpdir(), "pi-schematic-test-agent-"));
		process.once("exit", () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// A throw here would fail a run whose tests passed; a directory left behind costs nothing.
			}
		});
		agentDir = dir;
	}
	return agentDir;
}

/**
 * Load `factories` through pi's `DefaultResourceLoader` as inline extensions and
 * bind the host actions onto the runtime pi built. `apis[i]` and `extensions[i]`
 * belong to `factories[i]`; the pairing relies on pi loading inline factories one
 * after another, in order, and the count check below guards that pairing: it catches
 * pi loading an extra discovered extension or dropping one. Throws one error listing
 * the load errors, each starting a new line as `path: error`.
 */
async function loadExtensions(
	factories: ExtensionFactory[],
	state: HostState,
	cwd: string,
): Promise<{ apis: ExtensionAPI[]; extensions: Extension[]; runtime: ExtensionRuntime }> {
	const apis: ExtensionAPI[] = [];
	const wrapped = factories.map((factory, index): ExtensionFactory => async (api) => {
		apis[index] = api;
		return factory(api);
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: testAgentDir(),
		// An untrusted project keeps pi from scanning `<cwd>/.pi` and ancestor `.agents/skills` directories.
		settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
		extensionFactories: wrapped,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		// Any set value, empty included, stops pi from looking for SYSTEM.md and APPEND_SYSTEM.md.
		systemPrompt: "",
		appendSystemPrompt: [],
	});
	await loader.reload();
	const { extensions, errors, runtime } = loader.getExtensions();
	// Tool and flag conflicts count too: pi's loader keeps both extensions, but the pi CLI exits on any load error.
	// pi keeps only the message of a factory's error, and reports a thrown non-Error value as "failed to load
	// extension". The original value is not captured: the message names the failing extension, which is enough.
	if (errors.length > 0) {
		throw new Error(`pi reported extension load errors:\n${errors.map((e) => `${e.path}: ${e.error}`).join("\n")}`);
	}
	if (extensions.length !== factories.length) {
		throw new Error(
			`pi loaded ${extensions.length} extensions for ${factories.length} factories: ${extensions.map((e) => e.path).join(", ")}.`,
		);
	}
	bindHostActions(runtime, state);
	return { apis, extensions, runtime };
}

/**
 * Load the extension (or a single registration function) through pi's real
 * loader. Returns the real api with test accessors stamped on.
 *
 * @param factory Extension factory; pass an arrow to register part of the API.
 * @param seed Host state the actions report once loading finished.
 */
export async function createTestHost(
	factory: ExtensionFactory = registerSchematic,
	seed: TestHostSeed = {},
): Promise<TestPI> {
	const cwd = seed.cwd ?? process.cwd();
	const state = createHostState(seed);
	const { apis, extensions } = await loadExtensions([factory], state, cwd);
	return stampAccessors(apis[0], extensions[0], state);
}

/**
 * A user-prompt `before_agent_start` event shaped like pi's: fresh normalized
 * prompt options and a `systemPrompt` getter that renders them. Without
 * `systemPrompt`, pi's default preamble applies.
 */
export function createBeforeAgentStartEvent(init?: { systemPrompt?: string; skills?: Skill[] }): BeforeAgentStartEvent {
	const systemPromptOptions = normalizeBuildSystemPromptOptions({
		cwd: process.cwd(),
		skills: init?.skills ?? [],
		customPrompt: init?.systemPrompt,
	});
	return {
		type: "before_agent_start" as const,
		messageType: "user" as const,
		prompt: "",
		images: undefined,
		get systemPrompt() {
			return buildSystemPrompt(systemPromptOptions);
		},
		systemPromptOptions,
	};
}

/**
 * Dispatch one `before_agent_start` run through pi's real `ExtensionRunner` with
 * the `before` factories, then schematic, then the `after` factories loaded in
 * that order. Throws when any handler threw, because pi reports handler errors
 * and continues. `prompt` is `buildSystemPrompt` over the resulting options: it
 * is faithful for extension sections, while pi finalizes its own tools section
 * later in the run.
 */
export async function emitBeforeAgentStart(init: {
	before?: ExtensionFactory[];
	after?: ExtensionFactory[];
}): Promise<{ result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>; prompt: string }> {
	const cwd = process.cwd();
	const { extensions, runtime } = await loadExtensions(
		[...(init.before ?? []), registerSchematic, ...(init.after ?? [])],
		createHostState({}),
		cwd,
	);
	// No registry: refreshModelGroupsState skips loading, so model-group config in the real home directory cannot leak in.
	const runner = new ExtensionRunner(
		extensions,
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		undefined as unknown as ModelRegistry,
	);
	const errors: ExtensionError[] = [];
	runner.onError((error) => {
		errors.push(error);
	});
	const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, { cwd });
	if (errors.length > 0) {throw new AggregateError(errors, "before_agent_start handler failed");}
	return { result, prompt: buildSystemPrompt(result.systemPromptOptions) };
}

function hostOf(pi: TestPI): { extension: Extension; state: HostState } {
	const host = hosts.get(pi);
	if (host === undefined) {throw new Error("This api was not returned by createTestHost.");}
	return host;
}

// pi.on's overloads tie each event name to its handler type when the handler is
// registered, and pi stores a wrapper that forwards the handler's return value. A
// stored handler therefore has its event's type; only that it is a function can be
// checked at run time.
function assertHostHandler<K extends HostEventName>(value: unknown, event: K): asserts value is HostHandler<K> {
	if (typeof value !== "function") {throw new Error(`The "${event}" handler on the test host is not a function.`);}
}

/**
 * Every handler registered for `event`, in registration order, typed as `pi.on`
 * types it. Throws when none is registered, so an unregistered event cannot pass
 * vacuously.
 */
export function getHandlers<K extends HostEventName>(pi: TestPI, event: K): HostHandler<K>[] {
	const registered = hostOf(pi).extension.handlers.get(event) ?? [];
	if (registered.length === 0) {throw new Error(`No "${event}" handler is registered on the test host.`);}
	return registered.map((handler) => {
		const candidate: unknown = handler;
		assertHostHandler(candidate, event);
		return candidate;
	});
}

/**
 * The handler registered for `event` at `index` in registration order (default the
 * first). Throws, naming the event and index, unless `index` is a non-negative
 * integer below the number of registered handlers.
 */
export function getHandler<K extends HostEventName>(pi: TestPI, event: K, index = 0): HostHandler<K> {
	const handlers = getHandlers(pi, event);
	if (!Number.isInteger(index) || index < 0 || index >= handlers.length) {
		throw new Error(`No "${event}" handler at index ${String(index)}; ${String(handlers.length)} registered on the test host.`);
	}
	return handlers[index];
}

/**
 * Calls the handler `getHandler(pi, event, index)` returns and resolves to its
 * result, with a handler that returned nothing resolved to `undefined`, so
 * `assertPresent` can narrow the result.
 */
export async function invokeHandler<K extends HostEventName>(
	pi: TestPI,
	event: K,
	payload: HostEvent<K>,
	ctx: ExtensionContext,
	index = 0,
): Promise<HostEventResult<K> | undefined> {
	const result = await getHandler(pi, event, index)(payload, ctx);
	if (result === undefined) {return undefined;}
	return result;
}

/** The definition of the tool registered as `name`. Throws, naming the tool, when none is. */
export function getTool(pi: TestPI, name: string): ToolDefinition {
	const registered = hostOf(pi).extension.tools.get(name);
	if (registered === undefined) {throw new Error(`No tool "${name}" is registered on the test host.`);}
	return registered.definition;
}

/** A tool's `renderCall` as pi types it. */
export type ToolRenderCall = NonNullable<ToolDefinition["renderCall"]>;

/** A tool's `renderResult` as pi types it. */
export type ToolRenderResult = NonNullable<ToolDefinition["renderResult"]>;

// The `member` renderer of the tool registered as `name`, bound to its definition.
function getToolRenderer(pi: TestPI, name: string, member: "renderCall"): ToolRenderCall;
function getToolRenderer(pi: TestPI, name: string, member: "renderResult"): ToolRenderResult;
function getToolRenderer(pi: TestPI, name: string, member: "renderCall" | "renderResult"): ToolRenderCall | ToolRenderResult {
	const definition = getTool(pi, name);
	const renderer = definition[member];
	if (renderer === undefined) {throw new Error(`Tool "${name}" on the test host has no ${member}.`);}
	return renderer.bind(definition);
}

/**
 * The `renderCall` of the tool registered as `name`, bound to its definition.
 * Throws, naming the tool, when none is registered or it has no `renderCall`.
 */
export function getToolRenderCall(pi: TestPI, name: string): ToolRenderCall {
	return getToolRenderer(pi, name, "renderCall");
}

/**
 * The `renderResult` of the tool registered as `name`, bound to its definition.
 * Throws, naming the tool, when none is registered or it has no `renderResult`.
 */
export function getToolRenderResult(pi: TestPI, name: string): ToolRenderResult {
	return getToolRenderer(pi, name, "renderResult");
}

/** The command registered as `name`. Throws, naming the command, when none is. */
export function getCommand(pi: TestPI, name: string): RegisteredCommand {
	const command = hostOf(pi).extension.commands.get(name);
	if (command === undefined) {throw new Error(`No command "${name}" is registered on the test host.`);}
	return command;
}

/** The shortcut registered for `key`. Throws, naming the key, when none is. */
export function getShortcut(pi: TestPI, key: KeyId): ExtensionShortcut {
	const shortcut = hostOf(pi).extension.shortcuts.get(key);
	if (shortcut === undefined) {throw new Error(`No shortcut "${key}" is registered on the test host.`);}
	return shortcut;
}

/**
 * The host's live records of `sendMessage`, `sendUserMessage` and `appendEntry`
 * calls: the same arrays as `pi.sentMessages`, `pi.sentUserMessages` and
 * `pi.appendedEntries`, typed.
 */
export function getHostRecords(pi: TestPI): {
	sentMessages: readonly SentMessage[];
	sentUserMessages: readonly SentUserMessage[];
	appendedEntries: readonly AppendedEntry[];
} {
	const { state } = hostOf(pi);
	return { sentMessages: state.sentMessages, sentUserMessages: state.sentUserMessages, appendedEntries: state.appendedEntries };
}
