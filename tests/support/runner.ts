// The runner fixture: loads the extension through pi's resource loader and drives it through one
// pi `ExtensionRunner`. Tests emit events with the runner's own methods, run tools through
// `wrapRegisteredTool` or `runner.createToolContext`, and run commands through `runner.getCommand`
// with `runner.createCommandContext`. Every context member a test did not bind throws when used,
// naming the member, and an error a handler throws rejects the emit that ran it. The extension
// never reads pi's real agent directory through a fixture.

import {
	createSyntheticSourceInfo,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	Theme,
	wrapRegisteredTool,
	type BuildSystemPromptOptions,
	type ExtensionActions,
	type ExtensionCommandContextActions,
	type ExtensionContextActions,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	type ExtensionWidgetOptions,
	type KeybindingsManager,
	type RegisteredTool,
	type ResolvedCommand,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, TuiMainScreen, type Component, type TUI } from "@earendil-works/pi-tui";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { onTestFinished, vi } from "vitest";
import registerSchematic from "../../index.js";
import { AGENT_DIR_ENV_KEY } from "../paths.js";
import { loadExtensions } from "../unit/test-host.js";
import { guardedInstance } from "./guarded.js";

/** The mode `ctx.mode` reports; pi's root entry does not export its name. */
export type ExtensionMode = ExtensionContext["mode"];

/** A `pi.sendMessage` call the fixture recorded. */
export interface SentMessage {
	message: Parameters<ExtensionActions["sendMessage"]>[0];
	options: Parameters<ExtensionActions["sendMessage"]>[1];
}

/** A `pi.sendUserMessage` call the fixture recorded. */
export interface SentUserMessage {
	content: Parameters<ExtensionActions["sendUserMessage"]>[0];
	options: Parameters<ExtensionActions["sendUserMessage"]>[1];
}

/** A `pi.appendEntry` call the fixture recorded. */
export interface AppendedEntry {
	customType: string;
	data: unknown;
}

/** A `ctx.ui.notify` call the fixture recorded. */
export interface Notification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

/** What a `ctx.ui.setWidget` call passed as the widget content. */
export type WidgetContent = string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined;

/** The context members production code reads, under pi's binding names. */
export type ContextBindings = Pick<ExtensionContextActions, "getModel" | "isIdle" | "isProjectTrusted" | "getSignal" | "abort" | "getContextUsage"> & {
	executeTool: NonNullable<ExtensionContextActions["executeTool"]>;
};

/** The host actions a test may bind; the recording actions are always the fixture's own. */
export type ActionBindings = Pick<ExtensionActions, "getAllTools" | "getCommands" | "setModel" | "getThinkingLevel" | "setThinkingLevel">;

/**
 * Runs once a `ctx.ui.custom` component is built, with the component and the TUI it got. The
 * custom call resolves to the value the component passed to its first `done` by the time this
 * returned, and rejects when the component did not call `done` by then.
 */
export type CustomComponentDriver = (component: Component, tui: TUI) => void | Promise<void>;

/** The UI a fixture binds: notifications, statuses and widgets are always recorded. */
export interface UIBindings {
	theme?: Theme;
	custom?: CustomComponentDriver;
	/** The TUI members a `ctx.ui.custom` component may call besides `requestRender`, which the fixture provides. */
	tui?: Partial<Pick<TUI, "stop" | "start">>;
	addAutocompleteProvider?: ExtensionUIContext["addAutocompleteProvider"];
}

export interface RunnerOptions {
	/** The loader's and the context's working directory. */
	cwd: string;
	/** What `ctx.mode` reports, with or without a UI. */
	mode: ExtensionMode;
	/** Partial extension factories in registration order; the shipped extension when omitted. */
	factories?: ExtensionFactory[];
	sessionManager?: SessionManager;
	modelRegistry?: ModelRegistry;
	context?: Partial<ContextBindings>;
	/** Without a UI the fixture is headless: `ctx.hasUI` is false and `ctx.ui` is pi's no-op UI. */
	ui?: UIBindings;
	commandContext?: Partial<ExtensionCommandContextActions>;
	actions?: Partial<ActionBindings>;
	/** The names `pi.getActiveTools()` reports until the extension sets them. */
	activeTools?: string[];
}

/** What the extension sent and appended through the recording host actions. */
export interface HostRecords {
	readonly sentMessages: readonly SentMessage[];
	readonly sentUserMessages: readonly SentUserMessage[];
	readonly appendedEntries: readonly AppendedEntry[];
	/** The names of the latest `pi.setActiveTools` call. */
	readonly activeTools: readonly string[];
}

