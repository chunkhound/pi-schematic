import { expect, test } from "vitest";
import fc from "fast-check";
import { createState } from "../../state.js";
import { registerWatchdog, MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import { buildNudge } from "../../watchdog.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { registerHandoffBoundary } from "../../handoff/boundary.js";
import {
	callHandlers,
	createCommandContext,
	createExtensionContext,
	createToolContext,
	createUIContext,
	emitAll,
	handoffToolResult,
	makeReadonlyUICtx,
	registerReadonlyPI,
	turnEndEvent,
} from "./helpers.js";
import { assertPresent } from "../assertions.js";
import { createTestHost, getCommand, getHandler, getHandlers, getHostRecords, getTool, invokeHandler } from "./test-host.js";
import type { TestPI } from "./test-host.js";
import type {
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	ExtensionCommandContext,
	SessionBoundaryDraft,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { MIN_HANDOFF_TOKENS } from "../../handoff/eligibility.js";

/**
 * Usage with only `percent` set: unknown tokens and a zero context window give no
 * token estimate, so the percentage alone drives the watchdog and the session is
 * never handoff-eligible. pi never reports a zero context window; the shape is
 * synthetic, because a real window would make the percentage eligible from 15%.
 */
function percentUsage(percent: number): ContextUsage {
	return { tokens: null, contextWindow: 0, percent };
}

function contextEvent(content: string, timestamp: number): ContextEvent {
	return { type: "context", messages: [{ role: "user", content, timestamp }] };
}

/** Runs the first context handler on one user message, with `usage` as the session's context usage. */
async function runContext(pi: TestPI, usage: ContextUsage | undefined, content = "hi", timestamp = 1): Promise<ContextEventResult | undefined> {
	return invokeHandler(pi, "context", contextEvent(content, timestamp), createExtensionContext({ getContextUsage: () => usage }));
}

/** A command context with UI for an idle session; notifications, statuses and widgets go nowhere. */
function idleUICommandContext(): ExtensionCommandContext {
	const ignore = (): void => undefined;
	return createCommandContext({
		hasUI: true,
		ui: createUIContext({ notify: ignore, setStatus: ignore, setWidget: ignore }),
		getContextUsage: () => undefined,
		isIdle: () => true,
	});
}

test("watchdog records context usage without user notifications", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerWatchdog(api, state); });
	const handler = getHandler(pi, "agent_end");

	const notifications: string[] = [];
	await handler(
		{ type: "agent_end", messages: [] },
		createExtensionContext({
			hasUI: true,
			ui: createUIContext({ notify: (message: string) => notifications.push(message) }),
			getContextUsage: () => percentUsage(70),
		}),
	);

	expect(notifications).toStrictEqual([]);
	expect(state.lastContextPercent).toBe(70);
});

test.for([Number.NaN, Number.POSITIVE_INFINITY, -1])("watchdog ignores malformed percentages: %s", async (percent) => {
	const state = createState();
	const pi = await createTestHost((api) => { registerWatchdog(api, state); });
	const handler = getHandler(pi, "agent_end");
	await handler({ type: "agent_end", messages: [] }, createExtensionContext({ getContextUsage: () => percentUsage(percent) }));
	expect(state.lastContextPercent).toBeNull();
});

test("watchdog records overflow percentages", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerWatchdog(api, state); });
	const handler = getHandler(pi, "agent_end");
	await handler(
		{ type: "agent_end", messages: [] },
		createExtensionContext({ getContextUsage: () => ({ tokens: 250_000, contextWindow: 200_000, percent: 125 }) }),
	);
	expect(state.lastContextPercent).toBe(125);
});

type ContextMessage = NonNullable<ContextEventResult["messages"]>[number];

type CustomContextMessage = Extract<ContextMessage, { role: "custom" }>;

/** Asserts `message` is the hidden watchdog reminder and narrows it to a custom message. */
function assertWatchdogReminder(message: ContextMessage | undefined): asserts message is CustomContextMessage {
	expect(message).toMatchObject({ role: "custom", customType: "pi-schematic-watchdog", display: false });
}

// The messages the context hook returned; throws when it returned none.
function resultMessages(result: ContextEventResult | undefined): ContextMessage[] {
	if (result?.messages === undefined) {throw new Error("The context hook returned no messages.");}
	return result.messages;
}

