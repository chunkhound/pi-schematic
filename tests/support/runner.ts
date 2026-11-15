// The runner fixture: loads the extension through pi's resource loader and drives it through one
// pi `ExtensionRunner`. Tests emit events with the runner's own methods, run tools through
// `wrapRegisteredTool` or `runner.createToolContext`, and run commands through `runner.getCommand`
// with `runner.createCommandContext`. Every context member a test did not bind throws when used,
// naming the member, and an error a handler throws rejects the emit that ran it. The extension
// never reads pi's real agent directory through a fixture.

import {
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	Theme,
	wrapRegisteredTool,
	type BuildSystemPromptOptions,
	type Extension,
	type ExtensionActions,
	type ExtensionCommandContextActions,
	type ExtensionContextActions,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionRuntime,
	type ExtensionUIContext,
	type ExtensionWidgetOptions,
	type KeybindingsManager,
	type RegisteredTool,
	type ResolvedCommand,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, TuiMainScreen, type Component, type TUI } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { onTestFinished } from "vitest";
import registerSchematic from "../../index.js";
import { AGENT_DIR_ENV_KEY } from "../paths.js";
import { guardedUIContext } from "./ui-context.js";
import { guardedInstance } from "./guarded.js";

let loaderAgentDir: string | undefined;

// One empty agent directory per process for the loader: pi requires one, and a fresh path keeps
// the real agent directory out of the load. Removed at exit; a run killed by a signal leaves it
// behind.
function testAgentDir(): string {
	if (loaderAgentDir === undefined) {
		const dir = mkdtempSync(join(tmpdir(), "pi-schematic-test-agent-"));
		process.once("exit", () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// A throw here would fail a run whose tests passed; a directory left behind costs nothing.
			}
		});
		loaderAgentDir = dir;
	}
	return loaderAgentDir;
}

/**
 * Load `factories` through pi's `DefaultResourceLoader` as inline extensions, with `cwd` as the
 * loader's working directory, an untrusted project, a process-wide temp agent directory and
 * in-memory settings, so no installed or project resource loads. No host action is bound: the
 * runtime's actions stay as pi's loader left them, and most throw pi's "Extension runtime not
 * initialized" error until a caller binds them. `extensions[i]` belongs to `factories[i]`; the
 * pairing relies on pi loading inline factories one after another, in order, and the count check
 * below guards that pairing: it catches pi loading an extra discovered extension or dropping one.
 * Throws one error listing the load errors, each starting a new line as `path: error`.
 */
async function loadExtensions(factories: ExtensionFactory[], cwd: string): Promise<{ extensions: Extension[]; runtime: ExtensionRuntime }> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: testAgentDir(),
		// An untrusted project keeps pi from scanning `<cwd>/.pi` and ancestor `.agents/skills` directories.
		settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
		extensionFactories: factories,
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
		throw new Error(`pi loaded ${extensions.length} extensions for ${factories.length} factories: ${extensions.map((e) => e.path).join(", ")}.`);
	}
	return { extensions, runtime };
}

/** The mode `ctx.mode` reports; pi's root entry does not export its name. */
type ExtensionMode = ExtensionContext["mode"];

/** A `pi.sendMessage` call the fixture recorded. */
interface SentMessage {
	message: Parameters<ExtensionActions["sendMessage"]>[0];
	options: Parameters<ExtensionActions["sendMessage"]>[1];
}