/** What the extension showed through the recording UI. */
export interface UIRecords {
	readonly notifications: readonly Notification[];
	readonly statuses: ReadonlyMap<string, string | undefined>;
	readonly widgets: ReadonlyMap<string, WidgetContent>;
	/** How often a `ctx.ui.custom` component called `tui.requestRender`. */
	readonly renderRequests: number;
}

export interface RunnerFixture {
	runner: ExtensionRunner;
	host: HostRecords;
	/** Throws for a headless fixture. */
	ui: UIRecords;
	/** The prompt the last `runner.emitBeforeAgentStart` rendered after every handler; throws before the first. */
	readonly systemPrompt: string;
	/** Prompt options for `runner.emitBeforeAgentStart`: the fixture's `cwd` under `options`. */
	systemPromptOptions(options?: Omit<BuildSystemPromptOptions, "cwd">): BuildSystemPromptOptions;
	/** The tool registered as `name`; throws, naming it, when none is. */
	registeredTool(name: string): RegisteredTool;
	/** The registered tool `name`, wrapped as pi wraps it to run with the fixture's tool context. */
	tool(name: string): ReturnType<typeof wrapRegisteredTool>;
	/** The command `name`; throws, naming it, when none is. */
	command(name: string): ResolvedCommand;
}

function unbound(member: string, where: string): Error {
	return new Error(`${member} is not bound in this runner fixture; pass it in the fixture's ${where}.`);
}

function throwing(member: string, where: string): () => never {
	return () => {
		throw unbound(member, where);
	};
}

function isComponent(value: unknown): value is Component {
	return (
		typeof value === "object" && value !== null && typeof Reflect.get(value, "render") === "function" && typeof Reflect.get(value, "invalidate") === "function"
	);
}

// pi's `Component` type declares no `dispose`; pi calls it when a component has one.
function disposeComponent(component: Component): void {
	const dispose: unknown = Reflect.get(component, "dispose");
	if (typeof dispose === "function") {
		Reflect.apply(dispose, component, []);
	}
}

/** A `getAllTools()` entry for `name`, with source info pi would report for a tool from `source`. */
export function toolInfo(name: string, source: string): ToolInfo {
	return {
		name,
		description: `${name} tool`,
		exposure: "direct",
		parameters: Type.Object({}),
		sourceInfo: createSyntheticSourceInfo(`<${source}:${name}>`, { source }),
	};
}

// Theme's public instance fields, which live on the instance rather than the prototype.
const THEME_FIELDS = ["name", "sourcePath", "sourceInfo"];

interface UIState {
	notifications: Notification[];
	statuses: Map<string, string | undefined>;
	widgets: Map<string, WidgetContent>;
	renderRequests: number;
}