/** The message the context hook returned at `index` (negative counts from the end); throws unless it is a custom message. */
function customMessageAt(result: ContextEventResult | undefined, index: number): CustomContextMessage {
	const message = resultMessages(result).at(index);
	if (message?.role !== "custom") {throw new Error(`The context hook returned no custom message at index ${String(index)}.`);}
	return message;
}

/** The custom message of `customType` the context hook returned, or undefined when it returned none. */
function findCustomMessage(result: ContextEventResult | undefined, customType: string): CustomContextMessage | undefined {
	return resultMessages(result).find((message): message is CustomContextMessage => message.role === "custom" && message.customType === customType);
}

test("context injects watchdog reminder before each LLM call", async () => {
	// One token below the handoff minimum, so the reminder does not prefer a handoff.
	const tokens = MIN_HANDOFF_TOKENS - 1;
	const percent = 70;
	const contextWindow = Math.round((tokens * 100) / percent);
	const pi = await createTestHost();
	await getCommand(pi, "notebook").handler("oauth", createCommandContext());

	const result = await invokeHandler(
		pi,
		"context",
		{ type: "context", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		createExtensionContext({ getContextUsage: () => ({ tokens, contextWindow, percent }) }),
	);

	assertPresent(result);
	const { messages } = result;
	assertPresent(messages);
	expect(messages).toHaveLength(2);
	const [first, reminder] = messages;
	expect(first).toStrictEqual({ role: "user", content: "hi", timestamp: 1 });
	assertWatchdogReminder(reminder);
	expect(reminder.content).toMatch(/70%/);
	expect(reminder.content).toMatch(/oauth/);
	expect(reminder.content).toMatch(/spawn/i);
	expect(reminder.content).toMatch(/parent context/i);
	expect(reminder.content).not.toMatch(/draft a clear prompt|what comes next/i);
	expect(reminder.content).toContain("continue working until handoff is available");
	expect(reminder.content).not.toContain("prefer a deliberate handoff");
});


test("context injects a boundary nudge below 30% after an explicit topic change", async () => {
	const pi = await createTestHost();
	await getCommand(pi, "notebook").handler("oauth", createCommandContext({ getContextUsage: () => undefined }));
	await getCommand(pi, "notebook").handler("billing", createCommandContext({ getContextUsage: () => undefined }));

	const nudge = customMessageAt(await runContext(pi, percentUsage(20)), 1);

	expect(nudge.display).toBe(false);
	expect(nudge.content).toMatch(/oauth/i);
	expect(nudge.content).toMatch(/billing/i);
	expect(nudge.content).toMatch(/topic changed/i);
});


test("context treats malformed percentages as unavailable", async () => {
	const pi = await createTestHost();

	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		const result = await runContext(pi, percentUsage(percent));
		expect(result).toBeUndefined();
	}
});

test("context injects a no-topic nudge when context is high", async () => {
	const pi = await createTestHost();

	const result = await runContext(pi, percentUsage(70));

	expect(resultMessages(result)).toHaveLength(2);
	const reminder = resultMessages(result)[1];
	assertWatchdogReminder(reminder);
	expect(reminder.content).toMatch(/no active notebook topic/i);
	expect(reminder.content).toMatch(/fresh topic/i);
	expect(reminder.content).toMatch(/handoff/i);
});


test("context nudges at band crossings and after a below-30% reset", async () => {
	const pi = await createTestHost();
	const steps: [percent: number, shouldNudge: boolean][] = [
		[29, false], [30, true], [49, false], [50, true],
		[69, false], [70, true], [29, false], [30, true],
	];

	for (const [percent, shouldNudge] of steps) {
		const result = await runContext(pi, percentUsage(percent), `at ${percent}`, percent);
		if (shouldNudge) {expect(result, `watchdog nudge at ${percent}%`).toBeDefined();}
		else {expect(result, `watchdog nudge at ${percent}%`).toBeUndefined();}
	}
});


test("context consumes a boundary hint after the first injected nudge", async () => {
	const pi = await createTestHost();
	await getCommand(pi, "notebook").handler("oauth", createCommandContext({ getContextUsage: () => undefined }));
	await getCommand(pi, "notebook").handler("billing", createCommandContext({ getContextUsage: () => undefined }));

	const first = customMessageAt(await runContext(pi, percentUsage(20)), 1);
	expect(first.content).toMatch(/oauth/i);
	expect(first.content).toMatch(/billing/i);
	expect(first.content).toMatch(/topic changed/i);

	const second = await runContext(pi, percentUsage(20), "hi", 2);
	expect(second).toBeUndefined();
});


