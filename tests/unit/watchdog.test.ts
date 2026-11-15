import { expect, test } from "vitest";
import { SessionManager, type ContextUsage, type ExtensionFactory, type ExtensionRunner, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createState } from "../../state.js";
import { registerWatchdog, MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import { buildNudge } from "../../watchdog.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { registerHandoffBoundary } from "../../handoff/boundary.js";
import { assertPresent } from "../assertions.js";
import { createRunner, type RunnerFixture } from "../support/runner.js";
import { appendDrafts } from "../support/session.js";
import { realTheme } from "../support/theme.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { MIN_HANDOFF_TOKENS } from "../../handoff/eligibility.js";

type ContextMessage = Awaited<ReturnType<ExtensionRunner["emitContext"]>>[number];

type CustomContextMessage = Extract<ContextMessage, { role: "custom" }>;

/**
 * Usage with only `percent` set: unknown tokens and a zero context window give no
 * token estimate, so the percentage alone drives the watchdog and the session is
 * never handoff-eligible. pi never reports a zero context window; the shape is
 * synthetic, because a real window would make the percentage eligible from 15%.
 */
function percentUsage(percent: number): ContextUsage {
	return { tokens: null, contextWindow: 0, percent };
}

function userMessages(content: string, timestamp: number): ContextMessage[] {
	return [{ role: "user", content, timestamp }];
}

/** A runner fixture whose context usage, abort signal and session the test sets between emits. */
interface WatchdogRunner {
	fixture: RunnerFixture;
	session: SessionManager;
	setUsage: (usage: ContextUsage | undefined) => void;
	setSignal: (signal: AbortSignal | undefined) => void;
}

/**
 * The extension (or `factories`) on a runner with an idle session, the usage and signal the test
 * sets, an in-memory session and, unless `headless`, the recording UI in TUI mode with the real Theme.
 */
async function createWatchdogRunner(options: { factories?: ExtensionFactory[]; headless?: boolean } = {}): Promise<WatchdogRunner> {
	let usage: ContextUsage | undefined;
	let signal: AbortSignal | undefined;
	const cwd = process.cwd();
	const session = SessionManager.inMemory(cwd);
	const fixture = await createRunner({
		cwd,
		factories: options.factories,
		sessionManager: session,
		context: {
			getContextUsage: () => usage,
			getSignal: () => signal,
			isIdle: () => true,
		},
		mode: options.headless === true ? "print" : "tui",
		ui: options.headless === true ? undefined : { theme: realTheme },
	});
	return {
		fixture,
		session,
		setUsage: (next) => {
			usage = next;
		},
		setSignal: (next) => {
			signal = next;
		},
	};
}

/** Runs the context hook on one user message, with `usage` as the session's context usage. */
async function runContext({ fixture, setUsage }: WatchdogRunner, usage: ContextUsage | undefined, content = "hi", timestamp = 1): Promise<ContextMessage[]> {
	setUsage(usage);
	return fixture.runner.emitContext(userMessages(content, timestamp));
}

async function runCommand({ fixture }: WatchdogRunner, name: string, args: string): Promise<void> {
	await fixture.command(name).handler(args, fixture.runner.createCommandContext());
}

async function emitAgentEnd({ fixture }: WatchdogRunner): Promise<void> {
	await fixture.runner.emit({ type: "agent_end", messages: [] });
}

async function emitAgentSettled({ fixture }: WatchdogRunner, aborted = false): Promise<void> {
	await fixture.runner.emit({ type: "agent_settled", aborted });
}

function watchdogRegistration(state: ReturnType<typeof createState>): ExtensionFactory[] {
	return [
		(api) => {
			registerWatchdog(api, state);
		},
	];
}

test("watchdog records context usage without user notifications", async () => {
	const state = createState();
	const runner = await createWatchdogRunner({ factories: watchdogRegistration(state) });
	runner.setUsage(percentUsage(70));

	await emitAgentEnd(runner);

	expect(runner.fixture.ui.notifications).toStrictEqual([]);
	expect(state.lastContextPercent).toBe(70);
});

test.for([Number.NaN, Number.POSITIVE_INFINITY, -1])("watchdog ignores malformed percentages: %s", async (percent) => {
	const state = createState();
	const runner = await createWatchdogRunner({ factories: watchdogRegistration(state), headless: true });
	runner.setUsage(percentUsage(percent));
	await emitAgentEnd(runner);
	expect(state.lastContextPercent).toBeNull();
});

test("watchdog records overflow percentages", async () => {
	const state = createState();
	const runner = await createWatchdogRunner({ factories: watchdogRegistration(state), headless: true });
	runner.setUsage({ tokens: 250_000, contextWindow: 200_000, percent: 125 });
	await emitAgentEnd(runner);
	expect(state.lastContextPercent).toBe(125);
});

/** Asserts `message` is the hidden watchdog reminder and narrows it to a custom message. */
function assertWatchdogReminder(message: ContextMessage | undefined): asserts message is CustomContextMessage {
	expect(message).toMatchObject({ role: "custom", customType: "pi-schematic-watchdog", display: false });
}

/** The message the context hook returned at `index` (negative counts from the end); throws unless it is a custom message. */
function customMessageAt(messages: ContextMessage[], index: number): CustomContextMessage {
	const message = messages.at(index);
	if (message?.role !== "custom") {
		throw new Error(`The context hook returned no custom message at index ${String(index)}.`);
	}
	return message;
}

/** The custom message of `customType` the context hook returned, or undefined when it returned none. */
function findCustomMessage(messages: ContextMessage[], customType: string): CustomContextMessage | undefined {
	return messages.find((message): message is CustomContextMessage => message.role === "custom" && message.customType === customType);
}

async function injectReminderAt(tokens: number, percent: number): Promise<ContextMessage[]> {
	const contextWindow = Math.round((tokens * 100) / percent);
	const runner = await createWatchdogRunner({ headless: true });
	await runCommand(runner, "notebook", "oauth");

	return runContext(runner, { tokens, contextWindow, percent });
}

test("context injects watchdog reminder before each LLM call", async () => {
	const messages = await injectReminderAt(MIN_HANDOFF_TOKENS - 1, 70);

	expect(messages).toHaveLength(2);
	const [first, reminder] = messages;
	expect(first).toStrictEqual({ role: "user", content: "hi", timestamp: 1 });
	assertWatchdogReminder(reminder);
	expect(reminder.content).toMatch(/70%/);
	expect(reminder.content).toMatch(/oauth/);
	expect(reminder.content).toMatch(/spawn/i);
	expect(reminder.content).toMatch(/parent context/i);
	expect(reminder.content).not.toMatch(/draft a clear prompt|what comes next/i);
});

test("below the handoff minimum the reminder asks to continue instead of preferring a handoff", async () => {
	// One token below the handoff minimum, so the reminder does not prefer a handoff.
	const [, reminder] = await injectReminderAt(MIN_HANDOFF_TOKENS - 1, 70);

	assertWatchdogReminder(reminder);
	expect(reminder.content).toContain("continue working until handoff is available");
	expect(reminder.content).not.toContain("prefer a deliberate handoff");
});

test.for([Number.NaN, Number.POSITIVE_INFINITY, -1])("context treats malformed percentages as unavailable: %s", async (percent) => {
	const runner = await createWatchdogRunner({ headless: true });

	const result = await runContext(runner, percentUsage(percent));

	expect(result).toStrictEqual(userMessages("hi", 1));
});

test("context injects a no-topic nudge when context is high", async () => {
	const runner = await createWatchdogRunner({ headless: true });

	const result = await runContext(runner, percentUsage(70));

	expect(result).toHaveLength(2);
	const reminder = result[1];
	assertWatchdogReminder(reminder);
	expect(reminder.content).toMatch(/no active notebook topic/i);
	expect(reminder.content).toMatch(/fresh topic/i);
	expect(reminder.content).toMatch(/handoff/i);
});

test("context nudges at band crossings and after a below-30% reset", async () => {
	const runner = await createWatchdogRunner({ headless: true });
	const nudge = [expect.objectContaining({ role: "custom", customType: "pi-schematic-watchdog" })];
	const steps: [percent: number, injected: unknown[]][] = [
		[29, []],
		[30, nudge],
		[49, []],
		[50, nudge],
		[69, []],
		[70, nudge],
		[29, []],
		[30, nudge],
	];

	for (const [percent, injected] of steps) {
		const result = await runContext(runner, percentUsage(percent), `at ${percent}`, percent);
		expect(result, `watchdog nudge at ${percent}%`).toStrictEqual([...userMessages(`at ${percent}`, percent), ...injected]);
	}
});

test("context consumes a boundary hint after the first injected nudge", async () => {
	const runner = await createWatchdogRunner({ headless: true });
	await runCommand(runner, "notebook", "oauth");
	await runCommand(runner, "notebook", "billing");

	const first = customMessageAt(await runContext(runner, percentUsage(20)), 1);
	expect(first.display).toBe(false);
	expect(first.content).toMatch(/oauth/i);
	expect(first.content).toMatch(/billing/i);
	expect(first.content).toMatch(/topic changed/i);

	const second = await runContext(runner, percentUsage(20), "hi", 2);
	expect(second).toStrictEqual(userMessages("hi", 2));
});

test("buildNudge emits topic and spawn guidance", () => {
	const nudge = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null, readonlyEnabled: false, pendingRequestedHandoff: null }, 46, false);
	expect(nudge).toMatch(/Active notebook topic: oauth/);
	expect(nudge).toMatch(/prefer spawn/i);
});