function createRecordingUI(bindings: UIBindings, state: UIState): ExtensionUIContext {
	const ui = (member: string) => throwing(`ctx.ui.${member}`, "ui");
	const theme = bindings.theme ?? guardedInstance(Theme.prototype, {}, THEME_FIELDS, (member) => unbound(`ctx.ui.theme.${member}`, "ui.theme"));
	const tui = guardedInstance<TUI>(
		TuiMainScreen.prototype,
		{
			...bindings.tui,
			requestRender: () => {
				state.renderRequests++;
			},
		},
		["mode", "terminal", "onDebug", "children", "fullRedraws"],
		(member) =>
			member === "stop" || member === "start"
				? unbound(`tui.${member}`, "ui.tui")
				: new Error(`tui.${member} is not available to a custom component in this runner fixture; only requestRender, stop and start are.`),
	);
	const driver = bindings.custom;
	return {
		select: ui("select"),
		confirm: ui("confirm"),
		input: ui("input"),
		notify: (message, type) => {
			state.notifications.push({ message, type });
		},
		onTerminalInput: ui("onTerminalInput"),
		setStatus: (key, text) => {
			state.statuses.set(key, text);
		},
		setWorkingMessage: ui("setWorkingMessage"),
		setWorkingVisible: ui("setWorkingVisible"),
		setWorkingIndicator: ui("setWorkingIndicator"),
		setHiddenThinkingLabel: ui("setHiddenThinkingLabel"),
		setWidget: (key: string, content: WidgetContent, _options?: ExtensionWidgetOptions) => {
			state.widgets.set(key, content);
		},
		setFooter: ui("setFooter"),
		setHeader: ui("setHeader"),
		setTitle: ui("setTitle"),
		async custom<T>(
			factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>,
		): Promise<T> {
			if (driver === undefined) {
				throw unbound("ctx.ui.custom", "ui.custom");
			}
			const results: T[] = [];
			let built: Component | undefined;
			let disposed = false;
			const disposeOnce = (component: Component): void => {
				if (!disposed) {
					disposed = true;
					disposeComponent(component);
				}
			};
			// A `done` the factory calls before it returns finds no component yet, and the component is
			// then never disposed: pi's own host does not dispose it in that case either.
			const done = (result: T): void => {
				results.push(result);
				if (results.length === 1 && built !== undefined) {
					disposeOnce(built);
				}
			};
			// The factory's type names pi-coding-agent's KeybindingsManager, a subclass the package root
			// exports only as a type. The fixture passes pi-tui's global manager, which components read
			// their keys from, so the call goes through Reflect.apply and the result is checked.
			const component: unknown = await Reflect.apply(factory, undefined, [tui, theme, getKeybindings(), done]);
			if (!isComponent(component)) {
				throw new Error("The custom factory did not build a component with render and invalidate methods.");
			}
			built = component;
			try {
				await driver(component, tui);
			} catch (error) {
				// A driver that fails (a failed assertion) before the component called done still
				// disposes it, and the test sees the driver's error.
				if (results.length === 0) {
					try {
						disposeOnce(component);
					} catch {
						// The test already fails with the driver's error; a dispose error must not replace it.
					}
				}
				throw error;
			}
			if (results.length === 0) {
				disposeOnce(component);
				throw new Error("The custom component did not call done.");
			}
			return results[0];
		},
		pasteToEditor: ui("pasteToEditor"),
		setEditorText: ui("setEditorText"),
		getEditorText: ui("getEditorText"),
		editor: ui("editor"),
		addAutocompleteProvider: bindings.addAutocompleteProvider ?? ui("addAutocompleteProvider"),
		setEditorComponent: ui("setEditorComponent"),
		getEditorComponent: ui("getEditorComponent"),
		theme,
		getAllThemes: ui("getAllThemes"),
		getTheme: ui("getTheme"),
		setTheme: ui("setTheme"),
		getToolsExpanded: ui("getToolsExpanded"),
		setToolsExpanded: ui("setToolsExpanded"),
	};
}

// pi's agent directory variable as this test file's process started with it. The extension reads
// files under pi's agent directory, which pi places under HOME when the variable is unset or empty.
// A fixture built while the variable is unset, empty or still holds this value gets a temp
// directory of its own for the test; any other value is one the test set itself
// (`withTempAgentDir` or `vi.stubEnv`), and the fixture keeps it.
const STARTING_AGENT_DIR = process.env[AGENT_DIR_ENV_KEY];

/**
 * Load the extension (the shipped `index.ts` default export, or `options.factories`) and build one
 * pi `ExtensionRunner` over it with the bindings in `options`. `cwd`, `sessionManager` and
 * `modelRegistry` are fixed here; a test that needs another builds another fixture. Call it inside a
 * test: the agent directory it may set up lasts until that test finishes.
 */