test("buildNudge emits topic and spawn guidance", () => {
	const nudge = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null, readonlyEnabled: false, pendingRequestedHandoff: null }, 46, false);
	expect(nudge).toMatch(/Active notebook topic: oauth/);
	expect(nudge).toMatch(/prefer spawn/i);
});

test("default watchdog guidance respects token eligibility", async () => {
	const pi = await createTestHost();
	const result = await runContext(pi, { tokens: null, contextWindow: 64_000, percent: 30 }, "small window");
	const nudge = customMessageAt(result, -1).content;
	expect(nudge).toMatch(/continue working until handoff is available/i);
	expect(nudge).not.toMatch(/prefer a deliberate handoff/i);
});

test("buildNudge does not require an ineligible pending handoff by default", () => {
	const nudge = buildNudge({
		activeNotebookTopic: null,
		pendingTopicBoundaryHint: null,
		readonlyEnabled: false,
		pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null },
	}, null, false);
	expect(nudge).toMatch(/not yet ready for compaction/i);
	expect(nudge).not.toMatch(/complete a real handoff in this session now/i);
});

test("buildNudge uses prompt wording for eligible requested handoffs and topic boundaries", () => {
	const requested = buildNudge({
		activeNotebookTopic: null,
		pendingTopicBoundaryHint: null,
		readonlyEnabled: false,
		pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null },
	}, 30, true);
	expect(requested).toMatch(/real handoff is required/i);
	expect(requested).toMatch(/do not perform the new instruction here/i);
	expect(requested).toMatch(/call handoff with the next instruction and the remaining context/i);
	expect(requested, "stale obligation copy must not survive").not.toMatch(/before continuing normal work/i);
	expect(requested).not.toMatch(/\bbrief\b/i);

	const directed = buildNudge({
		activeNotebookTopic: null,
		pendingTopicBoundaryHint: null,
		readonlyEnabled: false,
		pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: "continue work" },
	}, 30, true);
	expect(directed).toMatch(/call handoff with only the remaining context/i);
	expect(directed).toMatch(/successor receives the instruction verbatim/i);
	expect(directed).not.toMatch(/next instruction and the remaining context/i);

	const boundary = buildNudge({
		activeNotebookTopic: "billing",
		pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
		readonlyEnabled: false,
		pendingRequestedHandoff: null,
	}, 30, true);
	expect(boundary).toMatch(/task-boundary signal/i);
	expect(boundary).toMatch(/next instruction/i);
	expect(boundary).toMatch(/remaining context/i);
	expect(boundary).toMatch(/call handoff/i);
	expect(boundary).not.toMatch(/\bbrief\b/i);
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
	state.pendingRequestedHandoff!.eligibleNudgeDelivered = true;
}

async function createPendingHandoffHost() {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
		registerWatchdog(api, state);
	});
	await getCommand(pi, "handoff").handler("implement auth", idleUICommandContext());
	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	const agentEnd = getHandler(pi, "agent_end");
	const agentSettled = getHandler(pi, "agent_settled");
	return { state, agentEnd, agentSettled };
}

const eligibleUsage = (): ContextUsage => ({ tokens: 50000, percent: 25, contextWindow: 200000 });

test("watchdog stays advisory for a fresh user-requested handoff", async () => {
	const { state, agentSettled } = await createPendingHandoffHost();

	const notifications: string[] = [];
	deliverEligibleNudge(state);
	await agentSettled(
		{ type: "agent_settled", aborted: false },
		createExtensionContext({
			hasUI: true,
			ui: createUIContext({
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
			}),
			getContextUsage: eligibleUsage,
		}),
	);

	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	assertPresent(state.pendingRequestedHandoff, "handoff request should remain active after one settled run");
	expect(state.pendingRequestedHandoff.enforcementAttempts).toBe(1);
	expect(notifications).toStrictEqual([]);
});

/** Host with the handoff command, tool, boundary and watchdog registered in the extension's order. */
async function createStagingHost() {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
		registerHandoffTool(api, state);
		registerHandoffBoundary(api, state);
		registerWatchdog(api, state);
	});
	return { state, pi };
}

