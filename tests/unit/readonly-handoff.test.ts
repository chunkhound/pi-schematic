import { expect, test } from "vitest";
import { SessionManager, type ContextUsage, type ExtensionRunner, type SessionBoundaryDraft, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPresent, expectPrefix, expectSuffix } from "../assertions.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import { createRunner, type RunnerFixture } from "../support/runner.js";
import { appendDrafts } from "../support/session.js";
import { realTheme } from "../support/theme.js";

type ContextMessage = Awaited<ReturnType<ExtensionRunner["emitContext"]>>[number];

const ELIGIBLE_USAGE: ContextUsage = { tokens: 50000, percent: 25, contextWindow: 200000 };

const READONLY_ACTIVE_SUMMARY =
	"[readonly] enabled — write/edit/powershell blocked; bash writes/deletions outside temp blocked; handoff needs explicit /handoff or an eligible human topic boundary.";

const CONTINUATION_FRAME = [
	"## Handoff — Continue Previous Work",
	"",
	"You are continuing a previous agent's work in a clean context. Use the available knowledge correctly:",
	"- Notebook pages are a cache for this stream: code facts are re-derivable, while user guidance, decisions, and design live in pages — fetch them with `notebook_read`",
	"- The next message carries your instruction verbatim, plus the previous agent's remaining situational context",
	"- Use `notebook_index` to scan available pages when needed",
	"- Use `spawn` to delegate isolated subtasks to child agents",
	"- Build on notebook memory and the instruction rather than reconstructing old context",
].join("\n");

/** The shipped extension on a runner with the recording UI and the real Theme, an idle in-memory session, and the usage and signal the test sets. */
interface HandoffRunner {
	fixture: RunnerFixture;
	session: SessionManager;
	setUsage: (usage: ContextUsage | undefined) => void;
	setSignal: (signal: AbortSignal | undefined) => void;
	runCommand: (name: string, args: string) => Promise<void>;
	/** `/readonly`, with the readonly entry it appends persisted on the branch as pi would persist it. */
	toggleReadonly: () => Promise<void>;
	/** Runs the context hook on one user message; resolves to the messages after every handler. */
	context: (content: string, timestamp: number) => Promise<ContextMessage[]>;
	toolCall: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<ToolCallEventResult | undefined>;
	turnStart: () => Promise<void>;
	agentSettled: () => Promise<void>;
}

async function createHandoffRunner(): Promise<HandoffRunner> {
	let usage: ContextUsage | undefined;
	let signal: AbortSignal | undefined;
	const cwd = process.cwd();
	const session = SessionManager.inMemory(cwd);
	const fixture = await createRunner({
		cwd,
		mode: "tui",
		sessionManager: session,
		ui: { theme: realTheme },
		context: {
			getContextUsage: () => usage,
			getSignal: () => signal,
			isIdle: () => true,
			abort: () => undefined,
		},
		activeTools: [],
	});
	const { runner, host } = fixture;
	const runCommand = async (name: string, args: string): Promise<void> => {
		await fixture.command(name).handler(args, runner.createCommandContext());
	};
	return {
		fixture,
		session,
		setUsage: (next) => {
			usage = next;
		},
		setSignal: (next) => {
			signal = next;
		},
		runCommand,
		toggleReadonly: async () => {
			await runCommand("readonly", "");
			const entry = host.appendedEntries.at(-1);
			assertPresent(entry, "/readonly appends its entry");
			session.appendCustomEntry(entry.customType, entry.data);
		},
		context: (content, timestamp) => runner.emitContext([{ role: "user", content, timestamp }]),
		toolCall: (toolName, input, toolCallId = "call") => runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input }),
		turnStart: async () => {
			await runner.emit({ type: "turn_start", turnIndex: 1, timestamp: 0 });
		},
		agentSettled: async () => {
			await runner.emit({ type: "agent_settled", aborted: false });
		},
	};
}

/** The content of the last readonly nudge in `messages`, if any. */
function lastReadonlyNudge(messages: ContextMessage[]): string | undefined {
	const nudge = messages.filter((message) => message.role === "custom" && message.customType === "pi-schematic-readonly-nudge").at(-1);
	if (nudge === undefined) {
		return undefined;
	}
	if (nudge.role !== "custom" || typeof nudge.content !== "string") {
		throw new Error("The readonly nudge has no text content.");
	}
	return nudge.content;
}