test("buildNudge does not require an ineligible pending handoff by default", () => {
	const nudge = buildNudge(
		{
			activeNotebookTopic: null,
			pendingTopicBoundaryHint: null,
			readonlyEnabled: false,
			pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null },
		},
		null,
		false,
	);
	expect(nudge).toMatch(/not yet ready for compaction/i);
});

test("buildNudge asks an eligible requested handoff for the next instruction and the remaining context", () => {
	const requested = buildNudge(
		{
			activeNotebookTopic: null,
			pendingTopicBoundaryHint: null,
			readonlyEnabled: false,
			pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null },
		},
		30,
		true,
	);
	expect(requested).toMatch(/real handoff is required/i);
	expect(requested).toMatch(/do not perform the new instruction here/i);
	expect(requested).toMatch(/call handoff with the next instruction and the remaining context/i);
});

test("buildNudge asks a requested handoff with a set instruction for only the remaining context", () => {
	const directed = buildNudge(
		{
			activeNotebookTopic: null,
			pendingTopicBoundaryHint: null,
			readonlyEnabled: false,
			pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: "continue work" },
		},
		30,
		true,
	);
	expect(directed).toMatch(/call handoff with only the remaining context/i);
	expect(directed).toMatch(/successor receives the instruction verbatim/i);
	expect(directed).not.toMatch(/next instruction and the remaining context/i);
});