async function stageHandoff(pi: TestPI, toolCallId: string): Promise<void> {
	await getTool(pi, "handoff").execute(toolCallId, { nextInstruction: "continue work" }, undefined, undefined, createToolContext({
		getContextUsage: eligibleUsage,
	}));
}

/** End the staging turn and return the entries the boundary handler asked pi to commit. */
async function endStagingTurn(pi: TestPI, toolCallId: string): Promise<SessionBoundaryDraft[]> {
	const event = turnEndEvent({ toolResults: [handoffToolResult(toolCallId)] });
	const ctx = createExtensionContext({ getContextUsage: eligibleUsage });
	const results: (TurnEndEventResult | undefined)[] = [];
	for (const handler of getHandlers(pi, "turn_end")) {
		results.push((await handler(event, ctx)) ?? undefined);
	}
	const boundary = results.find((result) => result?.entries !== undefined);
	assertPresent(boundary?.entries, "the staging turn_end must return boundary entries");
	return boundary.entries;
}

test("a staged handoff that completes at the settle is neither counted nor cancelled", async () => {
	const { state, pi } = await createStagingHost();
	const notifications: string[] = [];
	await getCommand(pi, "handoff").handler("continue work", idleUICommandContext());
	// Spend all but the last attempt so a miscount would cancel the request.
	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS - 1; i++) {
		deliverEligibleNudge(state);
		await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, { hasUI: false, getContextUsage: eligibleUsage, sessionManager: { getBranch: () => [] } });
	}
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(MAX_HANDOFF_ATTEMPTS - 1);

	const userMessagesBeforeRun = pi.sentUserMessages.length;
	deliverEligibleNudge(state);
	await stageHandoff(pi, "in-flight");
	const drafts = await endStagingTurn(pi, "in-flight");
	const branch = drafts.map((draft, index) => ({ ...draft, id: `entry-${index}`, parentId: null }));
	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, {
		hasUI: true,
		ui: { ...makeReadonlyUICtx().ui, notify: (message: string) => notifications.push(message) },
		getContextUsage: eligibleUsage,
		sessionManager: { getBranch: () => branch },
	});

	expect(state.pendingRequestedHandoff, "the confirmed cut clears the request").toBeNull();
	expect(notifications.filter((message) => /Required handoff cancelled/i.test(message))).toStrictEqual([]);
	expect(pi.sentUserMessages, "a completed handoff sends no failure guidance").toHaveLength(userMessagesBeforeRun);
});

test("watchdog auto-cancels a required handoff after enough unanswered settled runs", async () => {
	const { state, agentSettled: handler } = await createPendingHandoffHost();

	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "handoff pending"]]);
	const ctx = createExtensionContext({
		hasUI: true,
		ui: createUIContext({
			notify: (message: string) => notifications.push(message),
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		}),
		getContextUsage: eligibleUsage,
	});

	// Runs without the eligible nudge do not consume the cancellation budget.
	for (let i = 0; i < 3; i++) {
		await handler({ type: "agent_settled", aborted: false }, ctx);
	}
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(0);

	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS - 1; i++) {
		deliverEligibleNudge(state);
		await handler({ type: "agent_settled", aborted: false }, ctx);
	}
	assertPresent(state.pendingRequestedHandoff, "handoff must remain pending before the final attempt");
	expect(notifications, "cancellation must not notify early").toStrictEqual([]);

	deliverEligibleNudge(state);
	await handler({ type: "agent_settled", aborted: false }, ctx);
	expect(state.pendingRequestedHandoff, "pending handoff should be auto-cancelled").toBeNull();
	expect(statuses.get(STATUS_KEY_HANDOFF), "cancellation should clear the handoff status").toBeUndefined();
	expect(notifications, "user should receive a cancellation notification").toHaveLength(1);
	expect(notifications[0], "notification should mention cancellation without source-specific wording").toMatch(/Required handoff cancelled/i);
	expect(notifications[0]).not.toMatch(/user-requested|temporary bypass/i);
});

