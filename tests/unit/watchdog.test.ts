import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createState } from "../../state.js";
import { registerWatchdog, MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import { buildNudge } from "../../watchdog.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { makeReadonlyUICtx } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import type { TestPI } from "./test-host.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";

test("watchdog records context usage without user notifications", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerWatchdog(api, state));
	const [handler] = pi.handlers.get("agent_end")!;

	const notifications: string[] = [];
	await handler(
		{},
		{
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			getContextUsage: () => ({ percent: 70 }),
		},
	);

	assert.deepEqual(notifications, []);
	assert.equal(state.lastContextPercent, 70);
});

test("watchdog ignores malformed percentages", async () => {
	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		const state = createState();
		const pi = await createTestHost((api) => registerWatchdog(api, state));
		const [handler] = pi.handlers.get("agent_end")!;
		await handler({}, { hasUI: false, getContextUsage: () => ({ percent }) });
		assert.equal(state.lastContextPercent, null);
	}
});

test("watchdog records overflow percentages", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerWatchdog(api, state));
	const [handler] = pi.handlers.get("agent_end")!;
	await handler({}, { hasUI: false, getContextUsage: () => ({ percent: 125 }) });
	assert.equal(state.lastContextPercent, 125);
});

test("context injects watchdog reminder before each LLM call", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{
			getContextUsage: () => ({ percent: 70 }),
		},
	);

	assert.equal(result.messages.length, 2);
	assert.deepEqual(result.messages[0], { role: "user", content: "hi", timestamp: 1 });
	assert.equal(result.messages[1].role, "custom");
	assert.equal(result.messages[1].customType, "agenticoding-watchdog");
	assert.equal(result.messages[1].display, false);
	assert.match(result.messages[1].content, /70%/);
	assert.match(result.messages[1].content, /oauth/);
	assert.match(result.messages[1].content, /spawn/i);
	assert.match(result.messages[1].content, /parent context/i);
	assert.doesNotMatch(result.messages[1].content, /draft a clear prompt|what comes next/i);
});


test("context injects a boundary nudge below 30% after an explicit topic change", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	await pi.commands.get("notebook")!.handler("billing", { hasUI: false, getContextUsage: () => null });

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 20 }) },
	);

	assert.equal(result.messages[1].display, false);
	assert.match(result.messages[1].content, /oauth/i);
	assert.match(result.messages[1].content, /billing/i);
	assert.match(result.messages[1].content, /topic changed/i);
});


test("context treats malformed percentages as unavailable", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;

	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		const result = await handler(
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ getContextUsage: () => ({ percent }) },
		);
		assert.equal(result, undefined);
	}
});

test("context injects a no-topic nudge when context is high", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 70 }) },
	);

	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[1].role, "custom");
	assert.equal(result.messages[1].customType, "agenticoding-watchdog");
	assert.equal(result.messages[1].display, false);
	assert.match(result.messages[1].content, /no active notebook topic/i);
	assert.match(result.messages[1].content, /fresh topic/i);
	assert.match(result.messages[1].content, /handoff/i);
});


test("context nudges at band crossings and after a below-30% reset", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;

	for (const [percent, shouldNudge] of [
		[29, false], [30, true], [49, false], [50, true],
		[69, false], [70, true], [29, false], [30, true],
	]) {
		const result = await handler(
			{ messages: [{ role: "user", content: `at ${percent}`, timestamp: percent }] },
			{ getContextUsage: () => ({ percent }) },
		);
		assert.equal(result !== undefined, shouldNudge, `watchdog nudge at ${percent}%`);
	}
});


test("context consumes a boundary hint after the first injected nudge", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	await pi.commands.get("notebook")!.handler("billing", { hasUI: false, getContextUsage: () => null });

	const first = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 20 }) },
	);
	assert.match(first.messages[1].content, /oauth/i);
	assert.match(first.messages[1].content, /billing/i);
	assert.match(first.messages[1].content, /topic changed/i);

	const second = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ percent: 20 }) },
	);
	assert.equal(second, undefined);
});


test("buildNudge emits topic and spawn guidance", () => {
	const nudge = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null, readonlyEnabled: false, pendingRequestedHandoff: null }, 46, false);
	assert.match(nudge, /Active notebook topic: oauth/);
	assert.match(nudge, /prefer spawn/i);
});

test("default watchdog guidance respects token eligibility", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;
	const result = await handler(
		{ messages: [{ role: "user", content: "small window", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 30, contextWindow: 64_000 }) },
	);
	const nudge = result.messages.at(-1).content;
	assert.match(nudge, /continue working until handoff is available/i);
	assert.doesNotMatch(nudge, /prefer a deliberate handoff/i);
});

test("buildNudge does not require an ineligible pending handoff by default", () => {
	const nudge = buildNudge({
		activeNotebookTopic: null,
		pendingTopicBoundaryHint: null,
		readonlyEnabled: false,
		pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, nextInstruction: null },
	}, null, false);
	assert.match(nudge, /not yet ready for compaction/i);
	assert.doesNotMatch(nudge, /complete a real handoff in this session now/i);
});

