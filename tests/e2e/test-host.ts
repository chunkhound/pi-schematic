/**
 * test-host.ts — Minimal pi host for process-isolated E2E tests.
 *
 * Spawned as a child process. Loads the extension, then runs a
 * line-oriented REPL on stdin/stdout.
 *
 * Protocol:
 *   → cmd <name> [arg]      — call a registered command
 *   → cmd-bg <name> [arg]  — start a command; reply before the handler settles
 *   → cmd-wait             — await the background command's outcome
 *   → input <text>         — dispatch pi's real input hook (source "interactive"), print the action
 *   → input-ext <text>     — dispatch pi's real input hook (source "extension")
 *   → hold-exec / release-exec — park a run inside its shell call; a blocked call emits EXEC-HELD
 *   → hold-turn / release-turn — park a `workflow.run` turn before its assistant entry lands
 *   → turn-end <outcome>     — dispatch pi's turn_end event (outcome: completed|aborted|error)
 *   → workflow-mocks — opt in to the workflow-suite fakes (deterministic pi.exec shell,
 *     ui.select/input/confirm stubs); default is no fake exec and throwing picker stubs
 *   → tool <name> <json>    — call a registered tool with JSON params
 *   → toolcall <name> <json> — run the first tool_call hook directly
 *   → context [json]        — run the first context hook
 *   → usage <json|null>     — set getContextUsage() result for later calls
 *   → ui / headless         — select UI mode for subsequent calls
 *   → tui                   — set ctx.mode to "tui" and capture terminal-input
 *                             subscriptions (workflow cancellation only arms in tui)
 *   → key <escape|ctrl+c>   — dispatch a captured terminal-input press; the handler's
 *                             { consume } verdict is echoed so a test can pin who ate the keypress
 *   → key-raw <json>       — dispatch arbitrary terminal data (Kitty press/repeat/release)
 *   → mode <tui|rpc|non-interactive> — set ctx.mode (hasUI unchanged)
 *   → cwd <path>           — set ctx.cwd so bare workflow-name discovery lists a temp project
 *   → terminal             — whether a terminal-input listener is registered
 *   → widgets              — current setWidget keys
 *   → shell-delay <ms>     — fake shell awaits this long before returning (elapsed-budget crossing)
 *   → flag-empty <name>    — set an extension flag to "" (as the CLI can)
 *   → ui-events             — return current status values and emitted notifications
 *   → compact-success       — run queued handoff compaction success path
 *   → compact-fail [message] — run queued handoff compaction failure path
 *   → successor-turn        — drain a queued follow-up into the successor context hook
 *   → user-turn <text>      — persist a newer user message without draining a follow-up
 *   → session-tree          — fire a tree-navigation event without changing the active branch
 *   → tree-edit-last-user   — open the latest user turn for editing and move the active branch to its parent
 *   → agent-end             — run the first agent_end handler
 *   → agent-settled         — run the first agent_settled handler
 *   → drop-follow-up        — discard one queued follow-up without persisting it (simulated delivery loss)
 *   → successor-count       — count sent messages starting with "## Next instruction"
 *   → sent-messages         — return extension-sent user messages
 *   → flag <name> <value>    — seed an extension flag value (as the CLI would)
 *   → spent <usd>            — append a usage entry so session cost is non-zero
 *   → mock-select [value]    — queue one `ctx.ui.select` answer; empty queue falls back to "No target"
 *   → mock-input [value]     — queue one `ctx.ui.input` answer; empty queue falls back to ""
 *   → turn <json>            — queue one scripted `workflow.run` turn ({text,cost,stopReason,provider,model,output,toolResults})
 *   → fault append-throws [n] [skip] | send-throws [n] | progress-throws [n] | shell <result|throws|error>
 *            | abort-throws | model-restore | thinking-restore | thinking-throws [n]
 *   → readonly <on|off>      — set the readonly posture through branch rehydration
 *   → sandbox <mode>         — install a sandbox seam: real|no-deadline|aborted|timeout|oom|factory-error|execute-throws|close-throws
 *   → sandbox-options       — the CodemodeSandboxOptions last handed to the sandbox factory (null)
 *   → footer                — render the installed footer's first line (null when none)
 *   → mock-model [json]     — seed the run's current model + getModelOfType result ({current,resolve})
 *   → model-calls           — captured setModel/setThinkingLevel sequences + current model/thinking
 *   → mock-commands <json>  — seed pi.getCommands() (the run-target catalogue)
 *   → seed-entry <json>     — append a raw branch entry before a run: assistant/toolResult usage
 *   → mock-classify <json>  — seed classifier models + the classify result ({models,result})
 *   → new-session <mode>    — control workflow.new: normal|cancel|fail|clear (clear empties the branch)
 *   → new-session-publish <on|off> — suppress the replacement session_start so no runtime is published
 *   → new-session-delay <ms> — hold the replacement window open after session_start
 *   → stale-on-new-session <on|off> — the replaced ctx throws on any later property access
 *   → active-tools          — list pi's active tool names
 *   → tools                 — list registered tool names
 *   → cmds                  — list registered command names
 *   → exit                  — graceful shutdown
 *
 *   ← READY\n               — sent after extension registration
 *   ← OK[:payload]\n        — success
 *   ← ERR:message\n         — failure
 */