/** A `pi.sendUserMessage` call the fixture recorded. */
interface SentUserMessage {
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
type WidgetContent = string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined;

/** The context members production code reads, under pi's binding names. */
type ContextBindings = Pick<ExtensionContextActions, "getModel" | "isIdle" | "isProjectTrusted" | "getSignal" | "abort" | "getContextUsage"> & {
	executeTool: NonNullable<ExtensionContextActions["executeTool"]>;
};

/** The host actions a test may bind; the recording actions are always the fixture's own. */
type ActionBindings = Pick<ExtensionActions, "getAllTools" | "getCommands" | "setModel" | "getThinkingLevel" | "setThinkingLevel">;

/**
 * Runs once a `ctx.ui.custom` component is built, with the component and the TUI it got. The
 * custom call resolves to the value the component passed to its first `done` by the time this
 * returned, and rejects when the component did not call `done` by then.
 */
export type CustomComponentDriver = (component: Component, tui: TUI) => void | Promise<void>;

/** The UI a fixture binds: notifications, statuses and widgets are always recorded. */
interface UIBindings {
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
	/**
	 * An absolute path the fixture points pi's agent directory variable at for the rest of the test,
	 * for a test that put files there. Without it the fixture creates a temp directory of its own
	 * and removes it when the test finishes.
	 */
	agentDir?: string;
}

/** What the extension sent and appended through the recording host actions. */
interface HostRecords {
	readonly sentMessages: readonly SentMessage[];
	readonly sentUserMessages: readonly SentUserMessage[];
	readonly appendedEntries: readonly AppendedEntry[];
	/** The names of the latest `pi.setActiveTools` call. */
	readonly activeTools: readonly string[];
}

/** What the extension showed through the recording UI. */
interface UIRecords {
	readonly notifications: readonly Notification[];
	readonly statuses: ReadonlyMap<string, string | undefined>;
	readonly widgets: ReadonlyMap<string, WidgetContent>;
	/** The `force` argument of each `tui.requestRender` call a `ctx.ui.custom` component made, in call order. */
	readonly renderRequests: readonly (boolean | undefined)[];
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

// pi's `Component` type declares no `dispose`; pi calls it when a component has one. An error it
// throws is ignored, as pi's own host ignores it, so the custom call ends with the result, the
// driver's error or the "did not call done" error.
function disposeComponent(component: Component): void {
	try {
		const dispose: unknown = Reflect.get(component, "dispose");
		if (typeof dispose === "function") {
			Reflect.apply(dispose, component, []);
		}
	} catch {
		// pi's host ignores dispose errors.
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
	renderRequests: (boolean | undefined)[];
}

function createRecordingUI(bindings: UIBindings, state: UIState): ExtensionUIContext {
	const theme = bindings.theme ?? guardedInstance(Theme.prototype, {}, THEME_FIELDS, (member) => unbound(`ctx.ui.theme.${member}`, "ui.theme"));
	const tui = guardedInstance<TUI>(
		TuiMainScreen.prototype,
		{
			...bindings.tui,
			requestRender: (force?: boolean) => {
				state.renderRequests.push(force);
			},
		},
		["mode", "terminal", "onDebug", "children", "fullRedraws"],
		(member) =>
			member === "stop" || member === "start"
				? unbound(`tui.${member}`, "ui.tui")
				: new Error(`tui.${member} is not available to a custom component in this runner fixture; only requestRender, stop and start are.`),
	);
	const driver = bindings.custom;
	return guardedUIContext(
		{
			notify: (message, type) => {
				state.notifications.push({ message, type });
			},
			setStatus: (key, text) => {
				state.statuses.set(key, text);
			},
			setWidget: (key: string, content: WidgetContent, _options?: ExtensionWidgetOptions) => {
				state.widgets.set(key, content);
			},
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
				let closeInFactory: () => void = () => undefined;
				const closedInFactory = new Promise<undefined>((resolve) => {
					closeInFactory = () => {
						resolve(undefined);
					};
				});
				const done = (result: T): void => {
					results.push(result);
					if (results.length === 1) {
						if (built === undefined) {
							closeInFactory();
						} else {
							disposeOnce(built);
						}
					}
				};
				// The factory's type names pi-coding-agent's KeybindingsManager, a subclass the package root
				// exports only as a type. The fixture passes pi-tui's global manager, which components read
				// their keys from, so the call goes through Reflect.apply and the result is checked.
				// A synchronous throw rejects factoryRun, as it rejects pi's host promise.
				let returned: unknown;
				const factoryRun = new Promise<unknown>((resolve) => {
					returned = Reflect.apply(factory, undefined, [tui, theme, getKeybindings(), done]);
					resolve(returned);
				});
				// pi's host takes the component in a `then` on `Promise.resolve` of what the factory returned,
				// and from that turn on `done` disposes it. The fixture marks the component built in the same
				// turn, so `done` disposes it for the same timings. A rejection reaches the call through
				// factoryRun.
				void Promise.resolve(returned).then(
					(value) => {
						if (results.length === 0 && isComponent(value)) {
							built = value;
						}
					},
					() => undefined,
				);
				// Like pi's host: once `done` fired inside the factory, the call resolves with its value at
				// once, and what the factory still returns or throws is neither driven, disposed nor reported.
				factoryRun.catch(() => undefined);
				let component: unknown;
				try {
					component = await Promise.race([factoryRun, closedInFactory]);
				} catch (error) {
					if (results.length === 0) {
						throw error;
					}
				}
				if (results.length > 0) {
					return results[0];
				}
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
						disposeOnce(component);
					}
					throw error;
				}
				if (results.length === 0) {
					disposeOnce(component);
					throw new Error("The custom component did not call done.");
				}
				return results[0];
			},
			...(bindings.addAutocompleteProvider === undefined ? {} : { addAutocompleteProvider: bindings.addAutocompleteProvider }),
			theme,
		},
		(member) => unbound(`ctx.ui.${member}`, "ui"),
	);
}