test("buildNudge uses prompt wording for eligible requested handoffs and topic boundaries", () => {
	const requested = buildNudge({
		activeNotebookTopic: null,
		pendingTopicBoundaryHint: null,
		readonlyEnabled: false,
		pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, nextInstruction: null },
	}, 30, true);
	assert.match(requested, /real handoff is required/i);
	assert.match(requested, /do not perform the new instruction here/i);
	assert.match(requested, /call handoff with the next instruction and the remaining context/i);
	assert.doesNotMatch(requested, /before continuing normal work/i, "stale obligation copy must not survive");
	assert.doesNotMatch(requested, /\bbrief\b/i);

	const directed = buildNudge({
		activeNotebookTopic: null,
		pendingTopicBoundaryHint: null,
		readonlyEnabled: false,
		pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, nextInstruction: "continue work" },
	}, 30, true);
	assert.match(directed, /call handoff with only the remaining context/i);
	assert.match(directed, /successor receives the instruction verbatim/i);
	assert.doesNotMatch(directed, /next instruction and the remaining context/i);

	const boundary = buildNudge({
		activeNotebookTopic: "billing",
		pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
		readonlyEnabled: false,
		pendingRequestedHandoff: null,
	}, 30, true);
	assert.match(boundary, /task-boundary signal/i);
	assert.match(boundary, /next instruction/i);
	assert.match(boundary, /remaining context/i);
	assert.match(boundary, /call handoff/i);
	assert.doesNotMatch(boundary, /\bbrief\b/i);
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
	assert.match(boundary, /Notebook topic changed from oauth to billing/);
	assert.doesNotMatch(boundary, /Active notebook topic: oauth/);

	const noTopic = buildNudge({ activeNotebookTopic: null, pendingTopicBoundaryHint: null, readonlyEnabled: false, pendingRequestedHandoff: null }, null, false);
	assert.match(noTopic, /Topic-aware context reminder/);
	assert.match(noTopic, /No active notebook topic is set/);
});

test("watchdog stays advisory for a fresh user-requested handoff", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
		registerWatchdog(api, state);
	});
	const [handler] = pi.handlers.get("agent_end")!;

	await pi.commands.get("handoff").handler("implement auth", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const notifications: string[] = [];
	await handler(
		{},
		{
			hasUI: true,
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
			},
			getContextUsage: () => ({ percent: 20 }),
		},
	);

	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.ok(state.pendingRequestedHandoff, "handoff request should remain active after one turn");
	assert.deepEqual(notifications, []);
});

test("watchdog does not cancel an in-flight handoff", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
		registerHandoffTool(api, state);
		registerWatchdog(api, state);
	});
	await pi.commands.get("handoff").handler("continue work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);
	let compactOptions: any;
	await pi.tools.get("handoff").execute("in-flight", { nextInstruction: "continue work" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { compactOptions = options; },
	});

	const [handler] = pi.handlers.get("agent_end")!;
	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS + 2; i++) {
		await handler({}, { hasUI: false, getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) });
	}
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);
	compactOptions.onComplete();
	assert.equal(state.pendingRequestedHandoff, null);
});

test("watchdog auto-cancels a required handoff after enough unanswered turns", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
		registerWatchdog(api, state);
	});
	const [handler] = pi.handlers.get("agent_end")!;

	await pi.commands.get("handoff").handler("implement auth", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const notifications: unknown[] = [];
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: unknown) => notifications.push(message),
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
	};

	// Ineligible turns do not consume the cancellation budget.
	for (let i = 0; i < 3; i++) {
		await handler({}, { ...ctx, getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) });
	}
	assert.equal(state.pendingRequestedHandoff?.enforcementAttempts, 0);

	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS - 1; i++) {
		await handler({}, ctx);
	}
	assert.ok(state.pendingRequestedHandoff, "handoff must remain pending before the final attempt");
	assert.deepEqual(notifications, [], "cancellation must not notify early");

	await handler({}, ctx);
	assert.equal(state.pendingRequestedHandoff, null, "pending handoff should be auto-cancelled");
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined, "cancellation should clear the handoff status");
	assert.ok(notifications.length > 0, "user should receive a cancellation notification");
	assert.match(notifications[0] as string, /Required handoff cancelled/i, "notification should mention cancellation without source-specific wording");
	assert.doesNotMatch(notifications[0] as string, /user-requested|temporary bypass/i);
});

// ── Readonly-specific injection contracts ─────────────────────────