/** `content` of a sent user message as text; throws when it is not text. */
function userMessageText(content: string | readonly unknown[]): string {
	if (typeof content !== "string") {
		throw new Error("The user message has no text content.");
	}
	return content;
}

/** The content of the last message in `messages`; throws when it has no text content. */
function lastMessageContent(messages: ContextMessage[]): string {
	const last = messages.at(-1);
	if (last === undefined || !("content" in last) || typeof last.content !== "string") {
		throw new Error("The last context message has no text content.");
	}
	return last.content;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, api: "faux", provider: "faux", model: "faux", usage: ZERO_USAGE, stopReason: "toolUse", timestamp: 0 };
}

/** A tool result message for `toolCallId`, as pi passes it in `TurnEndEvent.toolResults`. */
function handoffToolResult(toolCallId: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "handoff", content: [{ type: "text", text: "Handoff staged." }], isError: false, timestamp: 0 };
}

/** End a turn whose tool results hold the handoff result for `toolCallId`; resolves to what the handlers asked pi to commit and whether to continue. */
function emitTurnEnd({ fixture }: HandoffRunner, toolCallId: string): Promise<{ entries: SessionBoundaryDraft[]; continue: boolean }> {
	return fixture.runner.emitBoundary(
		{
			type: "turn_end",
			turnIndex: 0,
			message: assistantMessage([]),
			toolResults: [handoffToolResult(toolCallId)],
			messageEntryId: "assistant-entry",
			toolResultEntryIds: [],
			outcome: "completed",
		},
		() => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true }),
	);
}

/** Execute the handoff tool with an eligible context, leaving the handoff staged. */
async function stageHandoff(handoff: HandoffRunner, toolCallId: string, params: Record<string, unknown>): Promise<void> {
	handoff.setUsage(ELIGIBLE_USAGE);
	await handoff.fixture.tool("handoff").execute(toolCallId, params);
}

/** End the staging turn and return the entries the boundary handler asked pi to commit. */
async function submitStagingTurn(handoff: HandoffRunner, toolCallId: string): Promise<SessionBoundaryDraft[]> {
	const { entries, continue: shouldContinue } = await emitTurnEnd(handoff, toolCallId);
	expect(entries, "the staging turn_end must return boundary entries").not.toStrictEqual([]);
	expect(shouldContinue, "the boundary continues the run for the successor turn").toBe(true);
	return entries;
}

/** The summary of the compaction draft in `drafts`. */
function compactionSummary(drafts: SessionBoundaryDraft[]): string {
	const compaction = drafts.find((draft) => draft.type === "compaction");
	assertPresent(compaction, "the cut must write a compaction");
	return compaction.summary;
}

/** The text of the successor turn the cut writes. */
function successorContent(drafts: SessionBoundaryDraft[]): string {
	const successor = drafts.find((draft) => draft.type === "custom_message" && draft.customType === "pi-schematic-handoff");
	if (successor?.type !== "custom_message" || typeof successor.content !== "string") {
		throw new Error("The cut wrote no successor turn with text content.");
	}
	return successor.content;
}

/** Stage → turn_end → turn_start with the committed cut on the branch. Returns the committed drafts. */
async function completeHandoffCut(handoff: HandoffRunner, toolCallId: string, params: Record<string, unknown>): Promise<SessionBoundaryDraft[]> {
	await stageHandoff(handoff, toolCallId, params);
	const drafts = await submitStagingTurn(handoff, toolCallId);
	appendDrafts(handoff.session, drafts);
	await handoff.turnStart();
	return drafts;
}

/** Readonly on and drained, a /handoff staged and cut, with the cut but not its successor committed, failed at turn_start. */
async function loseSuccessorAtTurnStart(): Promise<HandoffRunner> {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.context("drain", 1);
	await handoff.runCommand("handoff", "continue readonly work");
	await stageHandoff(handoff, "handoff-1", {});
	const drafts = await submitStagingTurn(handoff, "handoff-1");
	appendDrafts(
		handoff.session,
		drafts.filter((draft) => draft.type !== "custom_message" || draft.customType !== "pi-schematic-handoff"),
	);
	await handoff.turnStart();
	return handoff;
}