export async function createRunner(options: RunnerOptions): Promise<RunnerFixture> {
	const currentAgentDir = process.env[AGENT_DIR_ENV_KEY];
	if (currentAgentDir === undefined || currentAgentDir === "" || currentAgentDir === STARTING_AGENT_DIR) {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-schematic-runner-agent-"));
		onTestFinished(() => rm(agentDir, { recursive: true, force: true }));
		vi.stubEnv(AGENT_DIR_ENV_KEY, agentDir);
	}
	let observedPrompt: string | undefined;
	// Loaded last, so it sees the prompt every earlier handler shaped.
	const observer: ExtensionFactory = (api) => {
		api.on("before_agent_start", (event) => {
			observedPrompt = event.systemPrompt;
		});
	};
	const { extensions, runtime } = await loadExtensions([...(options.factories ?? [registerSchematic]), observer], options.cwd);
	const sessionManager =
		options.sessionManager ?? guardedInstance(SessionManager.prototype, {}, [], (member) => unbound(`ctx.sessionManager.${member}`, "sessionManager"));
	const modelRegistry =
		options.modelRegistry ?? guardedInstance(ModelRegistry.prototype, {}, [], (member) => unbound(`ctx.modelRegistry.${member}`, "modelRegistry"));
	const runner = new ExtensionRunner(extensions, runtime, options.cwd, sessionManager, modelRegistry);
	// pi reports a handler's error to its listeners and carries on; rethrowing rejects the emit.
	runner.onError((error) => {
		const failure = new Error(error.error, { cause: error });
		if (error.stack !== undefined) {
			failure.stack = error.stack;
		}
		throw failure;
	});

	const sentMessages: SentMessage[] = [];
	const sentUserMessages: SentUserMessage[] = [];
	const appendedEntries: AppendedEntry[] = [];
	let activeTools = options.activeTools;
	const action = (member: string) => throwing(`pi.${member}`, "actions");
	const actions = options.actions ?? {};
	runner.bindCore(
		{
			sendMessage: (message, sendOptions) => {
				sentMessages.push({ message, options: sendOptions });
			},
			sendUserMessage: (content, sendOptions) => {
				sentUserMessages.push({ content, options: sendOptions });
			},
			appendEntry: (customType, data) => {
				appendedEntries.push({ customType, data });
			},
			getActiveTools: () => {
				if (activeTools === undefined) {
					throw unbound("pi.getActiveTools", "activeTools");
				}
				return [...activeTools];
			},
			setActiveTools: (names) => {
				activeTools = [...names];
			},
			setSessionName: action("setSessionName"),
			getSessionName: action("getSessionName"),
			setLabel: action("setLabel"),
			getSettings: action("getSettings"),
			refreshTools: action("refreshTools"),
			getAllTools: actions.getAllTools ?? action("getAllTools"),
			getCommands: actions.getCommands ?? action("getCommands"),
			setModel: actions.setModel ?? action("setModel"),
			getThinkingLevel: actions.getThinkingLevel ?? action("getThinkingLevel"),
			setThinkingLevel: actions.setThinkingLevel ?? action("setThinkingLevel"),
		},
		{
			getModel: options.context?.getModel ?? throwing("ctx.model", "context.getModel"),
			getScopedModels: throwing("ctx.scopedModels", "context"),
			isIdle: options.context?.isIdle ?? throwing("ctx.isIdle", "context"),
			isProjectTrusted: options.context?.isProjectTrusted ?? throwing("ctx.isProjectTrusted", "context"),
			getSignal: options.context?.getSignal ?? throwing("ctx.signal", "context.getSignal"),
			abort: options.context?.abort ?? throwing("ctx.abort", "context"),
			hasPendingMessages: throwing("ctx.hasPendingMessages", "context"),
			shutdown: throwing("ctx.shutdown", "context"),
			getContextUsage: options.context?.getContextUsage ?? throwing("ctx.getContextUsage", "context"),
			compact: throwing("ctx.compact", "context"),
			getSystemPrompt: throwing("ctx.getSystemPrompt", "context"),
			getSystemPromptOptions: throwing("ctx.getSystemPromptOptions", "context"),
			executeTool: options.context?.executeTool ?? throwing("ctx.executeTool", "context"),
			getCallableTools: throwing("ctx.tools", "context"),
		},
	);
	const command = (member: string) => throwing(`ctx.${member}`, "commandContext");
	runner.bindCommandContext({
		waitForIdle: options.commandContext?.waitForIdle ?? command("waitForIdle"),
		newSession: options.commandContext?.newSession ?? command("newSession"),
		fork: options.commandContext?.fork ?? command("fork"),
		navigateTree: options.commandContext?.navigateTree ?? command("navigateTree"),
		switchSession: options.commandContext?.switchSession ?? command("switchSession"),
		reload: options.commandContext?.reload ?? command("reload"),
	});

	const uiState: UIState = { notifications: [], statuses: new Map(), widgets: new Map(), renderRequests: 0 };
	const uiBindings = options.ui;
	runner.setUIContext(uiBindings === undefined ? undefined : createRecordingUI(uiBindings, uiState), options.mode);

	const registeredTool = (name: string): RegisteredTool => {
		const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === name);
		if (registered === undefined) {
			throw new Error(`No tool "${name}" is registered in the runner fixture.`);
		}
		return registered;
	};
	return {
		runner,
		host: {
			sentMessages,
			sentUserMessages,
			appendedEntries,
			get activeTools() {
				if (activeTools === undefined) {
					throw new Error("The extension set no active tools and the fixture was given none.");
				}
				return activeTools;
			},
		},
		get ui(): UIRecords {
			if (uiBindings === undefined) {
				throw new Error("This runner fixture is headless; pass ui to record notifications, statuses and widgets.");
			}
			return uiState;
		},
		get systemPrompt() {
			if (observedPrompt === undefined) {
				throw new Error("No before_agent_start run reached the fixture's prompt observer.");
			}
			return observedPrompt;
		},
		systemPromptOptions: (promptOptions = {}) => ({ ...promptOptions, cwd: options.cwd }),
		registeredTool,
		tool: (name) => wrapRegisteredTool(registeredTool(name), runner),
		command: (name) => {
			const resolved = runner.getCommand(name);
			if (resolved === undefined) {
				throw new Error(`No command "${name}" is registered in the runner fixture.`);
			}
			return resolved;
		},
	};
}