test("a nudged run whose staged handoff cut was not persisted counts one attempt", async () => {
	const { state, pi } = await createStagingHost();
	await getCommand(pi, "handoff").handler("continue work", idleUICommandContext());

	deliverEligibleNudge(state);
	await stageHandoff(pi, "dropped-cut");
	expect(state.pendingRequestedHandoff?.toolCalled, "staging marks the handoff called").toBe(true);
	await endStagingTurn(pi, "dropped-cut");

	const { sentMessages, sentUserMessages } = getHostRecords(pi);
	const userMessagesBeforeSettle = sentUserMessages.length;
	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, { hasUI: false, getContextUsage: eligibleUsage, sessionManager: { getBranch: () => [] } });

	expect(state.pendingRequestedHandoff?.toolCalled, "the failure resets toolCalled before the watchdog counts").toBe(false);
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
	expect(sentUserMessages, "a dropped cut starts no run").toHaveLength(userMessagesBeforeSettle);
	expect(sentMessages.at(-1)?.message.customType).toBe("pi-schematic-handoff-failed");
	expect(sentMessages.at(-1)?.options?.triggerTurn).toBe(false);
});

test("a nudged run whose handoff was aborted counts one attempt and starts no run", async () => {
	const { state, pi } = await createStagingHost();
	await getCommand(pi, "handoff").handler("continue work", idleUICommandContext());

	deliverEligibleNudge(state);
	await stageHandoff(pi, "aborted-cut");
	await callHandlers(
		pi,
		"turn_end",
		turnEndEvent({ toolResults: [handoffToolResult("aborted-cut")] }),
		{ hasUI: false, signal: { aborted: true }, getContextUsage: eligibleUsage },
	);
	const { sentMessages, sentUserMessages } = getHostRecords(pi);
	const userMessagesBeforeSettle = sentUserMessages.length;
	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, { hasUI: false, getContextUsage: eligibleUsage, sessionManager: { getBranch: () => [] } });

	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
	expect(sentUserMessages, "an abort must not start another run").toHaveLength(userMessagesBeforeSettle);
	expect(sentMessages.at(-1)?.message.customType).toBe("pi-schematic-handoff-failed");
	expect(sentMessages.at(-1)?.options?.triggerTurn).toBe(false);
});

test("agent_end events within a run add no attempt", async () => {
	const { state, agentEnd, agentSettled } = await createPendingHandoffHost();
	const ctx = createExtensionContext({ getContextUsage: eligibleUsage });

	// One run whose first attempt failed and was retried automatically, then a second run.
	deliverEligibleNudge(state);
	await agentEnd({ type: "agent_end", messages: [] }, ctx);
	await agentEnd({ type: "agent_end", messages: [] }, ctx);
	expect(state.pendingRequestedHandoff?.enforcementAttempts, "agent_end must not count an attempt").toBe(0);
	await agentSettled({ type: "agent_settled", aborted: false }, ctx);
	deliverEligibleNudge(state);
	await agentEnd({ type: "agent_end", messages: [] }, ctx);
	await agentSettled({ type: "agent_settled", aborted: false }, ctx);

	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(2);
});

test("a continued run cancels only after MAX_HANDOFF_ATTEMPTS settled runs", async () => {
	const { state, agentEnd, agentSettled } = await createPendingHandoffHost();
	const notifications: { message: string; level: string | undefined }[] = [];
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "handoff pending"]]);
	const ctx = createExtensionContext({
		hasUI: true,
		ui: createUIContext({
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		}),
		getContextUsage: eligibleUsage,
	});

	for (let run = 1; run < MAX_HANDOFF_ATTEMPTS; run++) {
		deliverEligibleNudge(state);
		for (let i = 0; i < 3; i++) {await agentEnd({ type: "agent_end", messages: [] }, ctx);}
		await agentSettled({ type: "agent_settled", aborted: false }, ctx);
		assertPresent(state.pendingRequestedHandoff, `handoff must remain pending after settled run ${run}`);
		expect(notifications, "cancellation must not notify early").toStrictEqual([]);
	}

	deliverEligibleNudge(state);
	for (let i = 0; i < 3; i++) {await agentEnd({ type: "agent_end", messages: [] }, ctx);}
	await agentSettled({ type: "agent_settled", aborted: false }, ctx);
	expect(state.pendingRequestedHandoff).toBeNull();
	expect(statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
	expect(notifications).toHaveLength(1);
	expect(notifications[0].level).toBe("warning");
	expect(notifications[0].message).toMatch(/Required handoff cancelled/i);
});