test("buildNudge asks an eligible topic boundary for a handoff with the next instruction", () => {
	const boundary = buildNudge(
		{
			activeNotebookTopic: "billing",
			pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
			readonlyEnabled: false,
			pendingRequestedHandoff: null,
		},
		30,
		true,
	);
	expect(boundary).toMatch(/task-boundary signal/i);
	expect(boundary).toMatch(/next instruction/i);
	expect(boundary).toMatch(/remaining context/i);
	expect(boundary).toMatch(/call handoff/i);
});

test("buildNudge handles null percent and boundary hints before topic guidance", () => {
	const boundary = buildNudge(
		{
			activeNotebookTopic: "oauth",
			pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
			readonlyEnabled: false,
			pendingRequestedHandoff: null,
		},
		null,
		false,
	);
	expect(boundary).toMatch(/Notebook topic changed from oauth to billing/);
	expect(boundary).not.toMatch(/Active notebook topic: oauth/);

	const noTopic = buildNudge({ activeNotebookTopic: null, pendingTopicBoundaryHint: null, readonlyEnabled: false, pendingRequestedHandoff: null }, null, false);
	expect(noTopic).toMatch(/Topic-aware context reminder/);
	expect(noTopic).toMatch(/No active notebook topic is set/);
});

/** Stand in for the context hook injecting the eligible required-handoff nudge during the current run. */
function deliverEligibleNudge(state: ReturnType<typeof createState>): void {
	assertPresent(state.pendingRequestedHandoff, "a handoff is requested");
	state.pendingRequestedHandoff.eligibleNudgeDelivered = true;
}

