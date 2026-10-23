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
	BeforeAgentStartEvent,
	BuildSystemPromptOptions,
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
import { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import registerSchematic from "../../index.js";

// `ThinkingLevel` is not re-exported from the package root; derive it from the
// api surface so the harness stays pinned to whatever Pi exposes.
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

// Resolving the shipped dist path pins Pi's internal layout. Fail with the
// expected path + fix when Pi reorganizes it, instead of an opaque import error.
async function importInternal<T>(relativePath: string, exportNames: readonly string[]): Promise<T> {
	const guidance = "This host pins Pi's internal dist layout; update tests/unit/test-host.ts for the installed Pi version.";
	let url: string;
	let mod: Record<string, unknown>;
	try {
		const manifestPath = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
		if (manifestPath === undefined) {
			throw new Error("Cannot find the installed pi package.json from tests/unit/test-host.ts.");
		}
		url = pathToFileURL(join(dirname(manifestPath), "dist", relativePath)).href;
		mod = (await import(url)) as Record<string, unknown>;
	} catch (cause) {
		throw new Error(`The test host could not load pi's internal module ${relativePath}. ${guidance}`, { cause });
	}
	for (const exportName of exportNames) {
		if (typeof mod[exportName] !== "function") {
			throw new Error(`pi's internal module at ${url} does not export ${exportName} as a function. ${guidance}`);
		}
	}
	return mod as T;
}

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
}

export type TestPI = ExtensionAPI & TestAccessors;

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
	commands: any[];
	thinkingLevel: ThinkingLevel;
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
		sentUserMessages: [],
		sentMessages: [],
		appendedEntries: [],
	};
	for (const [name, source] of Object.entries(seed.toolSources ?? {})) state.toolSources.set(name, source);
	if (seed.activeTools) applyActiveTools(state, seed.activeTools);
	if (seed.allTools) applyAllTools(state, seed.allTools);
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

// Tool/command/model state backing post-load reads.
function bindToolAndModelActions(runtime: ExtensionRuntime, state: HostState): void {
	Object.assign(runtime, {
		getActiveTools: () => [...state.activeTools],
		getAllTools: () => buildAllTools(state),
		setActiveTools: (names: string[]) => {
			applyActiveTools(state, names);
		},
		getCommands: () => [...state.commands],
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

function stampAccessors(api: ExtensionAPI, extension: Extension, state: HostState): TestPI {
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
	pi.exec = async () => {
		throw new Error("pi.exec is not available in the test host; override pi.exec in the test if needed.");
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
		process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
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
	return stampAccessors(apis[0]!, extensions[0]!, state);
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
	const result = await runner.emitBeforeAgentStart(...userPromptRunArgs(runner, { cwd }));
	if (errors.length > 0) throw new AggregateError(errors, "before_agent_start handler failed");
	return { result, prompt: buildSystemPrompt(result.systemPromptOptions) };
}