test("a settled run without the eligible nudge does not count", async () => {
	const { state, agentSettled } = await createPendingHandoffHost();

	await agentSettled({ type: "agent_settled", aborted: false }, createExtensionContext({ getContextUsage: eligibleUsage }));
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(0);

	deliverEligibleNudge(state);
	await agentSettled({ type: "agent_settled", aborted: false }, createExtensionContext({ getContextUsage: eligibleUsage }));
	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
});

test("the eligible nudge counts once per settled run", async () => {
	const { state, agentSettled } = await createPendingHandoffHost();

	deliverEligibleNudge(state);
	await agentSettled({ type: "agent_settled", aborted: false }, createExtensionContext({ getContextUsage: eligibleUsage }));
	await agentSettled({ type: "agent_settled", aborted: false }, createExtensionContext({ getContextUsage: eligibleUsage }));

	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
	expect(state.pendingRequestedHandoff?.eligibleNudgeDelivered).toBe(false);
});

test("an aborted settle after the eligible nudge counts as an attempt", async () => {
	const { state, agentSettled } = await createPendingHandoffHost();

	deliverEligibleNudge(state);
	await agentSettled({ type: "agent_settled", aborted: true }, createExtensionContext({ getContextUsage: eligibleUsage }));

	expect(state.pendingRequestedHandoff?.enforcementAttempts).toBe(1);
});

// Full-host runs: the real context hook decides whether the eligible nudge was delivered.
async function createRequestedHandoffSession() {
	const pi = await createTestHost();
	const warnings: string[] = [];
	const ctxAt = (usage: ContextUsage) => createExtensionContext({
		hasUI: true,
		ui: createUIContext({
			notify: (message: string, level?: string) => { if (level === "warning") {warnings.push(message);} },
			setStatus: () => {},
			setWidget: () => {},
		}),
		getContextUsage: () => usage,
	});
	await getCommand(pi, "handoff").handler("implement auth", idleUICommandContext());
	const runContextHook = async (usage: ContextUsage): Promise<string> => {
		const result = await invokeHandler(pi, "context", contextEvent("work", 1), ctxAt(usage));
		const nudge = findCustomMessage(result, "pi-schematic-watchdog");
		if (typeof nudge?.content !== "string") {throw new Error("The context hook injected no watchdog nudge text.");}
		return nudge.content;
	};
	const settle = (usage: ContextUsage) => emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctxAt(usage));
	return { warnings, runContextHook, settle };
}

test("a run nudged while eligible counts when it settles after compaction", async () => {
	const { warnings, runContextHook, settle } = await createRequestedHandoffSession();
	// After compaction pi reports unknown token counts until the next assistant response.
	const postCompactionUsage: ContextUsage = { tokens: null, contextWindow: 200000, percent: null };

	for (let run = 1; run < MAX_HANDOFF_ATTEMPTS; run++) {
		expect(await runContextHook(eligibleUsage())).toMatch(/A real handoff is required/);
		await settle(postCompactionUsage);
		expect(warnings, `cancellation must not warn after run ${run}`).toStrictEqual([]);
	}

	await runContextHook(eligibleUsage());
	await settle(postCompactionUsage);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toMatch(/Required handoff cancelled/i);
});

test("a run nudged only to keep working does not count", async () => {
	const { warnings, runContextHook, settle } = await createRequestedHandoffSession();
	const ineligibleUsage = { tokens: 5000, percent: 2.5, contextWindow: 200000 };

	for (let run = 0; run < MAX_HANDOFF_ATTEMPTS + 1; run++) {
		expect(await runContextHook(ineligibleUsage)).toMatch(/not yet ready for compaction/);
		await settle(eligibleUsage());
	}

	expect(warnings).toStrictEqual([]);
});

test("agent_settled does not record context usage", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerWatchdog(api, state); });
	const handler = getHandler(pi, "agent_settled");

	await handler({ type: "agent_settled", aborted: false }, createExtensionContext({ getContextUsage: () => percentUsage(70) }));

	expect(state.lastContextPercent).toBeNull();
});

// ── Readonly-specific injection contracts ─────────────────────────

async function drainReadonlyNudge(pi: TestPI): Promise<void> {
	await runContext(pi, undefined, "drain initial readonly nudge");
}