import { createInterface } from "node:readline";
import { ExtensionRunner, createExtensionRuntime, type Extension, type InputSource } from "@earendil-works/pi-coding-agent";
import { CodemodeSandbox, type CodemodeResult, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import { createTestHost } from "../unit/test-host.js";
import { setShellRunForTests, type ShellToolResult } from "../../workflow/shell.js";
import { setSandboxFactoryForTests } from "../../workflow/sandbox.js";

// ── Real extension host ───────────────────────────────────────────
// Loads the extension through pi's real loader so the host exercises the same
// ExtensionAPI the runtime provides. No TUI dependencies — tools and commands
// access the state through the pi object directly.

const pi = await createTestHost();
// Capture the maps after registration: `pi.tools` is derived from the loaded
// Extension's registered tools.
const commands = pi.commands;
const tools = pi.tools;
// Capture the override call sequence: a run must apply the explicit model/thinking for the
// turn and restore the previous pair afterwards. Pi exposes these as writable api methods.
const originalSetModel = pi.setModel.bind(pi);
pi.setModel = async (model: unknown) => {
	modelCalls.push(model);
	if (modelRestoreThrows && model === mockCtx.model) throw new Error("e2e model restore failed");
	return originalSetModel(model as never);
};
const initialThinkingLevel = pi.getThinkingLevel();
const originalSetThinkingLevel = pi.setThinkingLevel.bind(pi);
pi.setThinkingLevel = (level: Parameters<typeof originalSetThinkingLevel>[0]) => {
	thinkingCalls.push(level);
	if (thinkingThrows > 0) {
		thinkingThrows -= 1;
		throw new Error("e2e thinking failed");
	}
	if (thinkingRestoreThrows && level === initialThinkingLevel) throw new Error("e2e thinking restore failed");
	originalSetThinkingLevel(level);
};

// ── Mock ExtensionContext for tool/command execution ──────────────

type MockContextUsage = { tokens?: number | null; percent?: number | null; contextWindow?: number | null } | null;
type CompactRequest = { onComplete?: () => void; onError?: (error: Error) => void };

/** One scripted `workflow.run` reply, consumed in queue order by scriptTurn. */
interface ScriptedTurn {
	text?: string;
	cost?: number;
	stopReason?: string;
	/** Recorded on the assistant entry so a run's model attribution is observable. */
	provider?: string;
	model?: string;
	/** When present, the host executes the armed workflow_output tool with this value. */
	output?: unknown;
	/** Tool-result entries appended between the user and assistant turns (spawned-child usage). */
	toolResults?: Array<{ toolName?: string; cost?: number; text?: string }>;
	/** Multiple assistant entries (a tool-use loop) with per-entry usage; overrides `text`/`cost`/`stopReason`. */
	assistants?: Array<{ text?: string; cost?: number; stopReason?: string; provider?: string; model?: string }>;
	/** Fire `agent_settled` this many times before the assistant entry lands (correlation must wait). */
	prematureSettles?: number;
}

let currentUsage: MockContextUsage = null;
let lastCompactRequest: CompactRequest | null = null;
// Run control: a held exec gates workflow.shell (hold-exec/release-exec); the background
// command promise is reported later by cmd-wait, after its side effects settle.
let execGate: Promise<void> | null = null;
let execOpened: (() => void) | null = null;
// A held turn parks a scripted `workflow.run` before its assistant entry/settle lands, so a
// test can fire turn_end while the run awaits the turn.
let turnGate: Promise<void> | null = null;
let turnOpened: (() => void) | null = null;
let backgroundCommand: Promise<void> | null = null;
// Fault injection: remaining throw counts per seam plus the shell outcome mode.
const faults = { append: 0, appendSkip: 0, send: 0, progress: 0, shell: "ok" as "ok" | "throws" | "error" };
// Model-override seeding/capture: the run's override contract is graded from the call sequence.
let resolvedModel: unknown = undefined;
const modelCalls: unknown[] = [];
const thinkingCalls: string[] = [];
// Classifier control for `workflow.classify`.
let classifierModels: unknown[] = [];
let classifyResult: unknown = null;
// newSession outcome control for workflow.new cost tests.
let newSessionMode: "normal" | "cancel" | "fail" | "clear" = "normal";
// Replacement-window control: publish suppression, an open window, and a stale old ctx.
let newSessionPublish = true;
let newSessionDelayMs = 0;
let staleOnNewSession = false;
// True once the replaced ctx is invalid: any later read through the command ctx proxy throws.
let ctxStale = false;
let abortThrows = false;
// Fake shell dwell time so a workflow can cross a soft time target before its checkpoint.
let shellDelayMs = 0;
// setWidget keys, so headless runs can prove they paint no widgets.
const widgets = new Set<string>();
// Restore/apply fault injection for the run override contract.
let modelRestoreThrows = false;
let thinkingRestoreThrows = false;
let thinkingThrows = 0;
// Boxed so TS control-flow does not narrow the closure-assigned value to null at the read site.
const sandboxCapture: { options: CodemodeSandboxOptions | null } = { options: null };
// Picker answers consumed in order (empty queue uses the suite defaults); scripted run turns.
const pickerSelect: Array<string | undefined> = [];
const pickerInput: Array<string | undefined> = [];
const scriptedTurns: ScriptedTurn[] = [];
let footer: unknown = null;
let workflowMocksEnabled = false;
const queuedFollowUps: string[] = [];
const statuses = new Map<string, string | undefined>();
const notifications: Array<{ message: string; level: string }> = [];
// `branch` models the active path while `entries` preserves the session history.
// Pi moves a selected user turn into the editor by moving the active leaf to its
// parent, but the delivered turn remains in session history as recovery evidence.
const branch: any[] = [];
const entries: any[] = [];
let entrySeq = 0;

function appendEntry(entry: any): void {
	// Mirror pi: each entry is a child of the current leaf, and the leaf advances.
	entry.parentId = branch.at(-1)?.id ?? null;
	branch.push(entry);
	entries.push(entry);
}

// Model Pi's follow-up queue centrally: every extension send with
// deliverAs "followUp" waits here until a run drains it. Recovery sends must
// queue too, so the override cannot live inside a single REPL command.
// A run dispatch (expandPromptTemplates) settles through the next scripted turn:
// the real agent loop's only observable edges are the appended branch entries and
// the agent_settled boundary, so the turn reproduces exactly those.
const originalSendUserMessage = pi.sendUserMessage;
pi.sendUserMessage = (content: any, options?: any) => {
	if (faults.send > 0) {
		faults.send -= 1;
		throw new Error("e2e send fault");
	}
	originalSendUserMessage.call(pi, content, options);
	const text = typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("\n");
	if (options?.deliverAs === "followUp") {
		queuedFollowUps.push(text);
		return;
	}
	if (options?.expandPromptTemplates) return scriptTurn(text);
};
// A faulted append must be visible: production's safeAppendEntry paths rely on the throw.
const originalAppendEntry = pi.appendEntry;
pi.appendEntry = (customType: string, data?: unknown) => {
	// appendSkip lets the first appends of a run land, so a later append can be the one that fails.
	if (faults.appendSkip > 0) faults.appendSkip -= 1;
	else if (faults.append > 0) {
		faults.append -= 1;
		throw new Error("e2e append fault");
	}
	originalAppendEntry.call(pi, customType, data);
};
// Deterministic shell for /workflow workflows: NO real process is spawned in E2E.
// The process-isolated host cannot inject host deps, so it uses the shell module's
// test seam. A held gate parks the run mid-flight so tests can dispatch input while
// it is live (the workflow now runs through pi's bash tool, not `pi.exec`).
function enableWorkflowMocks(): void {
	if (workflowMocksEnabled) return; // idempotent
	workflowMocksEnabled = true;
	setShellRunForTests(async () => {
		if (execGate) {
			process.stdout.write("EXEC-HELD\n"); // unsolicited marker: the run is now provably mid-flight
			await execGate;
		}
		if (shellDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, shellDelayMs));
		if (faults.shell === "throws") throw new Error("e2e shell fault");
		if (faults.shell === "error") {
			return {
				content: [{ type: "text", text: "fault-output\n" }],
				isError: true,
				structuredContent: { output: "fault-output\n", truncated: false, exit_code: 3, wall_time_seconds: 0 },
			} satisfies ShellToolResult;
		}
		return {
			content: [{ type: "text", text: "smoke-ok\n" }],
			isError: false,
			structuredContent: { output: "smoke-ok\n", truncated: false, exit_code: 0, wall_time_seconds: 0 },
		} satisfies ShellToolResult;
	});
	mockCtx.ui.select = () => Promise.resolve(pickerSelect.length ? pickerSelect.shift() : "No target");
	mockCtx.ui.input = () => Promise.resolve(pickerInput.length ? pickerInput.shift() : "");
	mockCtx.ui.confirm = () => Promise.resolve(false);
}
// WHY throwing picker stubs before `workflow-mocks`: a workflow command run without the
// opt-in must fail loudly, never silently consume a fake picker. onTerminalInput stays a
// generic noop: subscribing a dead listener is inert and never masks behavior.

