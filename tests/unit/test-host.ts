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
	EventBus,
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
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

const internalUrl = new URL(
	"core/extensions/index.js",
	import.meta.resolve("@earendil-works/pi-coding-agent"),
).href;

// Resolving the shipped dist path pins Pi's internal layout. Fail with the
// expected path + fix when Pi reorganizes it, instead of an opaque import error.
async function importInternalLoader(): Promise<InternalLoader> {
	try {
		const mod = (await import(internalUrl)) as Partial<InternalLoader>;
		if (typeof mod.loadExtensionFromFactory !== "function") {
			throw new Error("loadExtensionFromFactory is not exported");
		}
		return mod as InternalLoader;
	} catch (cause) {
		throw new Error(
			`createTestHost could not load pi's internal loader at ${internalUrl}. ` +
			"This host pins Pi's internal dist layout; update tests/unit/test-host.ts for the installed Pi version.",
			{ cause },
		);
	}
}

const { loadExtensionFromFactory } = await importInternalLoader();

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
	appendedEntries: Array<{ customType: string; data: any }>;
	activeTools: string[];
	setCommands(commands: any[]): void;
}

export type TestPI = ExtensionAPI & TestAccessors;

/** Host state seeded before the extension factory runs. */
export interface TestHostSeed {
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
		sendMessage: () => {},
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
	return stampAccessors(api, extension, state);
}