test("context hook suppresses watchdog after readonly toggle nudge is drained", async () => {
	const pi = await createTestHost();
	await getCommand(pi, "readonly").handler("", idleUICommandContext());

	// First call: drain the one-shot toggle nudge
	await runContext(pi, undefined, "first");

	// Repeated calls across watchdog bands remain silent while readonly is active.
	for (const percent of [70, 30, 50, 80]) {
		const result = await runContext(pi, percentUsage(percent), `second at ${percent}`, percent);
		expect(result, `watchdog must be suppressed at ${percent}% in readonly mode`).toBeUndefined();
	}
});

test("context injects a readonly-mode nudge after toggle", async () => {
	const pi = await createTestHost();
	await getCommand(pi, "readonly").handler("", idleUICommandContext());

	const result = await runContext(pi, undefined);

	expect(resultMessages(result)).toHaveLength(2);
	const nudge = customMessageAt(result, 1);
	expect(nudge.customType).toBe("pi-schematic-readonly-nudge");
	expect(nudge.content).toMatch(/readonly/i);
	expect(nudge.content).toMatch(/write\/edit\/powershell blocked/i);
	expect(nudge.content).toMatch(/bash writes/i);
	expect(nudge.content).toMatch(/handoff/i);
});

test("context injects readonly handoff guidance after explicit user /handoff", async () => {
	const pi = await createTestHost();
	await getCommand(pi, "readonly").handler("", idleUICommandContext());
	await drainReadonlyNudge(pi);
	await getCommand(pi, "handoff").handler("continue readonly work", idleUICommandContext());

	const result = await runContext(pi, eligibleUsage(), "hi", 2);
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
	const pi = await createTestHost();
	await getCommand(pi, "readonly").handler("", idleUICommandContext());
	await getCommand(pi, "handoff").handler("continue readonly work", idleUICommandContext());

	const result = await runContext(pi, eligibleUsage(), "hi", 2);
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
	const { pi, toolCall } = await registerReadonlyPI();

	await getCommand(pi, "readonly").handler("", idleUICommandContext());
	await drainReadonlyNudge(pi);
	await getCommand(pi, "notebook").handler("oauth", createCommandContext({ getContextUsage: () => undefined }));
	await getCommand(pi, "notebook").handler("billing", createCommandContext({ getContextUsage: () => undefined }));

	const result = await runContext(pi, eligibleUsage(), "hi", 2);

	// An eligible topic boundary in readonly mode creates the handoff bypass and injects
	// watchdog guidance — equivalent to explicit /handoff or a human topic boundary.
	assertPresent(result, "topic boundary should inject watchdog guidance");
	const watchdogMessage = findCustomMessage(result, "pi-schematic-watchdog");
	assertPresent(watchdogMessage, "watchdog message should be present");
	expect(watchdogMessage.content).toMatch(/handoff/i);
	expect(watchdogMessage.content).toMatch(/temporary handoff exception active/i);

	const blockResult: unknown = await toolCall({ toolName: "handoff", input: {} }, { cwd: "/tmp" });
	expect(blockResult, "handoff tool should be unblocked after topic boundary creates bypass").toBeUndefined();
});

test("watchdog band-crossing: nudge iff context enters a higher band", async () => {
	// Band thresholds: null(<30%), 0(30–49%), 1(50–69%), 2(70%+).
	// A nudge fires only the first time the band ascends.
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.nat({ max: 150 }), { minLength: 1, maxLength: 20 }),
			async (percentages) => {
				const pi = await createTestHost();
				let lastBand: number | null = null;
				for (const raw of percentages) {
					const result = await runContext(pi, percentUsage(raw), String(raw), Date.now());
					const didNudge = result?.messages?.some(
						(message) => message.role === "custom" && message.customType === "pi-schematic-watchdog",
					) ?? false;
					if (raw < 30) {
						// Below 30% resets lastWatchdogBand and never nudges.
						expect(didNudge, `${raw}% below 30% must not nudge`).toBe(false);
						lastBand = null;
					} else {
						const currentBand: number = raw < 50 ? 0 : raw < 70 ? 1 : 2;
						const shouldNudge: boolean = lastBand === null || currentBand > lastBand;
						expect(didNudge, `${raw}% band ${lastBand}→${currentBand}: nudge=${didNudge}`).toBe(shouldNudge);
						if (didNudge) {lastBand = currentBand;}
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});
