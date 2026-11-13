/**
 * test-host.ts — Minimal pi host for process-isolated E2E tests.
 *
 * Spawned as a child process. Loads the extension, then runs a
 * line-oriented REPL on stdin/stdout.
 *
 * Protocol:
 *   → cmd <name> [arg]      — call a registered command
 *   → tool <name> <json>    — call a registered tool with JSON params
 *   → toolcall <name> <json> — run the tool_call hooks; prints the first block or null
 *   → context [json]        — run the first context hook
 *   → headless              — select headless mode for subsequent calls
 *   → exit                  — graceful shutdown
 *
 *   ← READY\n               — sent after extension registration
 *   ← OK[:payload]\n        — success
 *   ← ERR:message\n         — failure
 */

import { createInterface } from "node:readline";
import { createTestHost } from "../unit/test-host.js";

// ── Real extension host ───────────────────────────────────────────
// Loads the extension through pi's real loader so the host exercises the same
// ExtensionAPI the runtime provides. No TUI dependencies — tools and commands
// access the state through the pi object directly.

const pi = await createTestHost();
// Capture the maps after registration: `pi.tools` is derived from the loaded
// Extension's registered tools.
const commands: Map<string, unknown> = pi.commands;
const tools: Map<string, unknown> = pi.tools;

// pi's registrations reach this host untyped; each one is checked where it is called. A call may return a
// promise or a plain value.
type Callable = (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertCallable(value: unknown, what: string): asserts value is Callable {
	if (typeof value !== "function") {throw new Error(`${what} is not a function`);}
}

function handlersFor(event: string): Callable[] {
	const handlers: unknown[] = pi.handlers.get(event) ?? [];
	return handlers.map((handler) => {
		assertCallable(handler, `the ${event} handler`);
		return handler;
	});
}

// The text blocks of a tool result, one per line, without empty ones.
function resultText(result: unknown): string {
	if (!isRecord(result)) {throw new Error("the tool returned no result object");}
	if (result.content === undefined || result.content === null) {return "";}
	if (!Array.isArray(result.content)) {throw new Error("the tool result content is not an array");}
	const blocks: unknown[] = result.content;
	return blocks.map((block) => {
		if (!isRecord(block)) {throw new Error("a tool result content block is not an object");}
		return block.text;
	}).filter(Boolean).join("\n");
}

// ── Mock ExtensionContext for tool/command execution ──────────────

// The line host has no session: context usage is unavailable and the branch is empty.

const ignore = () => { /* The line host renders no TUI and has no run to abort. */ };

const mockCtx = {
	hasUI: true,
	mode: "non-interactive",
	cwd: process.cwd(),
	ui: {
		notify: ignore,
		setStatus: ignore,
		setWidget: ignore,
		theme: { fg: (_name: string, text: string) => text },
		select: () => Promise.resolve(undefined),
		confirm: () => Promise.resolve(false),
		input: () => Promise.resolve(""),
		onTerminalInput: () => ignore,
		setWorkingMessage: ignore,
		setWorkingVisible: ignore,
		setWorkingIndicator: ignore,
		setHiddenThinkingLabel: ignore,
		setFooter: ignore,
		setHeader: ignore,
		setTitle: ignore,
		custom: () => Promise.resolve(undefined),
		pasteToEditor: ignore,
		setEditorText: ignore,
		getEditorText: () => "",
		editor: () => Promise.resolve(""),
		addAutocompleteProvider: ignore,
		themes: [],
		getTheme: () => undefined,
		setTheme: () => ({ ok: true }),
	},
	getContextUsage: () => null,
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	modelRegistry: null,
	isProjectTrusted: () => true,
	// Required by spawn tool which checks ctx.model existence before using it
	model: undefined,
	isIdle: () => true,
	signal: new AbortController().signal,
	abort: ignore,
	// The line host keeps no follow-up queue: sends are only recorded in pi.sentUserMessages.
	hasPendingMessages: () => false,
	shutdown: () => process.exit(0),
	getSystemPrompt: () => "",
};

// ── REPL loop ────────────────────────────────────────────────────

process.stdout.write("READY\n");

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	const trimmed = line.trim();
	if (!trimmed) {continue;}

	if (trimmed === "exit") {
		process.exit(0);
	} else if (trimmed === "headless") {
		mockCtx.hasUI = false;
		process.stdout.write("OK\n");
	} else if (trimmed.startsWith("toolcall ")) {
		const rest = trimmed.slice(9).trim();
		const spaceIdx = rest.indexOf(" ");
		if (spaceIdx === -1) {
			process.stdout.write("ERR:usage toolcall <name> <json-args>\n");
			continue;
		}
		const toolName = rest.slice(0, spaceIdx);
		const jsonArgs = rest.slice(spaceIdx + 1);
		let input: unknown;
		try { input = JSON.parse(jsonArgs); }
		catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		try {
			// As pi does: every tool_call handler in registration order, the first block wins.
			let result: unknown = null;
			for (const handler of handlersFor("tool_call")) {
				const outcome = await handler({ toolCallId: "e2e-toolcall", toolName, input }, mockCtx);
				if (isRecord(outcome) && Boolean(outcome.block)) {
					result = outcome;
					break;
				}
			}
			process.stdout.write("OK:" + JSON.stringify(result) + "\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else if (trimmed.startsWith("context")) {
		let payload: unknown;
		try {
			payload = trimmed === "context"
				? { messages: [{ role: "user", content: "e2e", timestamp: Date.now() }] }
				: JSON.parse(trimmed.slice(7).trim());
		} catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		try {
			const handlers = handlersFor("context");
			if (handlers.length === 0) {throw new Error("no context handler is registered");}
			const [handler] = handlers;
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
		if (!isRecord(toolDef)) {
			process.stdout.write("ERR:unknown tool " + toolName + "\n");
			continue;
		}
		let params: unknown;
		try { params = JSON.parse(jsonArgs); }
		catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		try {
			assertCallable(toolDef.execute, `tool ${toolName} execute`);
			const result = await toolDef.execute("e2e-" + toolName, params, undefined, undefined, mockCtx);
			process.stdout.write("OK:" + resultText(result) + "\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else if (trimmed.startsWith("cmd ")) {
		const rest = trimmed.slice(4).trim();
		const spaceIdx = rest.indexOf(" ");
		const cmdName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
		const cmdArg = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
		const cmdDef = commands.get(cmdName);
		if (!isRecord(cmdDef)) {
			process.stdout.write("ERR:unknown command " + cmdName + "\n");
			continue;
		}
		try {
			assertCallable(cmdDef.handler, `command ${cmdName} handler`);
			await cmdDef.handler(cmdArg, mockCtx);
			process.stdout.write("OK\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else {
		process.stdout.write("ERR:unknown input\n");
	}
}