async function createPendingHandoffHost() {
	const state = createState();
	const runner = await createWatchdogRunner({
		factories: [
			(api) => {
				registerHandoffCommand(api, state);
				registerWatchdog(api, state);
			},
		],
	});
	await runCommand(runner, "handoff", "implement auth");
	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	runner.setUsage(eligibleUsage());
	return { state, runner };
}

const eligibleUsage = (): ContextUsage => ({ tokens: 50000, percent: 25, contextWindow: 200000 });

/** Runner with the handoff command, tool, boundary and watchdog registered in the extension's order. */
async function createStagingHost() {
	const state = createState();
	const runner = await createWatchdogRunner({
		factories: [
			(api) => {
				registerHandoffCommand(api, state);
				registerHandoffTool(api, state);
				registerHandoffBoundary(api, state);
				registerWatchdog(api, state);
			},
		],
	});
	return { state, runner };
}

async function stageHandoff(runner: WatchdogRunner, toolCallId: string): Promise<void> {
	runner.setUsage(eligibleUsage());
	await runner.fixture.tool("handoff").execute(toolCallId, { nextInstruction: "continue work" });
}

/** A tool result message for `toolCallId`, as pi passes it in `TurnEndEvent.toolResults`. */
function handoffToolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "handoff",
		content: [{ type: "text", text: "Handoff staged." }],
		isError: false,
		timestamp: 0,
	};
}

/** End the staging turn through pi's boundary chain and return the entries the handlers asked pi to commit. */
async function endStagingTurn(runner: WatchdogRunner, toolCallId: string): Promise<SessionBoundaryDraft[]> {
	runner.setUsage(eligibleUsage());
	const { entries } = await runner.fixture.runner.emitBoundary(
		{
			type: "turn_end",
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			toolResults: [handoffToolResult(toolCallId)],
			messageEntryId: "assistant-entry",
			toolResultEntryIds: [],
			outcome: "completed",
		},
		() => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true }),
	);
	return entries;
}

test("a staged handoff that completes at the settle is neither counted nor cancelled", async () => {
	const { state, runner } = await createStagingHost();
	await runCommand(runner, "handoff", "continue work");
	runner.setUsage(eligibleUsage());
	// Spend all but the last attempt so a miscount would cancel the request.
	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS - 1; i++) {
		deliverEligibleNudge(state);
		await emitAgentSettled(runner);
	}
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(MAX_HANDOFF_ATTEMPTS - 1);

	const userMessagesBeforeRun = runner.fixture.host.sentUserMessages.length;
	deliverEligibleNudge(state);
	await stageHandoff(runner, "in-flight");
	const drafts = await endStagingTurn(runner, "in-flight");
	expect(drafts, "the staging turn_end must return boundary entries").not.toStrictEqual([]);
	appendDrafts(runner.session, drafts);
	await emitAgentSettled(runner);

	expect(state.pendingRequestedHandoff, "the confirmed cut clears the request").toBeNull();
	expect(runner.fixture.ui.notifications.filter(({ message }) => /Required handoff cancelled/i.test(message))).toStrictEqual([]);
	expect(runner.fixture.host.sentUserMessages, "a completed handoff sends no failure guidance").toHaveLength(userMessagesBeforeRun);
});