/**
 * Drive a real handoff through the boundary cut, optionally flipping readonly
 * between the tool call and the cut, then read the next model turn's readonly nudge.
 */
async function handoffCutAcrossReadonlyToggle(readonlyAfterCut: boolean): Promise<string | undefined> {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	// Consume the toggle-on nudge so any later nudge can only come from the handoff.
	await handoff.context("drain", 1);
	await handoff.runCommand("handoff", "continue work");
	await stageHandoff(handoff, "handoff-1", { nextInstruction: "ignored in favor of the direction" });
	if (!readonlyAfterCut) {
		await handoff.toggleReadonly();
		// Consume the pre-cut toggle nudge so the probe below sees only the fresh
		// handoff-side announcement of the final live state.
		await handoff.context("toggle", 2);
	}
	appendDrafts(handoff.session, await submitStagingTurn(handoff, "handoff-1"));
	await handoff.turnStart();
	handoff.setUsage(undefined);
	return lastReadonlyNudge(await handoff.context("post-handoff", 3));
}

async function assertNonTempBashBlocked({ toolCall }: HandoffRunner): Promise<void> {
	const target = path.join(os.homedir(), `readonly-handoff-test-${process.pid}-${Date.now()}`);
	const command = `touch "${target}"`;
	await rm(target, { force: true });
	try {
		const result = await toolCall("bash", { command });
		if (result?.block !== true) {
			try {
				execFileSync("bash", ["-lc", command], { cwd: process.cwd(), stdio: "ignore" });
			} catch {
				// A sandbox may reject the command with a non-zero exit status.
			}
		}
		expect(result?.block, "non-temp bash mutations must be blocked before execution").toBe(true);
		await expect(access(target)).rejects.toThrow(/ENOENT/);
	} finally {
		await rm(target, { force: true });
	}
}

/** Readonly on and drained, then a human topic change from oauth to billing. */
async function readonlyTopicBoundary(): Promise<HandoffRunner> {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.context("drain", 1);
	await handoff.runCommand("notebook", "oauth");
	await handoff.runCommand("notebook", "billing");
	return handoff;
}

test("/handoff command creates temporary bypass for handoff tool only", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.runCommand("handoff", "continue readonly work");

	expect(
		await handoff.toolCall("handoff", { nextInstruction: "continue readonly work" }),
		"handoff should be unblocked after explicit /handoff",
	).toBeUndefined();
	expect((await handoff.toolCall("write", { path: "/tmp/test", content: "x" }))?.block, "write should stay blocked").toBe(true);
	const powershell = await handoff.toolCall("powershell", { command: "Get-ChildItem" });
	expect(powershell?.block, "powershell should stay blocked").toBe(true);
	expect(powershell?.reason).toBe(
		"Readonly mode: powershell blocked until the user disables readonly. Do not run PowerShell or other shells through another tool.",
	);
	await assertNonTempBashBlocked(handoff);
});

test("/handoff in readonly mode notifies the readonly handoff exception", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();

	await handoff.runCommand("handoff", "continue readonly work");

	expect(handoff.fixture.ui.notifications.at(-1)).toStrictEqual({
		message:
			"Readonly is active. An explicit /handoff exception is reserved for this request; the handoff will start a fresh context once feasible. Write/edit/powershell remain blocked, and bash writes/deletions outside temp blocked stays in effect. After a successful handoff, fresh context resumes in readonly mode.",
		type: "info",
	});
});

test("/handoff in readonly mode ends its user message with the readonly handoff notice", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();

	await handoff.runCommand("handoff", "continue readonly work");

	const { sentUserMessages } = handoff.fixture.host;
	expect(sentUserMessages).toHaveLength(1);
	expectSuffix(
		userMessageText(sentUserMessages[0].content),
		"\n\n[readonly] temporary handoff exception active; write/edit/powershell remain blocked; bash writes/deletions outside temp blocked. Fresh context resumes in readonly mode.",
	);
});

test("readonly blocks a non-requested handoff", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	handoff.setUsage({ tokens: 50_000, percent: 80, contextWindow: 64_000 });

	const blocked = await handoff.toolCall("handoff", { nextInstruction: "must remain in current context" }, "blocked-1");
	expect(blocked).toMatchObject({ block: true });

	expect((await emitTurnEnd(handoff, "blocked-1")).entries, "a blocked handoff leaves no boundary to write").toStrictEqual([]);
});

