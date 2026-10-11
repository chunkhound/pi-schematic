/**
 * test-host.ts — Minimal pi host for process-isolated E2E tests.
 *
 * Spawned as a child process. Loads the extension, then runs a
 * line-oriented REPL on stdin/stdout.
 *
 * Protocol:
 *   → cmd <name> [arg]      — call a registered command
 *   → tool <name> <json>    — call a registered tool with JSON params
 *   → toolcall <name> <json> — run the first tool_call hook directly
 *   → context [json]        — run the first context hook
 *   → usage <json|null>     — set getContextUsage() result for later calls
 *   → headless              — select headless mode for subsequent calls
 *   → ui-events             — return current status values and emitted notifications
 *   → compact-success       — run queued handoff compaction success path
 *   → session-tree          — fire a tree-navigation event without changing the active branch
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
const commands = pi.commands;
const tools = pi.tools;

// ── Mock ExtensionContext for tool/command execution ──────────────

type MockContextUsage = { tokens?: number | null; percent?: number | null; contextWindow?: number | null } | null;
type CompactRequest = { onComplete?: () => void; onError?: (error: Error) => void };

let currentUsage: MockContextUsage = null;
let lastCompactRequest: CompactRequest | null = null;
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

const mockCtx = {
	hasUI: true,
	mode: "non-interactive",
	cwd: process.cwd(),
	ui: {
		notify: (message: string, level: string) => { notifications.push({ message, level }); },
		setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		setWidget: () => {},
		theme: { fg: (_name: string, text: string) => text },
		select: () => Promise.resolve(undefined),
		confirm: () => Promise.resolve(false),
		input: () => Promise.resolve(""),
		onTerminalInput: () => () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setFooter: () => {},
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
	sessionManager: { getBranch: () => branch, getEntries: () => entries },
	modelRegistry: null,
	isProjectTrusted: () => true,
	// Required by spawn tool which checks ctx.model existence before using it
	model: undefined,
	isIdle: () => true,
	signal: new AbortController().signal,
	abort: () => {},
	// The line host keeps no follow-up queue: sends are only recorded in pi.sentUserMessages.
	hasPendingMessages: () => false,
	shutdown: () => process.exit(0),
	compact: (request: { onComplete?: () => void; onError?: (error: Error) => void }) => {
		lastCompactRequest = request;
	},
	getSystemPrompt: () => "",
} as any; // Type assertion needed: mock intentionally omits some interface fields

// ── REPL loop ────────────────────────────────────────────────────

process.stdout.write("READY\n");

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	const trimmed = line.trim();
	if (!trimmed) continue;

	if (trimmed === "exit") {
		process.exit(0);
	} else if (trimmed === "headless") {
		mockCtx.hasUI = false;
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
	} else if (trimmed === "compact-success") {
		const [beforeCompact] = pi.handlers.get("session_before_compact") ?? [];
		const compactRequest = lastCompactRequest as any;
		if (!beforeCompact || !compactRequest) {
			process.stdout.write("ERR:no queued compaction\n");
			continue;
		}
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
		appendEntry({
			type: "compaction",
			id: `compaction-${++entrySeq}`,
			summary: result.compaction.summary,
			details: result.compaction.details,
		});
		compactRequest.onComplete();
		const lastMessage = pi.sentUserMessages.at(-1);
		process.stdout.write("OK:" + JSON.stringify({
			...result.compaction,
			queuedFollowUp: lastMessage?.options?.deliverAs === "followUp",
		}) + "\n");
	} else if (trimmed === "session-tree") {
		const [sessionTree] = pi.handlers.get("session_tree") ?? [];
		if (!sessionTree) {
			process.stdout.write("ERR:no session_tree handler\n");
			continue;
		}
		const oldLeafId = branch.at(-1)?.id ?? "old-leaf";
		await sessionTree({ newLeafId: branch.at(-1)?.id ?? "root", oldLeafId }, mockCtx);
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
	} else if (trimmed.startsWith("cmd ")) {
		const rest = trimmed.slice(4).trim();
		const spaceIdx = rest.indexOf(" ");
		const cmdName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
		const cmdArg = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
		const cmdDef = commands.get(cmdName);
		if (!cmdDef) {
			process.stdout.write("ERR:unknown command " + cmdName + "\n");
			continue;
		}
		try {
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
