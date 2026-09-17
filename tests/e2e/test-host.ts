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
 *   → ui / headless         — select UI mode for subsequent calls
 *   → ui-events             — return current status values and emitted notifications
 *   → compact-success       — run queued handoff compaction success path
 *   → compact-fail [message] — run queued handoff compaction failure path
 *   → successor-turn        — drain a queued follow-up into the successor context hook
 *   → session-tree          — navigate the active session tree branch
 *   → agent-end             — run the first agent_end handler
 *   → agent-settled         — run the first agent_settled handler
 *   → drop-follow-up        — discard one queued follow-up without persisting it (simulated delivery loss)
 *   → successor-count       — count sent messages starting with "## Next instruction"
 *   → sent-messages         — return extension-sent user messages
 *   → tools                 — list registered tool names
 *   → cmds                  — list registered command names
 *   → exit                  — graceful shutdown
 *
 *   ← READY\n               — sent after extension registration
 *   ← OK[:payload]\n        — success
 *   ← ERR:message\n         — failure
 */

import { createInterface } from "node:readline";
import registerAgenticoding from "../../index.js";
import { createTestPI } from "../unit/helpers.js";

// ── Mock ExtensionAPI ─────────────────────────────────────────────
// Uses createTestPI() from the shared test utilities — a minimal object
// that satisfies what index.ts needs at registration time.
// No TUI dependencies — tools and commands access the state through
// the pi object directly.

const pi = createTestPI();
const commands = pi.commands;
const tools = pi.tools;

// Register the extension — this populates pi.commands and pi.tools
registerAgenticoding(pi);

// ── Mock ExtensionContext for tool/command execution ──────────────

type MockContextUsage = { tokens?: number | null; percent?: number | null; contextWindow?: number | null } | null;
type CompactRequest = { onComplete?: () => void; onError?: (error: Error) => void };

let currentUsage: MockContextUsage = null;
let lastCompactRequest: CompactRequest | null = null;
const queuedFollowUps: string[] = [];
const statuses = new Map<string, string | undefined>();
const notifications: Array<{ message: string; level: string }> = [];
// Branch model: compaction and successor entries land here exactly as Pi persists
// them, so recovery scans see the real order and content shape.
const branch: any[] = [];
let entrySeq = 0;

// Model Pi's follow-up queue centrally: every extension send with
// deliverAs "followUp" waits here until a run drains it. Recovery sends must
// queue too, so the override cannot live inside a single REPL command.
const originalSendUserMessage = pi.sendUserMessage;
pi.sendUserMessage = (content: any, options?: any) => {
	originalSendUserMessage.call(pi, content, options);
	if (options?.deliverAs === "followUp") {
		queuedFollowUps.push(typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("\n"));
	}
};

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
	sessionManager: { getBranch: () => branch },
	modelRegistry: null,
	isProjectTrusted: () => true,
	// Required by spawn tool which checks ctx.model existence before using it
	model: undefined,
	isIdle: () => true,
	signal: new AbortController().signal,
	abort: () => {},
	hasPendingMessages: () => queuedFollowUps.length > 0,
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
			branch.push({
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
		} else {
			if (typeof compactRequest.onError !== "function") {
				process.stdout.write("ERR:no failure callback\n");
				continue;
			}
			compactRequest.onError(new Error(trimmed.slice("compact-fail".length).trim() || "simulated compaction failure"));
			lastCompactRequest = null;
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
		branch.push({
			type: "message",
			id: `message-${++entrySeq}`,
			message: { role: "user", content: [{ type: "text", text: successorMessage }] },
		});
		const result = await contextHandler({
			messages: [{ role: "user", content: successorMessage, timestamp: Date.now() }],
		}, mockCtx);
		process.stdout.write("OK:" + JSON.stringify({ successorMessage, context: result ?? null }) + "\n");
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
	} else if (trimmed === "drop-follow-up") {
		const dropped = queuedFollowUps.shift();
		process.stdout.write(dropped ? "OK\n" : "ERR:no queued follow-up\n");
	} else if (trimmed === "successor-count") {
		const count = pi.sentUserMessages.filter((message) => message.content.startsWith("## Next instruction")).length;
		process.stdout.write("OK:" + count + "\n");
	} else if (trimmed === "sent-messages") {
		process.stdout.write("OK:" + JSON.stringify(pi.sentUserMessages) + "\n");
	} else if (trimmed === "session-tree") {
		const [sessionTree] = pi.handlers.get("session_tree") ?? [];
		if (!sessionTree) {
			process.stdout.write("ERR:no session_tree handler\n");
			continue;
		}
		await sessionTree({ newLeafId: "fresh-leaf", oldLeafId: "old-leaf" }, mockCtx);
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