/**
 * Load the extension (the shipped `index.ts` default export, or `options.factories`) and build one
 * pi `ExtensionRunner` over it with the bindings in `options`. `cwd`, `sessionManager` and
 * `modelRegistry` are fixed here; a test that needs another builds another fixture. Call it inside a
 * test: the agent directory it sets up lasts until that test finishes.
 */
export async function createRunner(options: RunnerOptions): Promise<RunnerFixture> {
	if (options.agentDir !== undefined && !isAbsolute(options.agentDir)) {
		throw new Error(`The runner fixture's agentDir must be an absolute path, got ${JSON.stringify(options.agentDir)}.`);
	}
	// Registered before the variable or any directory changes, so a fixture built outside a test
	// fails here and leaves nothing behind. Vitest runs test-finished callbacks in reverse order of
	// registration, so with two fixtures in one test the one built last restores first and the
	// variable ends at the value it had before the first. The variable is put back before the
	// directory is removed, and only while it still holds this fixture's value: a test that
	// restored it itself, or an earlier cleanup, keeps what it set.
	let createdAgentDir: string | undefined;
	let assignedAgentDir: string | undefined;
	let previousAgentDir: string | undefined;
	try {
		onTestFinished(async () => {
			if (assignedAgentDir !== undefined && process.env[AGENT_DIR_ENV_KEY] === assignedAgentDir) {
				if (previousAgentDir === undefined) {
					Reflect.deleteProperty(process.env, AGENT_DIR_ENV_KEY);
				} else {
					process.env[AGENT_DIR_ENV_KEY] = previousAgentDir;
				}
			}
			if (createdAgentDir !== undefined) {
				await rm(createdAgentDir, { recursive: true, force: true });
			}
		});
	} catch (error) {
		throw new Error("A runner fixture must be built inside a test, not in beforeAll or at module scope: its agent directory lasts until the test finishes.", {
			cause: error,
		});
	}
	// The extension reads files under pi's agent directory, which pi places under HOME when the
	// variable is unset or empty, so every fixture sets it. The extension reads the variable when it
	// resolves its files: with two fixtures in one test it holds the directory of the one built last,
	// so tests that need two live fixtures with different directories pass each its `agentDir` and
	// build them in the order they emit. The variable is assigned directly, not through
	// `vi.stubEnv`, which would reinstate a value a test restored itself when the next test starts.
	// Read before the first await, so fixtures built concurrently all remember the value from before any.
	previousAgentDir = process.env[AGENT_DIR_ENV_KEY];
	if (options.agentDir === undefined) {
		createdAgentDir = await mkdtemp(join(tmpdir(), "pi-schematic-runner-agent-"));
	}
	assignedAgentDir = options.agentDir ?? createdAgentDir;
	process.env[AGENT_DIR_ENV_KEY] = assignedAgentDir;
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

	const uiState: UIState = { notifications: [], statuses: new Map(), widgets: new Map(), renderRequests: [] };
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