test("a write sharing a message with handoff keeps its readonly block while the handoff is refused", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.runCommand("handoff", "continue readonly work");
	await handoff.fixture.runner.emitMessageEnd({
		type: "message_end",
		message: assistantMessage([
			{ type: "toolCall", id: "call-handoff", name: "handoff", arguments: {} },
			{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "/tmp/test", content: "x" } },
		]),
	});

	const sibling = await handoff.toolCall("write", { path: "/tmp/test", content: "x" }, "call-write");
	expect(sibling).toStrictEqual({
		block: true,
		reason: "Readonly mode: write/edit blocked until the user disables readonly. Do not attempt alternative write strategies.",
	});
	const refused = await handoff.toolCall("handoff", { nextInstruction: "continue readonly work" }, "call-handoff");
	expect(refused).toStrictEqual({
		block: true,
		reason:
			"Not run: handoff must be the only tool call in its message. The other calls in this message were handled on their own; call handoff alone in your next message.",
		terminate: true,
	});

	expect((await emitTurnEnd(handoff, "call-handoff")).entries, "a refused handoff stages nothing").toStrictEqual([]);
});

test("watchdog cancellation clears the readonly handoff bypass", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.runCommand("handoff", "continue readonly work");

	handoff.setUsage(ELIGIBLE_USAGE);
	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS; i++) {
		await handoff.context("work", i);
		await handoff.agentSettled();
	}

	expect(handoff.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
	expect((await handoff.toolCall("handoff", {}))?.block, "readonly handoff should be blocked after watchdog cancellation").toBe(true);
});

test("after the handoff cut, bypass is cleared and readonly persists", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.runCommand("handoff", "continue readonly work");

	await completeHandoffCut(handoff, "handoff-1", { nextInstruction: "Continue readonly work" });

	expect((await handoff.toolCall("handoff", { nextInstruction: "direct call" }))?.block, "bypass cleared: direct handoff should be blocked").toBe(true);
	expect((await handoff.toolCall("write", { path: "/tmp/test", content: "x" }))?.block, "readonly persists: write should still be blocked after the cut").toBe(
		true,
	);
});

test("the readonly bypass stays until the cut is confirmed on the branch", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.runCommand("handoff", "continue readonly work");

	await stageHandoff(handoff, "handoff-1", { nextInstruction: "Continue readonly work" });
	await submitStagingTurn(handoff, "handoff-1");

	expect(await handoff.toolCall("handoff", {}), "a submitted boundary is not a confirmed cut: the bypass must stay").toBeUndefined();
});

test("retry succeeds after a handoff cut that pi did not persist", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.runCommand("handoff", "continue readonly work");
	const { sentMessages, sentUserMessages } = handoff.fixture.host;

	await stageHandoff(handoff, "handoff-1", { nextInstruction: "Continue readonly work" });
	await submitStagingTurn(handoff, "handoff-1");
	const userMessagesBefore = sentUserMessages.length;
	await handoff.turnStart();

	expect(sentUserMessages, "the failed cut must send no user message").toHaveLength(userMessagesBefore);
	expect(sentMessages.at(-1), "the failed cut must persist the failure guidance, which must not start a run").toMatchObject({
		message: { customType: "pi-schematic-handoff-failed" },
		options: { triggerTurn: false },
	});

	const sameRun = await handoff.toolCall("handoff", { nextInstruction: "retry handoff" });
	expect(sameRun?.block, "a handoff in the run that lost its cut must be blocked").toBe(true);
	expect(sameRun?.reason, "the block must be the boundary's failed-in-run refusal").toBe(
		"Not run: a handoff already failed in this run. Do not call handoff again in this run.",
	);

	// readonly bypass still active
	await handoff.agentSettled();
	expect(
		await handoff.toolCall("handoff", { nextInstruction: "retry handoff" }),
		"the readonly bypass must remain for the retry in the next run",
	).toBeUndefined();

	await expect(
		stageHandoff(handoff, "handoff-retry", { nextInstruction: "retry handoff" }),
		"retry handoff should stage after the failed cut",
	).resolves.toBeUndefined();

	expect(
		(await handoff.toolCall("write", { path: "/tmp/test", content: "x" }))?.block,
		"readonly persists: write should still be blocked after the failed cut",
	).toBe(true);
});