// ── Scripted turns (deterministic agent boundary) ─────────────────

function appendMessage(message: Record<string, unknown>): void {
	appendEntry({ type: "message", id: `message-${++entrySeq}`, message });
}

/** Session-shape usage for the given USD total; branchSpend reads only cost.total. */
function usageOf(cost: number): Record<string, unknown> {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

/** Append one raw branch entry so a run starts with pre-existing spend or a model-attributed turn. */
function seedBranchEntry(spec: any): void {
	const id = spec.id ?? `message-${++entrySeq}`;
	const usage = spec.cost !== undefined ? usageOf(spec.cost) : undefined;
	let message: Record<string, unknown> | null = null;
	if (spec.role === "assistant") {
		message = { role: "assistant", provider: spec.provider, model: spec.model, content: [{ type: "text", text: spec.text ?? "seed" }], timestamp: Date.now(), ...(usage ? { usage } : {}) };
	} else if (spec.role === "toolResult") {
		message = { role: "toolResult", toolName: spec.toolName ?? "spawn", toolCallId: spec.toolCallId, content: spec.text ?? "child", timestamp: Date.now(), ...(usage ? { usage } : {}), ...(spec.details ? { details: spec.details } : {}) };
	} else if (spec.role === "user") {
		message = { role: "user", content: spec.text ?? "seed", timestamp: Date.now() };
	}
	if (message) {
		appendEntry({ type: "message", id, message });
		return;
	}
	if (spec.type === "usage") appendEntry({ type: "usage", id, usage: usageOf(spec.cost ?? 0) });
}

/** Settle one `workflow.run` dispatch from the next queued turn; the default is a plain reply. */
async function scriptTurn(promptText: string): Promise<void> {
	appendMessage({ role: "user", content: promptText, timestamp: Date.now() });
	// Hold before the assistant entry: the run is provably awaiting this turn.
	if (turnGate) {
		process.stdout.write("TURN-HELD\n");
		await turnGate;
	}
	const turn = scriptedTurns.shift() ?? {};
	// A premature settle proves correlation waits for an assistant entry past the marker.
	for (let i = 0; i < (turn.prematureSettles ?? 0); i++) void fireSettled();
	if (turn.output !== undefined) {
		// Re-read the tool map: armStructuredOutput registers workflow_output mid-run.
		const tool = pi.tools.get("workflow_output");
		if (tool) void tool.execute("e2e-output", turn.output, undefined, undefined, mockCtx);
	}
	for (const result of turn.toolResults ?? []) {
		appendMessage({
			role: "toolResult",
			toolName: result.toolName ?? "spawn",
			content: result.text ?? "child done",
			timestamp: Date.now(),
			...(result.cost !== undefined ? { usage: usageOf(result.cost) } : {}),
		});
	}
	const assistants = turn.assistants ?? [{ text: turn.text, cost: turn.cost, stopReason: turn.stopReason, provider: turn.provider, model: turn.model }];
	for (const assistant of assistants) {
		appendMessage({
			role: "assistant",
			content: [{ type: "text", text: assistant.text ?? "ok" }],
			stopReason: assistant.stopReason ?? "stop",
			timestamp: Date.now(),
			...(assistant.provider !== undefined ? { provider: assistant.provider } : {}),
			...(assistant.model !== undefined ? { model: assistant.model } : {}),
			...(assistant.cost !== undefined ? { usage: usageOf(assistant.cost) } : {}),
		});
	}
	void fireSettled();
}

/** Fire every live agent_settled subscriber (the run registry's correlate listener). */
async function fireSettled(): Promise<void> {
	for (const handler of pi.handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, mockCtx);
}

// ── Fault seams ──────────────────────────────────────────────────

function throwProgressFault(): void {
	if (faults.progress > 0) {
		faults.progress -= 1;
		throw new Error("e2e progress fault");
	}
}

/** One fake sandbox returning a canned result; `closeThrows` exercises the cleanup path. */
function makeFakeSandbox(result: CodemodeResult, closeThrows: boolean): CodemodeSandbox {
	return {
		execute: async () => result,
		close: async () => {
			if (closeThrows) throw new Error("e2e sandbox close fault");
		},
	} as unknown as CodemodeSandbox;
}

/** `real` clears the seam; every other mode installs a canned result or a throwing factory. */
function installSandboxFault(mode: string): void {
	if (mode === "real") return setSandboxFactoryForTests(null);
	if (mode === "factory-error") {
		setSandboxFactoryForTests(() => {
			throw new Error("e2e sandbox factory fault");
		});
		return;
	}
	// Real sandbox with its own deadline removed: host-side timing tests must not
	// race the sandbox safeguard, which would mask the soft stop under test.
	if (mode === "no-deadline") {
		setSandboxFactoryForTests((options) => new CodemodeSandbox({ ...options, timeoutMs: Number.POSITIVE_INFINITY }));
		return;
	}
	const aborted = { ok: false, error: { kind: "aborted", message: "e2e sandbox aborted" }, output: [], calls: [] } as unknown as CodemodeResult;
	const timeout = { ok: false, error: { kind: "timeout", message: "e2e sandbox timeout" }, output: [], calls: [] } as unknown as CodemodeResult;
	const oom = { ok: false, error: { kind: "memory-limit", message: "e2e sandbox OOM" }, output: [], calls: [] } as unknown as CodemodeResult;
	const ok = { ok: true, value: undefined, output: [], calls: [], storeWrites: { set: {}, delete: [] } } as CodemodeResult;
	const result = mode === "aborted" ? aborted : mode === "timeout" ? timeout : mode === "oom" ? oom : ok;
	setSandboxFactoryForTests((options: CodemodeSandboxOptions) => {
		sandboxCapture.options = options;
		if (mode === "execute-throws") return { execute: async () => { throw new Error("vm blew up"); }, close: async () => {} } as unknown as CodemodeSandbox;
		return makeFakeSandbox(result, mode === "close-throws");
	});
}

/** Parse `fault <kind> [n]`; invalid input writes the usage ERR and returns. */
function handleFault(rest: string): void {
	const [kind, arg, skipArg] = rest.split(/\s+/);
	const count = arg === undefined ? 1 : Number(arg);
	if (kind === "shell") {
		if (arg !== "result" && arg !== "throws" && arg !== "error") {
			process.stdout.write("ERR:usage fault shell <result|throws|error>\n");
			return;
		}
		faults.shell = arg === "result" ? "ok" : arg;
		process.stdout.write("OK\n");
		return;
	}
	if (kind === "abort-throws") {
		abortThrows = count > 0;
		process.stdout.write("OK\n");
		return;
	}
	if (kind === "model-restore") {
		modelRestoreThrows = count > 0;
		process.stdout.write("OK\n");
		return;
	}
	if (kind === "thinking-restore") {
		thinkingRestoreThrows = count > 0;
		process.stdout.write("OK\n");
		return;
	}
	if (kind === "thinking-throws") {
		thinkingThrows = count;
		process.stdout.write("OK\n");
		return;
	}
	if (kind !== "append-throws" && kind !== "send-throws" && kind !== "progress-throws") {
		process.stdout.write("ERR:unknown fault " + kind + "\n");
		return;
	}
	const skip = skipArg === undefined ? 0 : Number(skipArg);
	if (!Number.isInteger(count) || count < 0 || !Number.isInteger(skip) || skip < 0) {
		process.stdout.write("ERR:usage fault " + kind + " [n] [skip]\n");
		return;
	}
	if (kind === "append-throws") {
		faults.append = count;
		faults.appendSkip = skip;
	}
	if (kind === "send-throws") faults.send = count;
	if (kind === "progress-throws") faults.progress = count;
	process.stdout.write("OK\n");
}

const mockCtx = {
	hasUI: true,
	mode: "non-interactive",
	cwd: process.cwd(),
	ui: {
		notify: (message: string, level: string) => { notifications.push({ message, level }); },
		setStatus: (key: string, value: string | undefined) => { throwProgressFault(); statuses.set(key, value); },
		setWidget: (key: string, value: unknown) => { throwProgressFault(); if (value === undefined) widgets.delete(key); else widgets.add(key); },
		theme: { fg: (_name: string, text: string) => text },
		select: () => Promise.reject(new Error("workflow mocks not enabled; send workflow-mocks first")),
		confirm: () => Promise.reject(new Error("workflow mocks not enabled; send workflow-mocks first")),
		input: () => Promise.reject(new Error("workflow mocks not enabled; send workflow-mocks first")),
		onTerminalInput: () => () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setFooter: (factory: unknown) => { throwProgressFault(); footer = factory; },
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.resolve(undefined),
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: () => Promise.resolve(""),
		addAutocompleteProvider: () => {},
		themes: [],
		getTheme: () => undefined,
		setTheme: () => ({ ok: true }),
	},
	getContextUsage: () => currentUsage,
	sessionManager: {
		getBranch: () => branch,
		getEntries: () => entries,
		getSessionId: () => "e2e-session",
		getLeafId: () => branch.at(-1)?.id ?? null,
		getSessionName: () => undefined,
	},
	modelRegistry: {
		getModelsOfType: (type: string) => (type === "classifier" ? classifierModels : []),
		getModelOfType: () => resolvedModel,
		// Model-groups boot validation reads find/hasConfiguredAuth on session_start.
		find: () => undefined,
		hasConfiguredAuth: () => false,
		getAvailable: () => [],
		classify: async () => (classifyResult ?? { api: "e2e", provider: "e2e", model: "e2e", answers: {}, stopReason: "stop", timestamp: 0 }),
	},
	newSession: async (options?: { withSession?: (ctx: any) => Promise<void> }) => {
		// pi invalidates the replaced ctx the moment teardown starts.
		if (staleOnNewSession) ctxStale = true;
		if (newSessionMode === "fail") throw new Error("e2e new session failed");
		if (newSessionMode === "cancel") return { cancelled: true };
		const replacement = { ...mockCtx } as any;
		// Real pi starts a fresh session with an empty branch; a clear mode emulates that for
		// the baseline-fold cost tests without a second process.
		if (newSessionMode === "clear") branch.length = 0;
		// Real pi builds a fresh runtime and emits session_start before withSession; the
		// extension's workflow coordinator publishes its live bindings from that event, so the
		// mock must emit it too or a rebinding workflow finds no runtime.
		if (newSessionPublish) {
			for (const handler of pi.handlers.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "new" }, replacement);
			}
			// Hold the teardown window open so a production tick can land inside it.
			if (newSessionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, newSessionDelayMs));
		}
		if (options?.withSession) await options.withSession(replacement);
		return { cancelled: false };
	},
	isProjectTrusted: () => true,
	// Required by spawn tool which checks ctx.model existence before using it
	model: undefined,
	isIdle: () => true,
	signal: new AbortController().signal,
	abort: () => {
		if (abortThrows) throw new Error("e2e model abort failed");
	},
	hasPendingMessages: () => queuedFollowUps.length > 0,
	shutdown: () => process.exit(0),
	compact: (request: { onComplete?: () => void; onError?: (error: Error) => void }) => {
		lastCompactRequest = request;
	},
	getSystemPrompt: () => "",
} as any; // Type assertion needed: mock intentionally omits some interface fields