test("watchdog auto-cancels a required handoff after enough unanswered settled runs", async () => {
	const { state, runner } = await createPendingHandoffHost();
	const { ui } = runner.fixture;

	// Runs without the eligible nudge do not consume the cancellation budget.
	for (let i = 0; i < 3; i++) {
		await emitAgentSettled(runner);
	}
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(0);

	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS - 1; i++) {
		deliverEligibleNudge(state);
		await emitAgentSettled(runner);
	}
	assertPresent(state.pendingRequestedHandoff, "handoff must remain pending before the final attempt");
	expect(ui.notifications, "cancellation must not notify early").toStrictEqual([]);
	expect(ui.statuses.get(STATUS_KEY_HANDOFF), "the pending handoff shows its status").toBe(
		realTheme.fg("accent", "🤝 Handoff requested — waiting for eligible context"),
	);

	deliverEligibleNudge(state);
	await emitAgentSettled(runner);
	expect(state.pendingRequestedHandoff, "pending handoff should be auto-cancelled").toBeNull();
	expect(ui.statuses.get(STATUS_KEY_HANDOFF), "cancellation should clear the handoff status").toBeUndefined();
	expect(ui.notifications, "user should receive a cancellation notification").toHaveLength(1);
	expect(ui.notifications[0].message, "notification should mention cancellation without source-specific wording").toMatch(/Required handoff cancelled/i);
	expect(ui.notifications[0].message).not.toMatch(/user-requested|temporary bypass/i);
});

test("a nudged run whose staged handoff cut was not persisted counts one attempt", async () => {
	const { state, runner } = await createStagingHost();
	await runCommand(runner, "handoff", "continue work");

	deliverEligibleNudge(state);
	await stageHandoff(runner, "dropped-cut");
	expect(state.pendingRequestedHandoff?.toolCalled, "staging marks the handoff called").toBe(true);
	await endStagingTurn(runner, "dropped-cut");

	const { sentMessages, sentUserMessages } = runner.fixture.host;
	const userMessagesBeforeSettle = sentUserMessages.length;
	await emitAgentSettled(runner);

	expect(state.pendingRequestedHandoff?.toolCalled, "the failure resets toolCalled before the watchdog counts").toBe(false);
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
	expect(sentUserMessages, "a dropped cut starts no run").toHaveLength(userMessagesBeforeSettle);
	expect(sentMessages.at(-1)?.message.customType).toBe("pi-schematic-handoff-failed");
	expect(sentMessages.at(-1)?.options?.triggerTurn).toBe(false);
});

test("a nudged run whose handoff was aborted counts one attempt and starts no run", async () => {
	const { state, runner } = await createStagingHost();
	await runCommand(runner, "handoff", "continue work");

	deliverEligibleNudge(state);
	await stageHandoff(runner, "aborted-cut");
	runner.setSignal(AbortSignal.abort());
	await endStagingTurn(runner, "aborted-cut");
	runner.setSignal(undefined);
	const { sentMessages, sentUserMessages } = runner.fixture.host;
	const userMessagesBeforeSettle = sentUserMessages.length;
	await emitAgentSettled(runner);

	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
	expect(sentUserMessages, "an abort must not start another run").toHaveLength(userMessagesBeforeSettle);
	expect(sentMessages.at(-1)?.message.customType).toBe("pi-schematic-handoff-failed");
	expect(sentMessages.at(-1)?.options?.triggerTurn).toBe(false);
});

test("agent_end events within a run add no attempt", async () => {
	const { state, runner } = await createPendingHandoffHost();

	// One run whose first attempt failed and was retried automatically, then a second run.
	deliverEligibleNudge(state);
	await emitAgentEnd(runner);
	await emitAgentEnd(runner);
	expect(state.pendingRequestedHandoff?.enforcementAttempts, "agent_end must not count an attempt").toBe(0);
	await emitAgentSettled(runner);
	deliverEligibleNudge(state);
	await emitAgentEnd(runner);
	await emitAgentSettled(runner);

	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(2);
});