test("an aborted handoff keeps the bypass and persists the failure without starting a run", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();
	await handoff.runCommand("handoff", "continue readonly work");
	const { sentMessages, sentUserMessages } = handoff.fixture.host;

	await stageHandoff(handoff, "handoff-1", { nextInstruction: "Continue readonly work" });
	handoff.setSignal(AbortSignal.abort());
	expect((await emitTurnEnd(handoff, "handoff-1")).entries).toStrictEqual([]);
	handoff.setSignal(undefined);
	const userMessagesBefore = sentUserMessages.length;
	await handoff.agentSettled();

	expect(sentMessages.at(-1)?.message.customType).toBe("pi-schematic-handoff-failed");
	expect(sentMessages.at(-1)?.options?.triggerTurn).toBe(false);
	expect(sentUserMessages, "an abort must not start another run").toHaveLength(userMessagesBefore);
	expect(await handoff.toolCall("handoff", {}), "the readonly bypass must remain for the retry").toBeUndefined();
});

test("/handoff re-enables bypass after the cut", async () => {
	const handoff = await createHandoffRunner();
	await handoff.toggleReadonly();

	await handoff.runCommand("handoff", "first handoff");
	await completeHandoffCut(handoff, "handoff-1", { nextInstruction: "first handoff" });

	await handoff.runCommand("handoff", "second readonly handoff");
	expect(await handoff.toolCall("handoff", { nextInstruction: "second readonly handoff" }), "second /handoff should re-enable the bypass").toBeUndefined();
});

test("the fresh context after a handoff relearns readonly from live state", async () => {
	// Readonly still active at the cut: the fresh context is told again, from live state.
	expect(await handoffCutAcrossReadonlyToggle(true), "the post-handoff turn must relearn readonly from the context hook").toBe(READONLY_ACTIVE_SUMMARY);

	// Readonly dropped before the cut: the fresh context stays silent; OFF-at-cut needs no
	// announcement, while toggles and tree navigation re-announce via rehydration.
	expect(await handoffCutAcrossReadonlyToggle(false), "an OFF-at-cut handoff stays silent").toBeUndefined();
});

test("readonly is re-announced in the next run after a lost-successor failure at turn_start", async () => {
	const handoff = await loseSuccessorAtTurnStart();
	// The continuation request the aborted run still makes takes the pending nudge.
	await handoff.context("aborted continuation", 2);

	await handoff.agentSettled();

	expect(lastReadonlyNudge(await handoff.context("next run", 3))).toBe(READONLY_ACTIVE_SUMMARY);
});

test("session_tree between a lost-successor abort and the settle cancels the readonly re-arm", async () => {
	const handoff = await loseSuccessorAtTurnStart();
	await handoff.fixture.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
	// Drain the announcement the rehydration after the tree navigation queues.
	await handoff.context("after tree", 2);

	await handoff.agentSettled();

	expect(lastReadonlyNudge(await handoff.context("next run", 3))).toBeUndefined();
});

test("readonly topic boundary creates the same bypass contract as explicit /handoff", async () => {
	const handoff = await readonlyTopicBoundary();

	// Context hook should create the bypass from the boundary hint
	handoff.setUsage(ELIGIBLE_USAGE);
	await handoff.context("hi", 2);

	// Same observable contract as explicit /handoff: handoff tool is unblocked
	expect(
		await handoff.toolCall("handoff", { nextInstruction: "continue billing work" }),
		"handoff should be unblocked after topic boundary creates bypass",
	).toBeUndefined();
	// write and non-temp bash mutations stay blocked
	expect((await handoff.toolCall("write", { path: "/tmp/test", content: "x" }))?.block, "write should stay blocked").toBe(true);
	await assertNonTempBashBlocked(handoff);
});