async function drainReadonlyNudge(pi: TestPI): Promise<void> {
	const [handler] = pi.handlers.get("context")!;
	await handler(
		{ messages: [{ role: "user", content: "drain initial readonly nudge", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
}

test("context hook suppresses watchdog after readonly toggle nudge is drained", async () => {
	const pi = await createTestHost();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [handler] = pi.handlers.get("context")!;

	// First call: drain the one-shot toggle nudge
	await handler(
		{ messages: [{ role: "user", content: "first", timestamp: 1 }] },
		{ getContextUsage: () => null },
	);

	// Repeated calls across watchdog bands remain silent while readonly is active.
	for (const percent of [70, 30, 50, 80]) {
		const result = await handler(
			{ messages: [{ role: "user", content: `second at ${percent}`, timestamp: percent }] },
			{ getContextUsage: () => ({ percent }) },
		);
		assert.equal(result, undefined, `watchdog must be suppressed at ${percent}% in readonly mode`);
	}
});

test("context injects a readonly-mode nudge after toggle", async () => {
	const pi = await createTestHost();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [handler] = pi.handlers.get("context")!;

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => null },
	);

	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[1].customType, "agenticoding-readonly-nudge");
	assert.match(result.messages[1].content, /readonly/i);
	assert.match(result.messages[1].content, /write\/edit blocked/i);
	assert.match(result.messages[1].content, /bash writes/i);
	assert.match(result.messages[1].content, /handoff/i);
});

test("context injects readonly handoff guidance after explicit user /handoff", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await drainReadonlyNudge(pi);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) },
	);
	const watchdogMessage = result.messages.find((message: any) => message.customType === "agenticoding-watchdog");

	assert.ok(watchdogMessage, "requested handoff should inject watchdog guidance");
	assert.match(watchdogMessage.content, /handoff/i);
	assert.match(watchdogMessage.content, /readonly/i);
	assert.match(watchdogMessage.content, /temporary handoff exception active/i);
	assert.match(watchdogMessage.content, /write\/edit remain blocked/i);
	assert.match(watchdogMessage.content, /fresh context resumes in readonly mode|resumes readonly mode/i);
	assert.doesNotMatch(watchdogMessage.content, /User explicitly requested|this request only/i);
});

test("readonly toggle nudge aligns with handoff exception in the same turn", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) },
	);
	const readonlyMessage = result.messages.find((message: any) => message.customType === "agenticoding-readonly-nudge");
	const watchdogMessage = result.messages.find((message: any) => message.customType === "agenticoding-watchdog");

	assert.ok(readonlyMessage, "readonly toggle should still emit its one-shot nudge");
	assert.ok(watchdogMessage, "handoff guidance should still be injected");
	assert.match(readonlyMessage.content, /temporary handoff exception active/i);
	assert.match(readonlyMessage.content, /write\/edit remain blocked/i);
	assert.doesNotMatch(readonlyMessage.content, /handoff blocked/i);
	assert.match(watchdogMessage.content, /temporary handoff exception active/i);
});

test("eligible readonly human topic boundary auto-creates handoff bypass equivalent to /handoff", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("context")!;

	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await drainReadonlyNudge(pi);
	await pi.commands.get("notebook").handler(
		"oauth",
		{ hasUI: false, getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler(
		"billing",
		{ hasUI: false, getContextUsage: () => null } as any,
	);

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) },
	);

	// An eligible topic boundary in readonly mode creates the handoff bypass and injects
	// watchdog guidance — equivalent to explicit /handoff or a human topic boundary.
	assert.ok(result, "topic boundary should inject watchdog guidance");
	const watchdogMessage = result.messages.find((m: any) => m.customType === "agenticoding-watchdog");
	assert.ok(watchdogMessage, "watchdog message should be present");
	assert.match(watchdogMessage.content, /handoff/i);
	assert.match(watchdogMessage.content, /temporary handoff exception active/i);

	const [toolCallHandler] = pi.handlers.get("tool_call")!;
	const blockResult = await toolCallHandler(
		{ toolName: "handoff", input: {} },
		{ cwd: "/tmp" } as any,
	);
	assert.equal(blockResult, undefined, "handoff tool should be unblocked after topic boundary creates bypass");
});

test("watchdog band-crossing: nudge iff context enters a higher band", async () => {
	// Band thresholds: null(<30%), 0(30–49%), 1(50–69%), 2(70%+).
	// A nudge fires only the first time the band ascends.
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.nat({ max: 150 }), { minLength: 1, maxLength: 20 }),
			async (percentages) => {
				const pi = await createTestHost();
				const [handler] = pi.handlers.get("context")!;
				let lastBand: number | null = null;
				for (const raw of percentages) {
					const pct = { percent: raw };
					const result = await handler(
						{ messages: [{ role: "user", content: String(raw), timestamp: Date.now() }] },
						{ getContextUsage: () => pct },
					);
					const didNudge = result?.messages?.some(
						(message: any) => message.customType === "agenticoding-watchdog",
					) ?? false;
					if (raw < 30) {
						// Below 30% resets lastWatchdogBand and never nudges.
						assert.equal(didNudge, false, `${raw}% below 30% must not nudge`);
						lastBand = null;
					} else {
						const currentBand: number = raw < 50 ? 0 : raw < 70 ? 1 : 2;
						const shouldNudge: boolean = lastBand === null || currentBand > lastBand;
						assert.equal(didNudge, shouldNudge,
							`${raw}% band ${lastBand}→${currentBand}: nudge=${didNudge}`);
						if (didNudge) lastBand = currentBand;
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});