test("a settled run without the eligible nudge does not count", async () => {
	const { state, runner } = await createPendingHandoffHost();

	await emitAgentSettled(runner);
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(0);

	deliverEligibleNudge(state);
	await emitAgentSettled(runner);
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
});

test("the eligible nudge counts once per settled run", async () => {
	const { state, runner } = await createPendingHandoffHost();

	deliverEligibleNudge(state);
	await emitAgentSettled(runner);
	await emitAgentSettled(runner);

	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
	expect(state.pendingRequestedHandoff?.eligibleNudgeDelivered).toBe(false);
});

test("an aborted settle after the eligible nudge counts as an attempt", async () => {
	const { state, runner } = await createPendingHandoffHost();

	deliverEligibleNudge(state);
	await emitAgentSettled(runner, true);

	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
});

// Full-extension runs: the real context hook decides whether the eligible nudge was delivered.
async function createRequestedHandoffSession() {
	const runner = await createWatchdogRunner();
	await runCommand(runner, "handoff", "implement auth");
	const warnings = (): string[] => runner.fixture.ui.notifications.filter(({ type }) => type === "warning").map(({ message }) => message);
	const runContextHook = async (usage: ContextUsage): Promise<string> => {
		const nudge = findCustomMessage(await runContext(runner, usage, "work", 1), "pi-schematic-watchdog");
		if (typeof nudge?.content !== "string") {
			throw new Error("The context hook injected no watchdog nudge text.");
		}
		return nudge.content;
	};
	const settle = async (usage: ContextUsage): Promise<void> => {
		runner.setUsage(usage);
		await emitAgentSettled(runner);
	};
	return { warnings, runContextHook, settle };
}

test("a run nudged while eligible counts when it settles after compaction", async () => {
	const { warnings, runContextHook, settle } = await createRequestedHandoffSession();
	// After compaction pi reports unknown token counts until the next assistant response.
	const postCompactionUsage: ContextUsage = { tokens: null, contextWindow: 200000, percent: null };

	for (let run = 1; run < MAX_HANDOFF_ATTEMPTS; run++) {
		expect(await runContextHook(eligibleUsage())).toMatch(/A real handoff is required/);
		await settle(postCompactionUsage);
		expect(warnings(), `cancellation must not warn after run ${run}`).toStrictEqual([]);
	}

	await runContextHook(eligibleUsage());
	await settle(postCompactionUsage);
	expect(warnings()).toHaveLength(1);
	expect(warnings()[0]).toMatch(/Required handoff cancelled/i);
});

test("a run nudged only to keep working does not count", async () => {
	const { warnings, runContextHook, settle } = await createRequestedHandoffSession();
	const ineligibleUsage = { tokens: 5000, percent: 2.5, contextWindow: 200000 };

	for (let run = 0; run < MAX_HANDOFF_ATTEMPTS + 1; run++) {
		expect(await runContextHook(ineligibleUsage)).toMatch(/not yet ready for compaction/);
		await settle(eligibleUsage());
	}

	expect(warnings()).toStrictEqual([]);
});

test("agent_settled does not record context usage", async () => {
	const state = createState();
	const runner = await createWatchdogRunner({ factories: watchdogRegistration(state), headless: true });
	runner.setUsage(percentUsage(70));

	await emitAgentSettled(runner);

	expect(state.lastContextPercent).toBeNull();
});

// ── Readonly-specific injection contracts ─────────────────────────

async function drainReadonlyNudge(runner: WatchdogRunner): Promise<void> {
	await runContext(runner, undefined, "drain initial readonly nudge");
}

test("context hook suppresses watchdog after readonly toggle nudge is drained", async () => {
	const runner = await createWatchdogRunner();
	await runCommand(runner, "readonly", "");

	// First call: drain the one-shot toggle nudge
	await runContext(runner, undefined, "first");

	// Repeated calls across watchdog bands remain silent while readonly is active.
	for (const percent of [70, 30, 50, 80]) {
		const result = await runContext(runner, percentUsage(percent), `second at ${percent}`, percent);
		expect(result, `watchdog must be suppressed at ${percent}% in readonly mode`).toStrictEqual(userMessages(`second at ${percent}`, percent));
	}
});

