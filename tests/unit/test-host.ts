// ── Real-API test host ───────────────────────────────────────────────
// Drives the extension through pi's real loader-built `ExtensionAPI` instead
// of a hand-maintained API mirror. The api object returned here is the exact
// object the extension receives, augmented with test-only accessors.
//
// Why the internal loader: pi ships `loadExtensionFromFactory` in
// `core/extensions` but does not re-export it from the package root, and no
// public path captures the api object. Resolving the shipped module directly
// keeps the API surface real (compile-checked by `factory`) with no mirror.

import type {
	BeforeAgentStartEvent,
	BuildSystemPromptOptions,
	EventBus,
	Extension,
	ExtensionAPI,
	ExtensionError,
	ExtensionFactory,
	ExtensionRuntime,
	ModelRegistry,
	NormalizedBuildSystemPromptOptions,
	Skill,
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createEventBus, createExtensionRuntime, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import registerSchematic from "../../index.js";

// `ThinkingLevel` is not re-exported from the package root; derive it from the
// api surface so the harness stays pinned to whatever Pi exposes.
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type InternalLoader = {
	loadExtensionFromFactory(
		factory: ExtensionFactory,
		cwd: string,
		eventBus: EventBus,
		runtime: ExtensionRuntime,
		extensionPath?: string,
	): Promise<Extension>;
};

// Resolving the shipped dist path pins Pi's internal layout. Fail with the
// expected path + fix when Pi reorganizes it, instead of an opaque import error.
async function importInternal<T>(relativePath: string, exportNames: readonly string[]): Promise<T> {
	const url = new URL(relativePath, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
	const guidance = "This host pins Pi's internal dist layout; update tests/unit/test-host.ts for the installed Pi version.";
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

const { loadExtensionFromFactory } = await importInternal<InternalLoader>("core/extensions/index.js", [
	"loadExtensionFromFactory",
]);

type InternalSystemPrompt = {
	normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions;
	buildSystemPrompt(input: BuildSystemPromptOptions): string;
};

const { normalizeBuildSystemPromptOptions, buildSystemPrompt } = await importInternal<InternalSystemPrompt>(
	"core/system-prompt.js",
	["normalizeBuildSystemPromptOptions", "buildSystemPrompt"],
);

/** Raw tool definitions as tests consume them (unwrapped; loose to keep call sites ergonomic). */
export type TestToolMap = Map<string, any>;

/**
 * Test-only accessors stamped onto the real api. Registration state is backed by
 * the real `Extension` maps; host actions are backed by `HostState`. The surface
 * exists so tests can observe registration and drive host side effects.
 */
export interface TestAccessors {
	handlers: Map<string, any[]>;
	tools: TestToolMap;
	commands: Map<string, any>;
	shortcuts: Map<string, any>;
	sentUserMessages: Array<{ content: any; options?: any }>;
	sentMessages: Array<{ message: any; options?: any }>;
	appendedEntries: Array<{ customType: string; data: any }>;
	activeTools: string[];
	setCommands(commands: any[]): void;
	/** Test-only flag writer; production pi only exposes getFlag/registerFlag. Backed by runtime.flagValues so the real getFlag reader sees the value. */
	setFlag(name: string, value: boolean | string): void;
}

export type TestPI = ExtensionAPI & TestAccessors;

/** Host state seeded before the extension factory runs. */
export interface TestHostSeed {
	activeTools?: string[];
	allTools?: string[];
	toolSources?: Record<string, string>;
	thinkingLevel?: ThinkingLevel;
	/** pi's configured shell, returned by getSettings(); the workflow shell reads shellPath. */
	shellPath?: string;
}

interface HostState {
	activeTools: string[];
	allToolNames: string[];
	toolSources: Map<string, string>;
	commands: any[];
	thinkingLevel: ThinkingLevel;
	shellPath: string | undefined;
	sentUserMessages: Array<{ content: any; options?: any }>;
	sentMessages: Array<{ message: any; options?: any }>;
	appendedEntries: Array<{ customType: string; data: any }>;
}

function defaultToolSource(): string {
	return "builtin";
}

function applyActiveTools(state: HostState, tools: string[]): void {
	state.activeTools.length = 0;
	state.activeTools.push(...tools);
	for (const name of tools) {
		if (!state.toolSources.has(name)) state.toolSources.set(name, defaultToolSource());
	}
}

function applyAllTools(state: HostState, tools: string[]): void {
	state.allToolNames.length = 0;
	state.allToolNames.push(...tools);
	for (const name of tools) {
		if (!state.toolSources.has(name)) state.toolSources.set(name, defaultToolSource());
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
		parameters: {} as any,
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
		shellPath: seed.shellPath,
		sentUserMessages: [],
		sentMessages: [],
		appendedEntries: [],
	};
	for (const [name, source] of Object.entries(seed.toolSources ?? {})) state.toolSources.set(name, source);
	if (seed.activeTools) applyActiveTools(state, seed.activeTools);
	if (seed.allTools) applyAllTools(state, seed.allTools);
	return state;
}

// The host-action seam: the real api delegates every action to `runtime.*` at
// call time, so binding here makes both registration-time and post-load calls
// observable and overridable.
function bindHostActions(runtime: ExtensionRuntime, state: HostState): void {
	bindConversationActions(runtime, state);
	bindToolAndModelActions(runtime, state);
}

// Conversation/entry side effects tests assert on.
function bindConversationActions(runtime: ExtensionRuntime, state: HostState): void {
	Object.assign(runtime, {
		sendMessage: (message: any, options?: any) => {
			state.sentMessages.push({ message, options });
		},
		sendUserMessage: (content: any, options?: any) => {
			state.sentUserMessages.push({ content, options });
		},
		appendEntry: (customType: string, data?: any) => {
			state.appendedEntries.push({ customType, data });
		},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
	});
}

// Tool/command/model state backing registration-time and runtime reads.
function bindToolAndModelActions(runtime: ExtensionRuntime, state: HostState): void {
	Object.assign(runtime, {
		getActiveTools: () => [...state.activeTools],
		getAllTools: () => buildAllTools(state),
		setActiveTools: (names: string[]) => {
			applyActiveTools(state, names);
		},
		getCommands: () => [...state.commands],
		// The workflow shell reads shellPath from getSettings() before any await; an
		// unbound handler is the notInitialized sentinel and kills every shell effect.
		// Every Settings field is optional, so this is a valid full value; a future
		// required field will fail this annotation without a cast hiding it.
		getSettings: (): ReturnType<ExtensionAPI["getSettings"]> => ({ shellPath: state.shellPath }),
		setModel: async () => true,
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

function stampAccessors(api: ExtensionAPI, extension: Extension, state: HostState, runtime: ExtensionRuntime): TestPI {
	const pi = api as TestPI;
	pi.handlers = extension.handlers as unknown as Map<string, any[]>;
	pi.commands = extension.commands as unknown as Map<string, any>;
	pi.shortcuts = extension.shortcuts as unknown as Map<string, any>;
	pi.sentUserMessages = state.sentUserMessages;
	pi.sentMessages = state.sentMessages;
	pi.appendedEntries = state.appendedEntries;
	Object.defineProperty(pi, "tools", { get: () => deriveTools(extension), configurable: true });
	Object.defineProperty(pi, "activeTools", {
		get: () => state.activeTools,
		set: (tools: string[]) => applyActiveTools(state, tools),
		configurable: true,
	});
	pi.setCommands = (commands: SlashCommandInfo[]) => {
		state.commands = [...commands];
	};
	// Write through the real flagValues map so pi.getFlag (which reads it) observes the value.
	pi.setFlag = (name: string, value: boolean | string) => {
		runtime.flagValues.set(name, value);
	};
	pi.exec = async () => {
		throw new Error("pi.exec is not available in the test host; override pi.exec in the test if needed.");
	};
	return pi;
}

/**
 * Load the extension (or a single registration function) through pi's real
 * loader. Returns the real api with test accessors stamped on.
 *
 * @param factory Extension factory; pass an arrow to register part of the API.
 * @param seed State applied before the factory runs (pre-registration setup).
 */
export async function createTestHost(
	factory: ExtensionFactory = registerSchematic,
	seed: TestHostSeed = {},
): Promise<TestPI> {
	const state = createHostState(seed);
	const runtime = createExtensionRuntime();
	bindHostActions(runtime, state);
	let api!: ExtensionAPI;
	const extension = await loadExtensionFromFactory(
		(realApi) => {
			api = realApi;
			return factory(realApi);
		},
		process.cwd(),
		createEventBus(),
		runtime,
	);
	return stampAccessors(api, extension, state, runtime);
}

/**
 * A user-prompt `before_agent_start` event shaped like pi's: fresh normalized
 * prompt options and a `systemPrompt` getter that renders them. Without
 * `systemPrompt`, pi's default preamble applies.
 *
 * Pi 1.2 and later type the event as a union discriminated by `messageType`;
 * pi 0.99 through 1.1 have no such field. The event is returned through a
 * variable rather than as a literal, so the older type accepts the extra
 * `messageType` property.
 */
export function createBeforeAgentStartEvent(init?: { systemPrompt?: string; skills?: Skill[] }): BeforeAgentStartEvent {
	const systemPromptOptions = normalizeBuildSystemPromptOptions({
		cwd: process.cwd(),
		skills: init?.skills ?? [],
		customPrompt: init?.systemPrompt,
	});
	const event = {
		type: "before_agent_start" as const,
		messageType: "user" as const,
		prompt: "",
		images: undefined,
		get systemPrompt() {
			return buildSystemPrompt(systemPromptOptions);
		},
		systemPromptOptions,
	};
	return event;
}

type EmitBeforeAgentStartArgs = Parameters<ExtensionRunner["emitBeforeAgentStart"]>;
// Pi 0.99 through 1.1 take the prompt string first; pi 1.2 and later take a trigger object.
type TakesPromptFirst = EmitBeforeAgentStartArgs extends [string, ...unknown[]] ? true : false;
// Each shape is the real argument list on the pi versions that take it, and `unknown` on the others.
type PromptShapeArgs = TakesPromptFirst extends true ? EmitBeforeAgentStartArgs : unknown;
type TriggerShapeArgs = TakesPromptFirst extends true ? unknown : EmitBeforeAgentStartArgs;

/**
 * Arguments for an empty user-prompt run on the installed runner. Pi 0.99
 * through 1.1 take `(prompt, images, systemPromptOptions)`; pi 1.2 and later
 * take `(trigger, systemPromptOptions)`. The runner's arity picks the shape, and
 * any other arity throws. The shape for the installed pi is type-checked against
 * its signature; the other shape is typed `unknown` and goes unchecked.
 */
function userPromptRunArgs(runner: ExtensionRunner, systemPromptOptions: BuildSystemPromptOptions): EmitBeforeAgentStartArgs {
	const arity = runner.emitBeforeAgentStart.length;
	if (arity === 3) {
		const args: PromptShapeArgs = ["", undefined, systemPromptOptions];
		// Identity on pi 0.99 through 1.1; on pi 1.2 and later `args` is `unknown` and this branch never runs.
		return args as EmitBeforeAgentStartArgs;
	}
	if (arity === 2) {
		const args: TriggerShapeArgs = [{ messageType: "user", prompt: "" }, systemPromptOptions];
		// Identity on pi 1.2 and later; on pi 0.99 through 1.1 `args` is `unknown` and this branch never runs.
		return args as EmitBeforeAgentStartArgs;
	}
	throw new Error(
		`pi's ExtensionRunner.emitBeforeAgentStart takes ${arity} parameters; the test host knows 3 (pi 0.99 to 1.1) and 2 (pi 1.2 and later). Update tests/unit/test-host.ts for the installed Pi version.`,
	);
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
	const state = createHostState({});
	const runtime = createExtensionRuntime();
	bindHostActions(runtime, state);
	const eventBus = createEventBus();
	const extensions: Extension[] = [];
	for (const factory of [...(init.before ?? []), registerSchematic, ...(init.after ?? [])]) {
		extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
	}
	// No registry: refreshModelGroupsState skips loading, so model-group config in the real home directory cannot leak in.
	const runner = new ExtensionRunner(
		extensions,
		runtime,
		process.cwd(),
		SessionManager.inMemory(process.cwd()),
		undefined as unknown as ModelRegistry,
	);
	const errors: ExtensionError[] = [];
	runner.onError((error) => {
		errors.push(error);
	});
	const result = await runner.emitBeforeAgentStart(...userPromptRunArgs(runner, { cwd: process.cwd() }));
	if (errors.length > 0) throw new AggregateError(errors, "before_agent_start handler failed");
	return { result, prompt: buildSystemPrompt(result.systemPromptOptions) };
}