// The command receives a proxy so a replaced ctx fails loudly: a run that keeps reading
// the old ctx after `workflow.new` throws instead of silently using a dead session.
const commandCtx: any = new Proxy(mockCtx, {
	get(target, prop, receiver) {
		if (ctxStale) throw new Error("This extension ctx is stale after session replacement or reload.");
		return Reflect.get(target, prop, receiver);
	},
});

// ── Real input dispatch ──────────────────────────────────────────
// Production routes submissions through ExtensionRunner.emitInput, so the harness runs
// pi's own chain over the extension's live handler map. emitInput only reads `handlers`;
// `path` just labels errors. onError surfaces handler failures that emitInput would
// otherwise swallow through emitError.
const inputRunner = new ExtensionRunner(
	[{ handlers: pi.handlers, path: "e2e" }] as unknown as Extension[],
	createExtensionRuntime(),
	process.cwd(),
	mockCtx.sessionManager,
	mockCtx.modelRegistry,
);
inputRunner.onError((error) => process.stdout.write("ERR:input-handler:" + error.error + "\n"));
inputRunner.setUIContext(mockCtx.ui);

/** Dispatch one submission through the real input chain; print the final action. */
async function dispatchInput(text: string, source: InputSource): Promise<void> {
	const result = await inputRunner.emitInput(text, undefined, source);
	process.stdout.write("OK:" + JSON.stringify(result) + "\n");
}