test("context injects a readonly-mode nudge after toggle", async () => {
	const runner = await createWatchdogRunner();
	await runCommand(runner, "readonly", "");

	const result = await runContext(runner, undefined);

	expect(result).toHaveLength(2);
	const nudge = customMessageAt(result, 1);
	expect(nudge.customType).toBe("pi-schematic-readonly-nudge");
	expect(nudge.content).toMatch(/readonly/i);
	expect(nudge.content).toMatch(/write\/edit\/powershell blocked/i);
	expect(nudge.content).toMatch(/bash writes/i);
	expect(nudge.content).toMatch(/handoff/i);
});

test("context injects readonly handoff guidance after explicit user /handoff", async () => {
	const runner = await createWatchdogRunner();
	await runCommand(runner, "readonly", "");
	await drainReadonlyNudge(runner);
	await runCommand(runner, "handoff", "continue readonly work");

	const result = await runContext(runner, eligibleUsage(), "hi", 2);
	const watchdogMessage = findCustomMessage(result, "pi-schematic-watchdog");

	assertPresent(watchdogMessage, "requested handoff should inject watchdog guidance");
	expect(watchdogMessage.content).toMatch(/handoff/i);
	expect(watchdogMessage.content).toMatch(/readonly/i);
	expect(watchdogMessage.content).toMatch(/temporary handoff exception active/i);
	expect(watchdogMessage.content).toMatch(/write\/edit\/powershell remain blocked/i);
	expect(watchdogMessage.content).toMatch(/fresh context resumes in readonly mode|resumes readonly mode/i);
	expect(watchdogMessage.content).not.toMatch(/User explicitly requested|this request only/i);
});

test("readonly toggle nudge aligns with handoff exception in the same turn", async () => {
	const runner = await createWatchdogRunner();
	await runCommand(runner, "readonly", "");
	await runCommand(runner, "handoff", "continue readonly work");

	const result = await runContext(runner, eligibleUsage(), "hi", 2);
	const readonlyMessage = findCustomMessage(result, "pi-schematic-readonly-nudge");
	const watchdogMessage = findCustomMessage(result, "pi-schematic-watchdog");

	assertPresent(readonlyMessage, "readonly toggle should still emit its one-shot nudge");
	assertPresent(watchdogMessage, "handoff guidance should still be injected");
	expect(readonlyMessage.content).toMatch(/temporary handoff exception active/i);
	expect(readonlyMessage.content).toMatch(/write\/edit\/powershell remain blocked/i);
	expect(readonlyMessage.content).not.toMatch(/handoff blocked/i);
	expect(watchdogMessage.content).toMatch(/temporary handoff exception active/i);
});

test("eligible readonly human topic boundary auto-creates handoff bypass equivalent to /handoff", async () => {
	const runner = await createWatchdogRunner();

	await runCommand(runner, "readonly", "");
	await drainReadonlyNudge(runner);
	await runCommand(runner, "notebook", "oauth");
	await runCommand(runner, "notebook", "billing");

	const result = await runContext(runner, eligibleUsage(), "hi", 2);

	// An eligible topic boundary in readonly mode creates the handoff bypass and injects
	// watchdog guidance — equivalent to explicit /handoff or a human topic boundary.
	const watchdogMessage = findCustomMessage(result, "pi-schematic-watchdog");
	assertPresent(watchdogMessage, "watchdog message should be present");
	expect(watchdogMessage.content).toMatch(/handoff/i);
	expect(watchdogMessage.content).toMatch(/temporary handoff exception active/i);

	const blockResult = await runner.fixture.runner.emitToolCall({ type: "tool_call", toolCallId: "handoff-call", toolName: "handoff", input: {} });
	expect(blockResult, "handoff tool should be unblocked after topic boundary creates bypass").toBeUndefined();
});