test("promoted readonly boundary preserves bypass across execute-time eligibility failures", async () => {
	const handoff = await readonlyTopicBoundary();
	handoff.setUsage(ELIGIBLE_USAGE);
	await handoff.context("promote", 2);

	for (const { usage, message } of [
		{ usage: undefined, message: /Context usage unavailable/ },
		{ usage: { tokens: 5000, percent: 2.5, contextWindow: 200000 }, message: /handoff unavailable yet/ },
	]) {
		handoff.setUsage(usage);
		await expect(handoff.fixture.tool("handoff").execute("boundary-retry", { nextInstruction: "continue billing" })).rejects.toThrow(message);
		expect(await handoff.toolCall("handoff", {}), "execute-time rejection must preserve the promoted readonly bypass").toBeUndefined();
	}

	await completeHandoffCut(handoff, "boundary-success", { nextInstruction: "continue billing" });
	expect((await handoff.toolCall("handoff", {}))?.block).toBe(true);
});

test("readonly topic boundary promotion exposes the handoff status", async () => {
	const handoff = await readonlyTopicBoundary();
	handoff.setUsage(ELIGIBLE_USAGE);

	await handoff.context("continue", 2);

	const { statuses, notifications } = handoff.fixture.ui;
	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff required — ready to compact"));
	expect(notifications.at(-1)).toStrictEqual({
		message:
			"Readonly topic boundary detected. The handoff exception is now active because context usage is eligible; complete the handoff before continuing normal work.",
		type: "warning",
	});
});

test("readonly topic boundary stays advisory until handoff is eligible", async () => {
	const handoff = await readonlyTopicBoundary();

	const result = await handoff.context("continue", 2);

	expect(lastMessageContent(result)).toMatch(/topic changed/i);
	expect(lastMessageContent(result)).not.toMatch(/call handoff/i);
	expect((await handoff.toolCall("handoff", {}))?.block, "ineligible boundary must not unblock handoff").toBe(true);
});

test("readonly human topic boundary promotes exactly at the token threshold without repeated advisory nudges", async () => {
	const handoff = await readonlyTopicBoundary();

	handoff.setUsage({ tokens: 29_999, percent: 15, contextWindow: 200000 });
	const first = await handoff.context("still small", 2);
	expect(lastMessageContent(first)).toMatch(/topic changed/i);
	expect((await handoff.toolCall("handoff", {}))?.block).toBe(true);

	const second = await handoff.context("still ineligible", 3);
	expect(second, "an ineligible boundary should not repeat its advisory nudge").toStrictEqual([{ role: "user", content: "still ineligible", timestamp: 3 }]);

	handoff.setUsage({ tokens: 30_000, percent: 15, contextWindow: 200000 });
	await handoff.context("now eligible", 4);
	expect(await handoff.toolCall("handoff", {})).toBeUndefined();
});

test("readonly topic boundary handoff clears its bypass after the cut", async () => {
	const handoff = await readonlyTopicBoundary();
	handoff.setUsage(ELIGIBLE_USAGE);
	await handoff.context("handoff", 2);

	const drafts = await completeHandoffCut(handoff, "boundary-handoff", { nextInstruction: "Continue billing work" });

	expect(compactionSummary(drafts), "readonly must not be frozen into the summary").toBe(CONTINUATION_FRAME);
	expectPrefix(successorContent(drafts), "## Next instruction\n\nContinue billing work", "the successor turn carries the stored direction verbatim");
	expect((await handoff.toolCall("handoff", {}))?.block).toBe(true);
	expect((await handoff.toolCall("write", {}))?.block).toBe(true);
});

test("session tree drops a staged handoff, releases the overlap guard, and a stale turn_end writes no cut", async () => {
	const handoff = await createHandoffRunner();

	await stageHandoff(handoff, "branch-handoff", { nextInstruction: "continue branch work" });
	expect(handoff.fixture.ui.statuses.get(STATUS_KEY_HANDOFF), "staging shows the in-progress status").toBeDefined();
	handoff.setUsage(undefined);
	await handoff.fixture.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });

	expect(handoff.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
	expect(await handoff.toolCall("handoff", {}), "non-readonly branch should not retain a stale readonly handoff block").toBeUndefined();

	expect((await emitTurnEnd(handoff, "branch-handoff")).entries, "the dropped handoff must not write a cut").toStrictEqual([]);

	const drafts = await completeHandoffCut(handoff, "fresh-branch-handoff", { nextInstruction: "continue fresh branch work" });
	expect(handoff.fixture.host.sentUserMessages, "the dropped handoff reports no failure and the fresh one completes").toHaveLength(0);
	expectPrefix(successorContent(drafts), "## Next instruction\n\ncontinue fresh branch work", "the fresh branch must receive its own instruction");
});