/** Shared by cmd/cmd-bg: parse the invocation and start the handler without deciding
 * when to await it. Returns null after writing the unknown-command ERR. */
function startCommand(rest: string): Promise<void> | null {
	const spaceIdx = rest.indexOf(" ");
	const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
	const arg = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
	const cmdDef = commands.get(name);
	if (!cmdDef) {
		process.stdout.write("ERR:unknown command " + name + "\n");
		return null;
	}
	return cmdDef.handler(arg, commandCtx);
}

/** One OK/ERR line for a started command, shared by the awaiting and background verbs. */
async function reportCommandOutcome(command: Promise<void>): Promise<void> {
	try {
		await command;
		process.stdout.write("OK\n");
	} catch (e) {
		process.stdout.write("ERR:" + (e instanceof Error ? e.message : String(e)) + "\n");
	}
}

/** Open a held exec gate so parked runs resume; false when no gate is held. */
function releaseExec(): boolean {
	if (!execOpened) return false;
	const release = execOpened;
	execGate = null;
	execOpened = null;
	release();
	return true;
}

/** Open a held turn gate so a parked `workflow.run` turn settles; false when no gate is held. */
function releaseTurn(): boolean {
	if (!turnOpened) return false;
	const release = turnOpened;
	turnGate = null;
	turnOpened = null;
	release();
	return true;
}

// ── Terminal-input capture (workflow cancellation) ──
let terminalInput: ((data: string) => { consume: boolean }) | null = null;

function enableTuiInput(): void {
	// registerCancellation arms only on ctx.mode "tui", and the captured handler must live
	// on the same ui object the command receives, so both are set before the run starts.
	mockCtx.mode = "tui";
	mockCtx.ui.onTerminalInput = (handler: (data: string) => { consume: boolean }) => {
		terminalInput = handler;
		return () => {
			terminalInput = null;
		};
	};
}

const KEY_DATA: Record<string, string> = { escape: "\u001b", "ctrl+c": "\u0003" };

/** Dispatch raw terminal data; the handler's { consume } verdict is echoed. */
function dispatchTerminal(data: string): void {
	if (!terminalInput) {
		process.stdout.write("ERR:no terminal input listener\n");
		return;
	}
	process.stdout.write("OK:" + JSON.stringify(terminalInput(data) ?? null) + "\n");
}

function sendKey(name: string): void {
	if (!(name in KEY_DATA)) {
		process.stdout.write("ERR:unknown key " + name + "\n");
		return;
	}
	dispatchTerminal(KEY_DATA[name]);
}

// ── REPL loop ────────────────────────────────────────────────────

process.stdout.write("READY\n");

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	const trimmed = line.trim();
	if (!trimmed) continue;

	if (trimmed === "exit") {
		process.exit(0);
	} else if (trimmed === "ui" || trimmed === "headless") {
		mockCtx.hasUI = trimmed === "ui";
		process.stdout.write("OK\n");
	} else if (trimmed === "ui-events") {
		process.stdout.write("OK:" + JSON.stringify({ statuses: Object.fromEntries(statuses), notifications }) + "\n");
	} else if (trimmed.startsWith("usage ")) {
		const jsonArg = trimmed.slice(6).trim();
		try {
			currentUsage = JSON.parse(jsonArg);
			process.stdout.write("OK\n");
		} catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
		}
	} else if (trimmed === "compact-success" || trimmed.startsWith("compact-fail")) {
		const [beforeCompact] = pi.handlers.get("session_before_compact") ?? [];
		const compactRequest = lastCompactRequest as any;
		if (!beforeCompact || !compactRequest) {
			process.stdout.write("ERR:no queued compaction\n");
			continue;
		}
		if (trimmed === "compact-success") {
			if (typeof compactRequest.onComplete !== "function") {
				process.stdout.write("ERR:no success callback\n");
				continue;
			}
			const result = await beforeCompact(
				{ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-e2e" }] },
				mockCtx,
			);
			lastCompactRequest = null;
			if (!result?.compaction) {
				process.stdout.write("OK:null\n");
				continue;
			}
			// Mirror Pi: the compaction entry lands in the branch before the successor
			// delivery, so recovery scans observe the same order.
			const compactionId = `compaction-${++entrySeq}`;
			appendEntry({
				type: "compaction",
				id: compactionId,
				summary: result.compaction.summary,
				details: result.compaction.details,
			});
			compactRequest.onComplete();
			// Mirror Pi: a successful compaction emits session_compact so cut waiters
			// (e.g. workflow.handoff) observe the marker id for the successor settle.
			for (const handler of pi.handlers.get("session_compact") ?? []) {
				await handler({ compactionEntry: { id: compactionId }, fromExtension: true }, mockCtx);
			}
			const lastMessage = pi.sentUserMessages.at(-1);
			process.stdout.write("OK:" + JSON.stringify({
				...result.compaction,
				queuedFollowUp: lastMessage?.options?.deliverAs === "followUp",
			}) + "\n");
		} else {
			if (typeof compactRequest.onError !== "function") {
				process.stdout.write("ERR:no failure callback\n");
				continue;
			}
			const failureMessage = trimmed.slice("compact-fail".length).trim() || "simulated compaction failure";
			compactRequest.onError(new Error(failureMessage));
			lastCompactRequest = null;
			// Real pi emits session_compact_failed; the workflow's handoff wait listens for it.
			for (const handler of pi.handlers.get("session_compact_failed") ?? []) {
				await handler({ type: "session_compact_failed", errorMessage: failureMessage, aborted: false, willRetry: false, fromExtension: true, reason: "manual" }, mockCtx);
			}
			const lastMessage = pi.sentUserMessages.at(-1)?.content ?? "";
			process.stdout.write("OK:compaction failed:" + lastMessage + "\n");
		}
	} else if (trimmed === "successor-turn") {
		const successorMessage = queuedFollowUps.shift();
		const [contextHandler] = pi.handlers.get("context") ?? [];
		if (!successorMessage || !contextHandler) {
			process.stdout.write("ERR:no queued successor turn\n");
			continue;
		}
		// Model Pi persistence: draining the follow-up appends the user message as
		// text content parts — the shape real Pi persists.
		appendEntry({
			type: "message",
			id: `message-${++entrySeq}`,
			message: { role: "user", content: [{ type: "text", text: successorMessage }] },
		});
		const result = await contextHandler({
			messages: [{ role: "user", content: successorMessage, timestamp: Date.now() }],
		}, mockCtx);
		process.stdout.write("OK:" + JSON.stringify({ successorMessage, context: result ?? null }) + "\n");
	} else if (trimmed.startsWith("successor-assistant ")) {
		// Simulate the successor run's model reply: settle gates correlate a run only
		// once an assistant entry lands after the delivered user message.
		const text = trimmed.slice("successor-assistant ".length).trim();
		if (!text) {
			process.stdout.write("ERR:missing successor-assistant text\n");
			continue;
		}
		appendEntry({
			type: "message",
			id: `message-${++entrySeq}`,
			message: { role: "assistant", content: [{ type: "text", text }] },
		});
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("user-turn ")) {
		const content = trimmed.slice("user-turn ".length).trim();
		if (!content) {
			process.stdout.write("ERR:missing user-turn content\n");
			continue;
		}
		appendEntry({
			type: "message",
			id: `message-${++entrySeq}`,
			message: { role: "user", content: [{ type: "text", text: content }] },
		});
		process.stdout.write("OK\n");
	} else if (trimmed === "agent-end") {
		const [agentEnd] = pi.handlers.get("agent_end") ?? [];
		if (!agentEnd) {
			process.stdout.write("ERR:no agent_end handler\n");
			continue;
		}
		await agentEnd({}, mockCtx);
		process.stdout.write("OK\n");
	} else if (trimmed === "agent-settled") {
		const [agentSettled] = pi.handlers.get("agent_settled") ?? [];
		if (!agentSettled) {
			process.stdout.write("ERR:no agent_settled handler\n");
			continue;
		}
		await agentSettled({}, mockCtx);
		process.stdout.write("OK\n");
	} else if (trimmed === "agent-settled-all") {
		// Run every agent_settled handler: late subscribers (e.g. a workflow.handoff
		// settle gate armed mid-run) must observe the boundary, not just the first.
		const settledHandlers = pi.handlers.get("agent_settled") ?? [];
		if (!settledHandlers.length) {
			process.stdout.write("ERR:no agent_settled handler\n");
			continue;
		}
		for (const handler of settledHandlers) await handler({}, mockCtx);
		process.stdout.write("OK\n");
	} else if (trimmed === "drop-follow-up") {
		const dropped = queuedFollowUps.shift();
		process.stdout.write(dropped ? "OK\n" : "ERR:no queued follow-up\n");
	} else if (trimmed === "successor-count") {
		const count = pi.sentUserMessages.filter((message) => message.content.startsWith("## Next instruction")).length;
		process.stdout.write("OK:" + count + "\n");
	} else if (trimmed === "sent-messages") {
		process.stdout.write("OK:" + JSON.stringify(pi.sentUserMessages) + "\n");
	} else if (trimmed === "appended") {
		process.stdout.write("OK:" + JSON.stringify(pi.appendedEntries) + "\n");
	} else if (trimmed.startsWith("flag ")) {
		const spaceIdx = trimmed.indexOf(" ", 5);
		if (spaceIdx === -1) {
			process.stdout.write("ERR:usage flag <name> <value>\n");
			continue;
		}
		pi.setFlag(trimmed.slice(5, spaceIdx), trimmed.slice(spaceIdx + 1));
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("spent ")) {
		const total = Number(trimmed.slice(6).trim());
		if (!Number.isFinite(total)) {
			process.stdout.write("ERR:usage spent <usd>\n");
			continue;
		}
		appendEntry({
			type: "usage",
			id: `usage-${++entrySeq}`,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } },
		});
		process.stdout.write("OK\n");
	} else if (trimmed === "session-tree" || trimmed === "tree-edit-last-user") {
		const [sessionTree] = pi.handlers.get("session_tree") ?? [];
		if (!sessionTree) {
			process.stdout.write("ERR:no session_tree handler\n");
			continue;
		}
		const oldLeafId = branch.at(-1)?.id ?? "old-leaf";
		if (trimmed === "tree-edit-last-user") {
			const index = branch.map((entry) => entry.message?.role).lastIndexOf("user");
			if (index === -1) {
				process.stdout.write("ERR:no user turn to edit\n");
				continue;
			}
			branch.splice(index);
		}
		await sessionTree({ newLeafId: branch.at(-1)?.id ?? "root", oldLeafId }, mockCtx);
		process.stdout.write("OK\n");
	} else if (trimmed === "tools") {
		const names = Array.from(tools.keys()).sort().join(",");
		process.stdout.write("OK:" + names + "\n");
	} else if (trimmed === "cmds") {
		const names = Array.from(commands.keys()).sort().join(",");
		process.stdout.write("OK:" + names + "\n");
	} else if (trimmed.startsWith("toolcall ")) {
		const rest = trimmed.slice(9).trim();
		const spaceIdx = rest.indexOf(" ");
		if (spaceIdx === -1) {
			process.stdout.write("ERR:usage toolcall <name> <json-args>\n");
			continue;
		}
		const toolName = rest.slice(0, spaceIdx);
		const jsonArgs = rest.slice(spaceIdx + 1);
		let input;
		try { input = JSON.parse(jsonArgs); }
		catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		try {
			const [handler] = pi.handlers.get("tool_call") ?? [];
			const result = await handler({ toolName, input }, { cwd: mockCtx.cwd });
			process.stdout.write("OK:" + JSON.stringify(result ?? null) + "\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else if (trimmed.startsWith("context")) {
		let payload;
		try {
			payload = trimmed === "context"
				? { messages: [{ role: "user", content: "e2e", timestamp: Date.now() }] }
				: JSON.parse(trimmed.slice(7).trim());
		} catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		try {
			const [handler] = pi.handlers.get("context") ?? [];
			const result = await handler(payload, mockCtx);
			process.stdout.write("OK:" + JSON.stringify(result ?? null) + "\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else if (trimmed.startsWith("tool ")) {
		const rest = trimmed.slice(5).trim();
		const spaceIdx = rest.indexOf(" ");
		if (spaceIdx === -1) {
			process.stdout.write("ERR:usage tool <name> <json-args>\n");
			continue;
		}
		const toolName = rest.slice(0, spaceIdx);
		const jsonArgs = rest.slice(spaceIdx + 1);
		const toolDef = tools.get(toolName);
		if (!toolDef) {
			process.stdout.write("ERR:unknown tool " + toolName + "\n");
			continue;
		}
		let params;
		try { params = JSON.parse(jsonArgs); }
		catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		try {
			const result = await toolDef.execute("e2e-" + toolName, params, undefined, undefined, mockCtx);
			const text = result.content?.map((c: any) => c.text).filter(Boolean).join("\n") || "";
			process.stdout.write("OK:" + text + "\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else if (trimmed.startsWith("cmd-bg ")) {
		if (backgroundCommand) {
			process.stdout.write("ERR:background command already running\n");
			continue;
		}
		backgroundCommand = startCommand(trimmed.slice(7).trim());
		if (!backgroundCommand) continue; // unknown-command ERR already written
		backgroundCommand.catch(() => {}); // outcome is reported at cmd-wait; silence the early rejection
		process.stdout.write("OK:started\n");
	} else if (trimmed === "cmd-wait") {
		const command = backgroundCommand;
		backgroundCommand = null;
		if (!command) process.stdout.write("ERR:no background command\n");
		else await reportCommandOutcome(command);
	} else if (trimmed.startsWith("cmd ")) {
		const command = startCommand(trimmed.slice(4).trim());
		if (command) await reportCommandOutcome(command);
	} else if (trimmed.startsWith("input-ext ")) {
		await dispatchInput(trimmed.slice("input-ext ".length), "extension");
	} else if (trimmed.startsWith("input ")) {
		await dispatchInput(trimmed.slice("input ".length), "interactive");
	} else if (trimmed === "workflow-mocks") {
		enableWorkflowMocks();
		process.stdout.write("OK\n");
	} else if (trimmed === "hold-exec") {
		execGate = new Promise((resolve) => { execOpened = () => resolve(); });
		process.stdout.write("OK\n");
	} else if (trimmed === "release-exec") {
		process.stdout.write(releaseExec() ? "OK\n" : "ERR:no held exec\n");
	} else if (trimmed === "hold-turn") {
		turnGate = new Promise((resolve) => { turnOpened = () => resolve(); });
		process.stdout.write("OK\n");
	} else if (trimmed === "release-turn") {
		process.stdout.write(releaseTurn() ? "OK\n" : "ERR:no held turn\n");
	} else if (trimmed.startsWith("turn-end ")) {
		const outcome = trimmed.slice("turn-end ".length).trim();
		const handlers = pi.handlers.get("turn_end") ?? [];
		if (!handlers.length) {
			process.stdout.write("ERR:no turn_end handler\n");
			continue;
		}
		for (const handler of handlers) await handler({ type: "turn_end", outcome }, mockCtx);
		process.stdout.write("OK\n");
	} else if (trimmed === "tui") {
		enableTuiInput();
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("key-raw ")) {
		try {
			dispatchTerminal(JSON.parse(trimmed.slice("key-raw ".length)) as string);
		} catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
		}
	} else if (trimmed.startsWith("key ")) {
		sendKey(trimmed.slice(4).trim());
	} else if (trimmed.startsWith("mode ")) {
		mockCtx.mode = trimmed.slice(5).trim();
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("cwd ")) {
		mockCtx.cwd = trimmed.slice(4).trim();
		process.stdout.write("OK\n");
	} else if (trimmed === "terminal") {
		process.stdout.write("OK:" + JSON.stringify({ registered: terminalInput !== null }) + "\n");
	} else if (trimmed === "widgets") {
		process.stdout.write("OK:" + JSON.stringify([...widgets]) + "\n");
	} else if (trimmed.startsWith("shell-delay ")) {
		const ms = Number(trimmed.slice("shell-delay ".length).trim());
		if (!Number.isFinite(ms) || ms < 0) {
			process.stdout.write("ERR:usage shell-delay <ms>\n");
			continue;
		}
		shellDelayMs = ms;
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("flag-empty ")) {
		pi.setFlag(trimmed.slice("flag-empty ".length).trim(), "");
		process.stdout.write("OK\n");
	} else if (trimmed === "mock-select" || trimmed.startsWith("mock-select ")) {
		const value = trimmed.slice("mock-select".length).trim();
		pickerSelect.push(value === "" ? undefined : value);
		process.stdout.write("OK\n");
	} else if (trimmed === "mock-input" || trimmed.startsWith("mock-input ")) {
		const value = trimmed.slice("mock-input".length).trim();
		pickerInput.push(value === "" ? undefined : value);
		process.stdout.write("OK\n");
	} else if (trimmed === "mock-model" || trimmed.startsWith("mock-model ")) {
		const arg = trimmed.slice("mock-model".length).trim();
		let spec: any = {};
		try { if (arg) spec = JSON.parse(arg); }
		catch (e: unknown) { process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n"); continue; }
		mockCtx.model = spec.current ?? undefined;
		resolvedModel = spec.resolve ?? undefined;
		process.stdout.write("OK\n");
	} else if (trimmed === "model-calls") {
		process.stdout.write("OK:" + JSON.stringify({ model: modelCalls, thinking: thinkingCalls, current: mockCtx.model ?? null, thinkingLevel: pi.getThinkingLevel() }) + "\n");
	} else if (trimmed.startsWith("mock-commands ")) {
		let commands: any;
		try { commands = JSON.parse(trimmed.slice("mock-commands ".length)); }
		catch (e: unknown) { process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n"); continue; }
		pi.setCommands(commands);
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("seed-entry ")) {
		let spec: any;
		try { spec = JSON.parse(trimmed.slice("seed-entry ".length)); }
		catch (e: unknown) { process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n"); continue; }
		seedBranchEntry(spec);
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("mock-classify ")) {
		let spec: any = {};
		try { spec = JSON.parse(trimmed.slice("mock-classify ".length)); }
		catch (e: unknown) { process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n"); continue; }
		if (spec.models) classifierModels = spec.models;
		classifyResult = spec.result ?? null;
		process.stdout.write("OK\n");
	} else if (trimmed === "sandbox-options") {
		const options = sandboxCapture.options ? { timeoutMs: Number.isFinite(sandboxCapture.options.timeoutMs) ? sandboxCapture.options.timeoutMs : String(sandboxCapture.options.timeoutMs), memoryLimitBytes: sandboxCapture.options.memoryLimitBytes } : null;
		process.stdout.write("OK:" + JSON.stringify(options) + "\n");
	} else if (trimmed === "active-tools") {
		process.stdout.write("OK:" + JSON.stringify(pi.activeTools) + "\n");
	} else if (trimmed.startsWith("new-session-publish ")) {
		const value = trimmed.slice("new-session-publish ".length).trim();
		if (value !== "on" && value !== "off") {
			process.stdout.write("ERR:usage new-session-publish <on|off>\n");
			continue;
		}
		newSessionPublish = value === "on";
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("new-session-delay ")) {
		const ms = Number(trimmed.slice("new-session-delay ".length).trim());
		if (!Number.isFinite(ms) || ms < 0) {
			process.stdout.write("ERR:usage new-session-delay <ms>\n");
			continue;
		}
		newSessionDelayMs = ms;
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("stale-on-new-session ")) {
		const value = trimmed.slice("stale-on-new-session ".length).trim();
		if (value !== "on" && value !== "off") {
			process.stdout.write("ERR:usage stale-on-new-session <on|off>\n");
			continue;
		}
		staleOnNewSession = value === "on";
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("new-session ")) {
		const mode = trimmed.slice("new-session ".length).trim();
		if (mode !== "normal" && mode !== "cancel" && mode !== "fail" && mode !== "clear") {
			process.stdout.write("ERR:usage new-session <normal|cancel|fail|clear>\n");
			continue;
		}
		newSessionMode = mode;
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("turn ")) {
		let turn: ScriptedTurn;
		try {
			turn = JSON.parse(trimmed.slice(5).trim());
		} catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		scriptedTurns.push(turn);
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("fault ")) {
		handleFault(trimmed.slice(6).trim());
	} else if (trimmed.startsWith("sandbox ")) {
		installSandboxFault(trimmed.slice("sandbox ".length).trim());
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("readonly ")) {
		const value = trimmed.slice("readonly ".length).trim();
		if (value !== "on" && value !== "off") {
			process.stdout.write("ERR:usage readonly <on|off>\n");
			continue;
		}
		// Rehydrate through the production branch scan so the posture follows real state.
		appendEntry({ type: "custom", id: `readonly-${++entrySeq}`, customType: "pi-schematic-readonly", data: { enabled: value === "on" } });
		for (const handler of pi.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, mockCtx);
		process.stdout.write("OK\n");
	} else if (trimmed === "footer") {
		if (!footer) {
			process.stdout.write("OK:null\n");
			continue;
		}
		const factory = footer as (tui: unknown, theme: unknown, data: unknown) => { render(w: number): string[] };
		const data = { getGitBranch: () => null, getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
		const line = factory({ requestRender: () => {} }, { fg: (_name: string, text: string) => text }, data).render(200)[0];
		process.stdout.write("OK:" + JSON.stringify(line ?? null) + "\n");
	} else {
		process.stdout.write("ERR:unknown input\n");
	}
}
