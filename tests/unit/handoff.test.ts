import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { Value } from "typebox/value";
import { createState } from "../../state.js";
import type { SchematicState } from "../../state.js";
import { reconstructNotebook } from "../../notebook/rehydration.js";
import { registerHandoffBoundary } from "../../handoff/boundary.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import {
	HANDOFF_ALREADY_STAGED,
	HANDOFF_COMMAND_BUSY,
	HANDOFF_EXTRA_CALL_REFUSAL,
	HANDOFF_FAILED_IN_RUN_REFUSAL,
	HANDOFF_NOT_ALONE_REFUSAL,
	HANDOFF_STAGED_RESULT,
	HANDOFF_SUCCESSOR_NOT_RUN,
	REASON_ABORTED,
	REASON_NOT_PERSISTED,
	REASON_NO_BOUNDARY,
	REASON_RESULT_MISSING,
} from "../../handoff/copy.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { buildContinuationFrame, buildNextUserMessage } from "../../handoff/format.js";
import { STATUS_KEY_HANDOFF, STATUS_KEY_NOTEBOOK, STATUS_KEY_TOPIC, WIDGET_KEY_WARNING } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS, registerWatchdog } from "../../watchdog.js";
import { callHandlers, emitAll, handoffToolResult, turnEndEvent } from "./helpers.js";
import { createTestHost, type TestPI } from "./test-host.js";

/**
 * The successor turn must OPEN with the delivered instruction + context.
 *
 * WHY this builds the expected prefix by hand instead of calling
 * `buildNextUserMessage`: asserting against the builder itself would pass
 * vacuously if the builder regressed. The exact builder output is pinned
 * separately by the `buildNextUserMessage` golden-string test.
 */
function assertSuccessorTurn(content: string, input: { nextInstruction: string; context?: string }): void {
	const expected = [`## Next instruction\n\n${input.nextInstruction}`];
	const context = input.context?.trim();
	if (context) expected.push(`## Context\n\n${context}`);
	assert.ok(content.startsWith(expected.join("\n\n")),
		`successor turn must start with the delivered instruction and context:\n${content}`);
}

type Usage = { tokens: number | null; percent: number | null; contextWindow: number | null } | null;
const ELIGIBLE_USAGE: Usage = { tokens: 50_000, percent: 25, contextWindow: 200_000 };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Recording UI context; `session.branch` is what `sessionManager.getBranch()` returns. */
function makeCtx(options: { usage?: Usage; aborted?: boolean; hasUI?: boolean } = {}) {
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const notifications: Array<{ message: string; level: string }> = [];
	const session = { branch: [] as any[], usage: options.usage === undefined ? ELIGIBLE_USAGE : options.usage };
	const ctx: any = {
		hasUI: options.hasUI ?? true,
		signal: options.aborted ? AbortSignal.abort() : undefined,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: (key: string, value: string[] | undefined) => { widgets.set(key, value); },
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
		},
		getContextUsage: () => session.usage,
		sessionManager: { getBranch: () => session.branch },
	};
	return { ctx, statuses, widgets, notifications, session };
}

async function boundaryHost(seed: (state: SchematicState) => void = () => {}) {
	const state = createState();
	seed(state);
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
		registerHandoffTool(api, state);
		registerHandoffBoundary(api, state);
	});
	return { state, pi };
}

function requestHandoff(state: SchematicState, nextInstruction: string | null = null): void {
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction };
}

function executeHandoff(pi: TestPI, ctx: unknown, params: Record<string, unknown> = { nextInstruction: "continue work", context: "state" }, toolCallId = "call-1") {
	return pi.tools.get("handoff").execute(toolCallId, params, undefined, undefined, ctx);
}

/** Run the turn_end handlers and return the boundary result (the one handler that answers). */
async function endTurn(pi: TestPI, ctx: unknown, overrides: Parameters<typeof turnEndEvent>[0] = {}, toolCallId = "call-1"): Promise<any> {
	const results = await callHandlers(pi, "turn_end", turnEndEvent({ toolResults: [handoffToolResult(toolCallId)], ...overrides }), ctx);
	return results.find((result) => result !== undefined);
}

/** What pi persists for submitted drafts: the same entries with ids and parents. */
function persist(drafts: any[]): any[] {
	return drafts.map((draft, index) => ({
		...draft,
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: "2026-01-01T00:00:00.000Z",
	}));
}

/** A failed handoff stages nothing, starts no run and reports through one displayed message; returns its content. */
function assertFailedWithoutRun(state: SchematicState, pi: TestPI): string {
	assert.equal(state.stagedHandoff, null);
	assert.deepEqual(pi.sentUserMessages, [], "a failed handoff must not start a new run");
	const content = pi.sentMessages[0]?.message.content;
	assert.equal(typeof content, "string");
	assert.deepEqual(pi.sentMessages, [{
		message: { customType: "pi-schematic-handoff-failed", content, display: true },
		options: { triggerTurn: false },
	}]);
	return content;
}

test("/handoff sends the direction back through the LLM without opening the editor", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => null,
		ui: { notify: (_message: string) => {} },
	});

	assert.deepEqual(state.pendingRequestedHandoff, {
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		toolCalled: false,
		nextInstruction: "implement auth",
	});
	assert.equal(pi.sentUserMessages.length, 1);
	assert.match(pi.sentUserMessages[0].content, /<next-instruction>\nimplement auth\n<\/next-instruction>/);
	assert.match(pi.sentUserMessages[0].content, /Do NOT start this instruction/);
	assert.match(pi.sentUserMessages[0].content, /discarded at compaction/);
	assert.match(pi.sentUserMessages[0].content, /Curate the notebook/);
	assert.match(pi.sentUserMessages[0].content, /Call the handoff tool with `context`/);
	assert.match(pi.sentUserMessages[0].content, /non-recoverable knowledge/i);
	assert.match(pi.sentUserMessages[0].content, /A real handoff is required in the current session/);
	assert.doesNotMatch(pi.sentUserMessages[0].content, /User explicitly requested|\/handoff/);
	assert.doesNotMatch(pi.sentUserMessages[0].content, /\bbrief\b/i);
	assert.equal(pi.sentUserMessages[0].options, undefined);
});

test("/handoff requires a direction", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});

	const notifications: string[] = [];
	await pi.commands.get("handoff")!.handler("   ", {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (message: string) => notifications.push(message) },
	});

	assert.deepEqual(notifications, ["Usage: /handoff <direction>"]);
	assert.deepEqual(pi.sentUserMessages, []);
});

// ── Staging (the handoff tool) ───────────────────────────────────────

test("handoff stages the request, marks it called, shows progress and appends nothing", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, statuses } = makeCtx();

	const result = await executeHandoff(pi, ctx, {
		nextInstruction: "Goal: continue auth-refresh",
		context: "blocked on the token spike",
		discardPages: ["stale", "stale", "old"],
	});

	assert.deepEqual(result, {
		content: [{ type: "text", text: HANDOFF_STAGED_RESULT }],
		details: {},
		terminate: true,
	});
	const { handoffId, ...staged } = state.stagedHandoff!;
	assert.match(handoffId, UUID_PATTERN);
	assert.deepEqual(staged, {
		toolCallId: "call-1",
		nextInstruction: "Goal: continue auth-refresh",
		context: "blocked on the token spike",
		discardPages: ["stale", "old"],
		phase: "staged",
		declineReason: null,
		discarded: 0,
	});
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	assert.deepEqual(pi.appendedEntries, []);
	assert.deepEqual(pi.sentMessages, []);
	assert.deepEqual(pi.sentUserMessages, []);
});

test("a pending human direction wins over a model-supplied nextInstruction in the staged request", async () => {
	const { state, pi } = await boundaryHost();
	const direction = "  Audit the retry budget.  ";
	await pi.commands.get("handoff")!.handler(direction, { hasUI: false, isIdle: () => true, getContextUsage: () => null } as any);

	await executeHandoff(pi, makeCtx().ctx, {
		nextInstruction: "Verify the audit is done",
		context: "state machine rebuilt from scratch",
	});

	assert.equal(state.stagedHandoff?.nextInstruction, "Audit the retry budget.");
	assert.equal(state.stagedHandoff?.context, "state machine rebuilt from scratch");
});

test("a pending human direction needs no tool arguments", async () => {
	const { state, pi } = await boundaryHost();
	await pi.commands.get("handoff")!.handler("finish the migration", { hasUI: false, isIdle: () => true } as any);

	await executeHandoff(pi, makeCtx().ctx, {});

	assert.equal(state.stagedHandoff?.nextInstruction, "finish the migration");
	assert.equal(state.stagedHandoff?.context, "");
});

test("handoff with no pending direction requires nextInstruction but not context", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx } = makeCtx();

	await assert.rejects(
		() => executeHandoff(pi, ctx, { context: "only context" }),
		/Empty handoff nextInstruction rejected/,
	);
	assert.equal(state.stagedHandoff as unknown, null, "a rejected call must not stage");

	await executeHandoff(pi, ctx, { nextInstruction: "  Ship the fix  " });

	// Surrounding whitespace is trimmed.
	assert.equal((state.stagedHandoff as SchematicState["stagedHandoff"])?.nextInstruction, "Ship the fix");
	assert.equal((state.stagedHandoff as SchematicState["stagedHandoff"])?.context, "");
});

test("handoff is rejected while another handoff is staged, and /handoff reports it busy", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "first task" }, "first");

	await assert.rejects(() => executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second"),
		(error: unknown) => error instanceof Error && error.message === HANDOFF_ALREADY_STAGED);
	await assert.rejects(
		() => pi.commands.get("handoff")!.handler("replacement direction", { hasUI: false, isIdle: () => true } as any),
		(error: unknown) => error instanceof Error && error.message === HANDOFF_COMMAND_BUSY,
	);

	assert.equal(state.stagedHandoff?.nextInstruction, "first task", "the first staged request must survive");
	assert.equal(state.stagedHandoff?.toolCallId, "first");
	assert.equal(state.pendingRequestedHandoff, null, "a rejected /handoff must not store its direction");
});

// ── turn_end: the boundary drafts ────────────────────────────────────

test("turn_end appends the cut, successor and note after the existing entries and continues", async () => {
	const { state, pi } = await boundaryHost();
	await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "Goal: ship", context: "left off at step 3" });
	const handoffId = state.stagedHandoff!.handoffId;
	const foreign = { type: "custom", customType: "other-extension", data: { kept: true } };

	const result = await endTurn(pi, makeCtx().ctx, { entries: [foreign as any] });

	assert.deepEqual(result, {
		entries: [
			foreign,
			{
				type: "compaction",
				summary: buildContinuationFrame(),
				firstKeptEntryId: null,
				details: { handoff: true, handoffId },
			},
			{
				type: "custom_message",
				customType: "pi-schematic-handoff",
				content: "## Next instruction\n\nGoal: ship\n\n## Context\n\nleft off at step 3",
				display: true,
				details: { handoffId },
			},
			{
				type: "custom_message",
				customType: "pi-schematic-handoff-note",
				content: "The system prompt above was written before this handoff and is refreshed at the next user message. Until then, ignore its notebook topic (the topic is cleared) and its notebook page list (use `notebook_index` for the current pages).",
				display: false,
				details: { handoffId },
			},
		],
		continue: true,
	});
	assert.equal(state.stagedHandoff?.phase, "submitted");
});

test("turn_end with discardPages writes the notebook rewrite before the cut and reports the outcome in the successor details", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("stale", "obsolete");
		s.notebookPages.set("keep", "durable");
		s.clippedPages.add("keep");
	});
	await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "go", discardPages: ["stale", "ghost"] });
	const handoffId = state.stagedHandoff!.handoffId;

	const result = await endTurn(pi, makeCtx().ctx);

	assert.deepEqual(result.entries.slice(0, 3), [
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "keep", content: "durable", clipped: true } },
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 2 } },
	]);
	assert.equal(result.entries[3].type, "compaction");
	assert.deepEqual(result.entries[4].details, { handoffId, report: "Handoff complete. Notebook: 1 page kept, 1 discarded." });
	assert.equal(result.entries[4].content, "## Next instruction\n\ngo", "the report must not enter the successor content");
	assert.equal(state.stagedHandoff?.discarded, 1);
	assert.equal(state.notebookPages.has("stale"), true, "the in-memory notebook changes only once the cut is confirmed");
});

test("the discard epoch moves past the discard watermark", async () => {
	const { pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.discardEpochWatermark = 3;
		s.notebookPages.set("stale", "obsolete");
		s.notebookPages.set("keep", "durable");
	});
	await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "go", discardPages: ["stale"] });

	const result = await endTurn(pi, makeCtx().ctx);

	assert.deepEqual(result.entries.map((entry: any) => entry.data?.epoch).slice(0, 3), [1, 4, 4]);
});

test("turn_end adds no notebook entries when discardPages is empty or names no page", async () => {
	for (const discardPages of [[], ["ghost"]]) {
		const { pi } = await boundaryHost((s) => {
			s.epoch = 1;
			s.notebookPages.set("keep", "durable");
		});
		await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "go", discardPages });

		const result = await endTurn(pi, makeCtx().ctx);

		assert.deepEqual(result.entries.map((entry: any) => entry.type), ["compaction", "custom_message", "custom_message"],
			`discardPages ${JSON.stringify(discardPages)}`);
	}
});

test("a handoff without discardPages carries no report in the successor details", async () => {
	const { state, pi } = await boundaryHost();
	await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "go" });

	const result = await endTurn(pi, makeCtx().ctx);

	assert.deepEqual(result.entries[1].details, { handoffId: state.stagedHandoff!.handoffId });
});

test("turn_end declines the cut when the run was aborted, the turn failed, or the handoff result is unusable", async () => {
	const cases: Array<{ name: string; reason: string; ctx?: { aborted: boolean }; event: Parameters<typeof turnEndEvent>[0] }> = [
		{ name: "ctx.signal aborted", reason: REASON_ABORTED, ctx: { aborted: true }, event: {} },
		{ name: "outcome aborted", reason: REASON_ABORTED, event: { outcome: "aborted" } },
		{ name: "outcome error", reason: REASON_RESULT_MISSING, event: { outcome: "error" } },
		{ name: "result missing", reason: REASON_RESULT_MISSING, event: { toolResults: [] } },
		{ name: "result for another call", reason: REASON_RESULT_MISSING, event: { toolResults: [handoffToolResult("other-call")] } },
		{ name: "result is an error", reason: REASON_RESULT_MISSING, event: { toolResults: [handoffToolResult("call-1", true)] } },
	];
	for (const { name, reason, ctx, event } of cases) {
		const { state, pi } = await boundaryHost();
		await executeHandoff(pi, makeCtx().ctx);

		const results = await callHandlers(pi, "turn_end", turnEndEvent({ toolResults: [handoffToolResult("call-1")], ...event }), makeCtx(ctx).ctx);

		assert.deepEqual(results, [undefined], name);
		assert.equal(state.stagedHandoff?.phase, "declined", name);
		assert.equal(state.stagedHandoff?.declineReason, reason, name);
	}
});

test("turn_end without a staged handoff returns nothing", async () => {
	const { pi } = await boundaryHost();

	assert.deepEqual(await callHandlers(pi, "turn_end", turnEndEvent(), makeCtx().ctx), [undefined]);
});

// ── turn_start / agent_settled: confirming the cut ───────────────────

test("turn_start with the cut on the branch completes the handoff", async () => {
	const { state, pi } = await boundaryHost((s) => {
		requestHandoff(s, "implement auth");
		s.epoch = 1;
		s.notebookPages.set("stale", "obsolete");
		s.notebookPages.set("keep", "durable");
		s.activeNotebookTopic = "oauth";
		s.activeNotebookTopicSource = "human";
		s.readonlyEnabled = true;
	});
	const { ctx, statuses, widgets, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx, { discardPages: ["stale"] });
	const result = await endTurn(pi, ctx);
	session.branch = persist(result.entries);
	widgets.set(WIDGET_KEY_WARNING, ["⚠ Context at 85% — readonly"]);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(state.activeNotebookTopic, null);
	assert.equal(state.readonlyNudgePending, true);
	assert.deepEqual([...state.notebookPages], [["keep", "durable"]], "pages follow what the branch persisted");
	assert.equal(state.epoch, 2);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined, "the in-progress status the tool set is cleared");
	assert.deepEqual(notifications, [{ message: "Handoff complete. Notebook: 1 page kept, 1 discarded.", level: "info" }]);
	assert.equal(statuses.get(STATUS_KEY_TOPIC), "🧭 -", "the topic indicator shows the cleared topic");
	assert.equal(statuses.get(STATUS_KEY_NOTEBOOK), "📒 1", "the notebook indicator shows the kept pages");
	assert.equal(widgets.get(WIDGET_KEY_WARNING), undefined, "the high-context warning is cleared");
	assert.deepEqual(pi.sentUserMessages, []);
	assert.deepEqual(pi.sentMessages, []);
});

test("a completed handoff without discardPages notifies a plain completion", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("a", "one");
		s.notebookPages.set("b", "two");
	});
	const { ctx, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "go" });
	const result = await endTurn(pi, ctx);
	session.branch = persist([
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "a", content: "one", clipped: false } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "b", content: "two", clipped: false } },
		...result.entries,
	]);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.notebookPages.size, 2, "the pages survive, so the plain form does not depend on an empty notebook");
	assert.equal("report" in result.entries[1].details, false);
	assert.deepEqual(notifications, [{ message: "Handoff complete.", level: "info" }]);
});

test("a discard naming no page reports the kept pages without a discarded count", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("a", "one");
		s.notebookPages.set("b", "two");
	});
	const { ctx, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "go", discardPages: ["ghost"] });
	const handoffId = state.stagedHandoff!.handoffId;
	const result = await endTurn(pi, ctx);
	session.branch = persist([
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "a", content: "one", clipped: false } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "b", content: "two", clipped: false } },
		...result.entries,
	]);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.deepEqual(result.entries[1].details, { handoffId, report: "Handoff complete. Notebook: 2 pages kept." });
	assert.deepEqual(notifications, [{ message: "Handoff complete. Notebook: 2 pages kept.", level: "info" }]);
});

test("a completed handoff leaves the readonly nudge off when readonly is off", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx, session } = makeCtx();
	await executeHandoff(pi, ctx);
	session.branch = persist((await endTurn(pi, ctx)).entries);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(state.readonlyNudgePending, false);
});

test("turn_start leaves a handoff staged until its turn_end has run", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.stagedHandoff?.phase, "staged");
	assert.deepEqual(notifications, []);
	assert.deepEqual(pi.sentUserMessages, []);
});

test("turn_start without the cut on the branch fails the handoff and keeps the request retryable", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s, "implement auth"));
	const { ctx, statuses, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.deepEqual(state.pendingRequestedHandoff, {
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: "implement auth",
	});
	assert.deepEqual(pi.sentUserMessages, [], "a missing cut never starts a run");
	assert.deepEqual(pi.sentMessages, [{
		message: {
			customType: "pi-schematic-handoff-failed",
			content: `Handoff failed — ${REASON_NOT_PERSISTED}. The required handoff remains pending; retry when context usage is eligible.`,
			display: true,
		},
		options: { triggerTurn: false },
	}]);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
	assert.deepEqual(notifications, [{ message: `Handoff failed: ${REASON_NOT_PERSISTED}. The handoff can be retried.`, level: "error" }]);
});

test("a failed handoff shows the waiting status when usage becomes unavailable", async () => {
	const { pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, statuses, session } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);
	session.usage = null;

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");
});

test("a failed handoff without a pending request clears the status and says nothing remains pending", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx, statuses } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined, "the in-progress status the tool set is cleared");
	assert.deepEqual(pi.sentUserMessages, []);
	assert.equal(pi.sentMessages.length, 1);
	assert.equal(pi.sentMessages[0].message.customType, "pi-schematic-handoff-failed");
	assert.equal(pi.sentMessages[0].message.display, true);
	assert.match(pi.sentMessages[0].message.content, /No required handoff remains pending; retry when ready\.$/);
	assert.deepEqual(pi.sentMessages[0].options, { triggerTurn: false });
});

for (const { attemptsBefore, nudged, requestSurvives } of [
	{ attemptsBefore: MAX_HANDOFF_ATTEMPTS - 1, nudged: true, requestSurvives: false },
	{ attemptsBefore: MAX_HANDOFF_ATTEMPTS - 2, nudged: true, requestSurvives: true },
	{ attemptsBefore: MAX_HANDOFF_ATTEMPTS - 1, nudged: false, requestSurvives: true },
]) {
	test(`a failed cut on ${nudged ? "a nudged" : "an un-nudged"} run after ${attemptsBefore} counted attempts ${requestSurvives ? "keeps" : "does not call"} the request pending`, async () => {
		const state = createState();
		state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: attemptsBefore, eligibleNudgeDelivered: nudged, nextInstruction: null };
		const pi = await createTestHost((api) => {
			registerHandoffTool(api, state);
			registerHandoffBoundary(api, state);
			registerWatchdog(api, state);
		});
		const { ctx, statuses, notifications } = makeCtx();
		await executeHandoff(pi, ctx);
		await endTurn(pi, ctx);

		await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

		assert.equal(state.pendingRequestedHandoff !== null, requestSurvives);
		assert.equal(pi.sentMessages.length, 1);
		assert.match(pi.sentMessages[0].message.content, requestSurvives
			? /The required handoff remains pending; retry when context usage is eligible\.$/
			: /No required handoff remains pending; retry when ready\.$/);
		assert.equal(statuses.get(STATUS_KEY_HANDOFF), requestSurvives ? "🤝 Handoff required — ready to compact" : undefined);
		assert.equal(notifications[0]?.message, `Handoff failed: ${REASON_NOT_PERSISTED}. The handoff can be retried.`);
	});
}

test("agent_settled with the cut on the branch completes with the successor-did-not-run warning", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx);
	session.branch = persist((await endTurn(pi, ctx)).entries);

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.deepEqual(notifications, [{ message: HANDOFF_SUCCESSOR_NOT_RUN, level: "warning" }]);
	assert.deepEqual(pi.sentUserMessages, []);
});

test("agent_settled fails a declined handoff with its decline reason in a displayed message and starts no run", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx, { toolResults: [] });

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.match(assertFailedWithoutRun(state, pi), new RegExp(`^Handoff failed — ${REASON_RESULT_MISSING}\\.`));
	assert.equal(notifications[0].level, "error");
});

test("agent_settled fails a handoff whose turn_end never ran", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.match(assertFailedWithoutRun(state, pi), new RegExp(`^Handoff failed — ${REASON_NO_BOUNDARY}\\.`));
	assert.deepEqual(notifications, [{ message: `Handoff failed: ${REASON_NO_BOUNDARY}. The handoff can be retried.`, level: "error" }]);
});

test("a handoff declined for an abort fails at agent_settled with a displayed message and starts no run", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, makeCtx({ aborted: true }).ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.equal(assertFailedWithoutRun(state, pi),
		`Handoff failed — ${REASON_ABORTED}. The required handoff remains pending; retry when context usage is eligible.`);
	assert.deepEqual(notifications, [{ message: `Handoff failed: ${REASON_ABORTED}. The handoff can be retried.`, level: "error" }]);
});

test("a submitted handoff whose cut is missing but whose notebook drafts persisted follows the branch's notebook", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("stale", "obsolete");
		s.notebookPages.set("keep", "durable");
	});
	const { ctx, session } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "go", discardPages: ["stale"] });
	const result = await endTurn(pi, ctx);
	session.branch = persist(result.entries.filter((entry: any) => entry.type !== "compaction"));
	const expected = createState();
	reconstructNotebook(expected, session.branch);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(pi.sentMessages[0].message.customType, "pi-schematic-handoff-failed");
	assert.deepEqual([...state.notebookPages], [["keep", "durable"]], "the discard drafts persisted, so the discard applies");
	assert.equal(state.epoch, 2);
	assert.deepEqual([...state.notebookPages], [...expected.notebookPages]);
	assert.equal(state.epoch, expected.epoch);
	assert.equal(state.discardEpochWatermark, expected.discardEpochWatermark);
});

test("a failed handoff, a retry and the second cut deliver the human direction and the retry's discard", async () => {
	const { state, pi } = await boundaryHost((s) => {
		requestHandoff(s, "human direction");
		s.epoch = 1;
		s.notebookPages.set("stale", "obsolete");
		s.notebookPages.set("keep", "durable");
		s.notebookPages.set("other", "also durable");
	});
	const { ctx, session } = makeCtx();
	const persistedNotebook = [
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		...["stale", "keep", "other"].map((name) => ({
			type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name, content: state.notebookPages.get(name), clipped: false },
		})),
	];
	session.branch = persist(persistedNotebook);
	await executeHandoff(pi, ctx, { nextInstruction: "first model instruction", discardPages: ["other"] }, "first");
	await endTurn(pi, ctx, {}, "first");
	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);
	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff?.nextInstruction, "human direction", "the failed cut keeps the request pending");

	await executeHandoff(pi, ctx, { nextInstruction: "second model instruction", discardPages: ["stale"] }, "second");
	const result = await endTurn(pi, ctx, {}, "second");
	session.branch = persist([...persistedNotebook, ...result.entries]);
	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	const successor = result.entries.find((entry: any) => entry.customType === "pi-schematic-handoff");
	assert.equal(successor.content, "## Next instruction\n\nhuman direction");
	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.deepEqual([...state.notebookPages].sort(), [["keep", "durable"], ["other", "also durable"]]);
});

test("a handoff whose branch holds only an earlier handoff's cut fails as not persisted", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx, session } = makeCtx();
	session.branch = [{ type: "compaction", id: "old-cut", parentId: null, details: { handoff: true, handoffId: "handoff-a" } }];
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.match(pi.sentMessages[0].message.content, new RegExp(`^Handoff failed — ${REASON_NOT_PERSISTED.replace(/[()]/g, "\\$&")}\\.`));
});

test("agent_settled after a handoff completed at turn_start sends and notifies nothing", async () => {
	const { pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications, session } = makeCtx({ hasUI: true });
	await executeHandoff(pi, ctx);
	session.branch = persist((await endTurn(pi, ctx)).entries);
	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);
	const notificationsAtCompletion = notifications.length;

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(notificationsAtCompletion, 1);
	assert.equal(notifications.length, 1, "no second notification at settle");
	assert.deepEqual(pi.sentMessages, []);
	assert.deepEqual(pi.sentUserMessages, []);
});

// ── Sibling refusal ──────────────────────────────────────────────────

function assistantMessage(...calls: Array<{ id: string; name: string }>) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		},
	};
}

async function toolCall(pi: TestPI, toolCallId: string, toolName: string): Promise<any> {
	const results = await callHandlers(pi, "tool_call", { type: "tool_call", toolCallId, toolName, input: {} }, makeCtx().ctx);
	return results.find((result) => result !== undefined);
}

test("in a message holding only handoff calls, the first runs and the others are refused", async () => {
	const { pi } = await boundaryHost();
	await callHandlers(pi, "message_end", assistantMessage(
		{ id: "h1", name: "handoff" },
		{ id: "h2", name: "handoff" },
	), makeCtx().ctx);

	assert.equal(await toolCall(pi, "h1", "handoff"), undefined);
	assert.deepEqual(await toolCall(pi, "h2", "handoff"), { block: true, reason: HANDOFF_EXTRA_CALL_REFUSAL, terminate: true });
});

test("every handoff sharing a message with other calls is refused and the other calls are not refused", async () => {
	const { pi } = await boundaryHost();
	await callHandlers(pi, "message_end", assistantMessage(
		{ id: "w1", name: "write" },
		{ id: "h1", name: "handoff" },
		{ id: "n1", name: "notebook_write" },
		{ id: "h2", name: "handoff" },
	), makeCtx().ctx);

	assert.deepEqual(await toolCall(pi, "h1", "handoff"), { block: true, reason: HANDOFF_NOT_ALONE_REFUSAL, terminate: true });
	assert.deepEqual(await toolCall(pi, "h2", "handoff"), { block: true, reason: HANDOFF_NOT_ALONE_REFUSAL, terminate: true });
	assert.equal(await toolCall(pi, "w1", "write"), undefined);
	assert.equal(await toolCall(pi, "n1", "notebook_write"), undefined);
});

test("calls in an assistant message without handoff are not refused", async () => {
	const { pi } = await boundaryHost();
	await callHandlers(pi, "message_end", assistantMessage({ id: "w1", name: "write" }, { id: "r1", name: "read" }), makeCtx().ctx);

	assert.equal(await toolCall(pi, "w1", "write"), undefined);
	assert.equal(await toolCall(pi, "r1", "read"), undefined);
});

test("refusals last until the next assistant message and are not cleared by other messages", async () => {
	const { pi } = await boundaryHost();
	const ctx = makeCtx().ctx;
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);

	await callHandlers(pi, "message_end", { type: "message_end", message: { role: "toolResult", content: [] } }, ctx);
	assert.equal((await toolCall(pi, "h1", "handoff")).block, true, "a tool result message must not clear refusals");

	await callHandlers(pi, "message_end", assistantMessage({ id: "w2", name: "write" }), ctx);
	assert.equal(await toolCall(pi, "h1", "handoff"), undefined, "the next assistant message clears the previous refusals");
});

test("turn_end clears the refusals", async () => {
	const { pi } = await boundaryHost();
	const ctx = makeCtx().ctx;
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);

	await callHandlers(pi, "turn_end", turnEndEvent(), ctx);

	assert.equal(await toolCall(pi, "h1", "handoff"), undefined);
});

// ── session_tree ─────────────────────────────────────────────────────

test("session_tree invalidates a staged handoff and the handoff refusals", async () => {
	const pi = await createTestHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "first task" }, "first");
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);
	await assert.rejects(() => executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second"), (error: unknown) =>
		error instanceof Error && error.message === HANDOFF_ALREADY_STAGED);
	assert.equal((await toolCall(pi, "h1", "handoff")).block, true);

	await emitAll(pi, "session_tree", { type: "session_tree" }, ctx);

	await executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second");
	assert.equal(await toolCall(pi, "h1", "handoff"), undefined);
});

test("after a failed cut the run refuses further handoff calls until the agent settles", async () => {
	const { pi } = await boundaryHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);
	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.deepEqual(await toolCall(pi, "again", "handoff"), { block: true, reason: HANDOFF_FAILED_IN_RUN_REFUSAL, terminate: true });
	assert.equal(await toolCall(pi, "w1", "write"), undefined, "other tools are not refused for the failed cut");

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(await toolCall(pi, "again", "handoff"), undefined);
});

test("a declined handoff resolved at turn_start fails without starting a run and refuses a repeat call", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx, { toolResults: [handoffToolResult("call-1", true)] });

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assertFailedWithoutRun(state, pi);
	assert.deepEqual(await toolCall(pi, "again", "handoff"), { block: true, reason: HANDOFF_FAILED_IN_RUN_REFUSAL, terminate: true });
});

test("session_tree clears the failed-in-run refusal", async () => {
	const pi = await createTestHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);
	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);
	assert.equal((await toolCall(pi, "again", "handoff")).block, true);

	await emitAll(pi, "session_tree", { type: "session_tree" }, ctx);

	assert.equal(await toolCall(pi, "again", "handoff"), undefined);
});

test("the handoff tool definition declares model-only exposure", async () => {
	const { pi } = await boundaryHost();

	// The host does not model Pi's nested-call runner; the field is what Pi reads.
	assert.equal(pi.tools.get("handoff").exposure, "model-only");
});

// ── Registration order ───────────────────────────────────────────────

test("the boundary settles a failed handoff before the watchdog counts the run, so each failed attempt counts once", async () => {
	const pi = await createTestHost();
	const { ctx, notifications } = makeCtx();
	const warnings = () => notifications.filter((notification) => notification.level === "warning");
	const nudge = async () => {
		const result = await pi.handlers.get("context")![0](
			{ messages: [{ role: "user", content: "work", timestamp: 1 }] },
			ctx,
		);
		return result.messages.find((message: any) => message.customType === "pi-schematic-watchdog").content;
	};

	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => true } as any);
	for (let attempt = 1; attempt <= MAX_HANDOFF_ATTEMPTS; attempt++) {
		assert.match(await nudge(), /A real handoff is required/, `attempt ${attempt} is still nudged`);
		await executeHandoff(pi, ctx, { nextInstruction: "continue work" });
		await endTurn(pi, ctx, { toolResults: [] });
		await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

		assert.equal(warnings().length, attempt < MAX_HANDOFF_ATTEMPTS ? 0 : 1, `after failed attempt ${attempt}`);
	}

	assert.match(warnings()[0].message, new RegExp(`^Required handoff cancelled after ${MAX_HANDOFF_ATTEMPTS} attempts`));
});

/** The watchdog nudge the real context hook injects for `ctx`, or undefined when it injects none. */
async function watchdogNudge(pi: TestPI, ctx: unknown): Promise<string | undefined> {
	const [contextHook] = pi.handlers.get("context")!;
	const result = await contextHook({ messages: [{ role: "user", content: "work", timestamp: 1 }] }, ctx);
	return result?.messages.find((message: any) => message.customType === "pi-schematic-watchdog")?.content;
}

test("unready runs do not consume the enforcement budget", async () => {
	// Full host: the real context hook sends the not-ready nudge. Runs that carried only
	// that nudge must not count, so MAX_HANDOFF_ATTEMPTS of them leave the handoff pending.
	const pi = await createTestHost();
	const warnings: string[] = [];
	const small = makeCtx({ usage: { tokens: 5000, percent: 2.5, contextWindow: 200000 } });
	small.ctx.ui.notify = (message: string, level: string) => { if (level === "warning") warnings.push(message); };
	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => true } as any);

	for (let run = 0; run < MAX_HANDOFF_ATTEMPTS; run++) {
		assert.match(await watchdogNudge(pi, small.ctx) ?? "", /not yet ready for compaction/);
		await assert.rejects(() => executeHandoff(pi, small.ctx, { nextInstruction: "continue work" }, "small"));
		await emitAll(pi, "agent_settled", { type: "agent_settled" }, small.ctx);
	}

	assert.deepEqual(warnings, [], "runs nudged only to keep working must not cancel the handoff");
	assert.match(await watchdogNudge(pi, makeCtx().ctx) ?? "", /A real handoff is required/,
		"the handoff is still required once context is eligible");
});

test("a completed handoff clears the requested-handoff nudge", async () => {
	const pi = await createTestHost();
	const eligible = makeCtx();
	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => true } as any);
	assert.match(await watchdogNudge(pi, eligible.ctx) ?? "", /A real handoff is required/);
	await executeHandoff(pi, eligible.ctx, { nextInstruction: "continue work" });
	const result = await endTurn(pi, eligible.ctx);
	eligible.session.branch = persist(result.entries);

	await emitAll(pi, "turn_start", { type: "turn_start" }, eligible.ctx);

	assertSuccessorTurn(result.entries[1].content, { nextInstruction: "continue work" });
	assert.equal(await watchdogNudge(pi, eligible.ctx), undefined, "a completed handoff leaves no requested-handoff nudge");
});

test("/handoff sets the handoff status indicator", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});
	const statuses = new Map<string, string | undefined>();

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
		getContextUsage: () => null,
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");
});

test("/handoff shows ready status when context is eligible", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});
	const statuses = new Map<string, string | undefined>();

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
});

test("handoff status becomes ready when later context becomes eligible", async () => {
	const pi = await createTestHost();
	const statuses = new Map<string, string | undefined>();
	const commandContext = {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => null,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
	};
	await pi.commands.get("handoff")!.handler("implement auth", commandContext);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");

	const [context] = pi.handlers.get("context")!;
	await context(
		{ messages: [] },
		{
			hasUI: true,
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			ui: commandContext.ui,
		},
	);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
});

test("handoff rejects malformed numeric context usage", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	for (const usage of [
		{ tokens: Number.NaN, percent: 20, contextWindow: 200000 },
		{ tokens: Number.POSITIVE_INFINITY, percent: 20, contextWindow: 200000 },
		{ tokens: null, percent: Number.NaN, contextWindow: 200000 },
	]) {
		await assert.rejects(
			() => pi.tools.get("handoff").execute(
				"invalid-usage",
				{ nextInstruction: "continue work" },
				undefined,
				undefined,
				{ getContextUsage: () => usage },
			),
			/Context usage unavailable/,
		);
	}
});

test("turn_end fallback keeps requested handoff status sticky until real handoff happens", async () => {
	const pi = await createTestHost();
	const statuses = new Map<string, string | undefined>();
	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => null,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
	});

	await emitAll(pi, "turn_end", turnEndEvent(), {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");
});

test("handoff tool metadata and schema describe the prompt contract", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	const tool = pi.tools.get("handoff");
	assert.match(tool.description, /past ~30%/i);
	assert.match(tool.description, /call handoff/i);
	assert.match(tool.description, /current notebook/i);
	assert.match(tool.description, /Call handoff alone in its message: a handoff that shares a message with other tool calls is refused, and the other calls are handled on their own\./);
	assert.match(tool.promptGuidelines.join(" "), /preparation only/i);
	assert.doesNotMatch(`${tool.description} ${tool.promptGuidelines.join(" ")} ${JSON.stringify(tool.parameters)}`, /\bbrief\b/i);
	assert.doesNotMatch(`${tool.description} ${tool.promptGuidelines.join(" ")} ${JSON.stringify(tool.parameters)}`, /long-term/i,
		"handoff copy must not say long-term store; use reusable knowledge");
	assert.match(JSON.stringify(tool.parameters), /reusable knowledge/i);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /merely irrelevant|will not be needed again|permanently remove/i,
		"pruning policy must not require an unverifiable universal negative");
	assert.match(JSON.stringify(tool.parameters), /current state, blockers/i);
	assert.match(tool.promptGuidelines.join(" "), /current state, blockers, unresolved questions/i);
	// Every field is optional: a pending human direction makes nextInstruction
	// redundant, and a handoff with nothing to add makes context redundant. The
	// runtime guard rejects the one combination that cannot work: no instruction.
	assert.equal(Value.Check(tool.parameters, { nextInstruction: "continue work" }), true);
	assert.equal(Value.Check(tool.parameters, { context: "blocked on auth" }), true);
	assert.equal(Value.Check(tool.parameters, {}), true);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /"task"/, "the fused task field must be gone");
});

test("the continuation frame is pinned byte-for-byte", () => {
	// The frame is the only summary text a successor sees, so every byte is a contract.
	// Golden string, hand-written on purpose: comparing against buildContinuationFrame()
	// or loose regexes would pass vacuously if the frame copy regressed.
	// The frame carries no task or constraints: a frozen task invites paraphrase, and frozen
	// constraints lie after a /tree rollback.
	assert.equal(buildContinuationFrame(), [
		"## Handoff — Continue Previous Work",
		"",
		"You are continuing a previous agent's work in a clean context. Use the available knowledge correctly:",
		"- Notebook pages are a cache for this stream: code facts are re-derivable, while user guidance, decisions, and design live in pages — fetch them with `notebook_read`",
		"- The next message carries your instruction verbatim, plus the previous agent's remaining situational context",
		"- Use `notebook_index` to scan available pages when needed",
		"- Use `spawn` to delegate isolated subtasks to child agents",
		"- Build on notebook memory and the instruction rather than reconstructing old context",
	].join("\n"));
});

test("buildNextUserMessage carries the instruction verbatim and the context second", () => {
	const instruction = "  Refactor billing to use the shared meter.  ";
	assert.equal(
		buildNextUserMessage({ nextInstruction: instruction, context: "  blocked on the auth spike  " }),
		"## Next instruction\n\n  Refactor billing to use the shared meter.  \n\n## Context\n\nblocked on the auth spike",
	);
	assert.equal(
		buildNextUserMessage({ nextInstruction: "Refactor billing" }),
		"## Next instruction\n\nRefactor billing",
	);
	assert.equal(
		buildNextUserMessage({ nextInstruction: "Refactor billing", context: "   \n " }),
		"## Next instruction\n\nRefactor billing",
		"whitespace-only context adds no empty section",
	);
});

test("buildNextUserMessage preserves instruction bytes and normalizes context padding", async () => {
	await fc.assert(
		fc.property(
			// Blank instructions are rejected by validateHandoffRequest before the builder runs.
			fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0),
			fc.string(),
			(instruction, context) => {
				const message = buildNextUserMessage({ nextInstruction: instruction, context });
				assert.ok(
					message.startsWith(`## Next instruction\n\n${instruction}`),
					"the instruction must open the message byte-for-byte",
				);
				if (context.trim()) assert.ok(message.includes(context.trim()),
					"non-blank context must be preserved in the message");
				assert.equal(
					message,
					buildNextUserMessage({ nextInstruction: instruction, context: ` \n${context} ` }),
					"context padding must not change the delivered message",
				);
			},
		),
	);
});

test("handoff tool rejects an empty nextInstruction with context usage", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ percent: 42 }) },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Empty handoff nextInstruction rejected") &&
			error.message.includes("42%"),
	);

	assert.equal(state.stagedHandoff, null, "an empty instruction must not stage");
	assert.deepEqual(pi.sentUserMessages, [], "the error result is the only report; nothing queues for a later turn");
});

test("handoff tool rejects small session with clear error", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("handoff unavailable yet") &&
			error.message.includes("~3% (5000 tokens)") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.stagedHandoff, null, "small-session rejection must not stage");
});

test("a small-session rejection keeps the pending request and states it in the error without queuing a follow-up", async () => {
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null };
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);
	const notifications: Array<{ message: string; level: string }> = [];

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: (message: string, level: string) => { notifications.push({ message, level }); },
				},
				getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }),
			},
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("handoff unavailable yet") &&
			error.message.includes("The required handoff remains pending"),
	);

	assert.deepEqual(state.pendingRequestedHandoff, {
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	assert.deepEqual(notifications, [], "the error result is the only report of the rejection");
	assert.deepEqual(pi.sentUserMessages, []);
});

test("handoff tool rejects small session with null percent without crashing", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: 5000, percent: null, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("handoff unavailable yet") &&
			error.message.includes("(5000 tokens)") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.stagedHandoff, null, "null-percent rejection must not stage");
});

test("handoff tool rejects small session estimated from percent when tokens are unavailable", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: null, percent: 10, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("handoff unavailable yet") &&
			error.message.includes("~20000 tokens estimated from context usage") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.stagedHandoff, null, "estimated small-session rejection must not stage");
});

test("handoff tool accepts large estimated session when tokens are unavailable", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: null, percent: 20, contextWindow: 200000 }),
			},
		),
	);
	assert.equal(state.stagedHandoff?.phase, "staged", "an accepted handoff must stage");
});

test("handoff tool accepts the exact 30000-token minimum", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 30000, percent: 15, contextWindow: 200000 }),
			},
		),
	);
	assert.equal(state.stagedHandoff?.phase, "staged", "an accepted handoff must stage");
});

test("handoff tool rejects session just below the 30000-token minimum", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: 29999, percent: 15, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("handoff unavailable yet") &&
			error.message.includes("29999 tokens") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.stagedHandoff, null, "just-below-boundary rejection must not stage");
});

test("handoff tool rejects a whitespace-only nextInstruction", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "   \t\n " },
			undefined,
			undefined,
			{ getContextUsage: () => null },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Empty handoff nextInstruction rejected") &&
			error.message.includes("Context at ?"),
	);

	assert.equal(state.stagedHandoff, null);
});

test("/handoff queues as a followUp while a run is active", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});

	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => false } as any);

	assert.equal(pi.sentUserMessages[0]?.options?.deliverAs, "followUp",
		"a direction sent mid-run must queue instead of being rejected");
});

test("handoff tool ignores a legacy task field and rejects the resulting empty instruction", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	// The harness calls execute directly, bypassing Pi's schema validation. TypeBox
	// tolerates the unknown key, so this pins that the removed fused field is never
	// consumed as the instruction: with no nextInstruction the call fails loudly.
	await assert.rejects(
		() => pi.tools.get("handoff").execute("legacy-task", { task: "old field" } as any, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		}),
		/Empty handoff nextInstruction rejected/,
	);

	assert.equal(state.stagedHandoff, null, "a legacy task field must not stage");
});

test("handoff tool rejects when context usage is unavailable", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => null },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Context usage unavailable") &&
			error.message.includes("rejected"),
	);

	assert.equal(state.stagedHandoff, null, "unavailable usage must not stage");
});

test("an unavailable-usage rejection keeps the pending request and states it in the error without queuing a follow-up", async () => {
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null };
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);
	const notifications: Array<{ message: string; level: string }> = [];

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: (message: string, level: string) => { notifications.push({ message, level }); },
				},
				getContextUsage: () => null,
			},
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Context usage unavailable") &&
			error.message.includes("The required handoff remains pending"),
	);

	assert.deepEqual(state.pendingRequestedHandoff, {
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	assert.deepEqual(notifications, [], "the error result is the only report of the rejection");
	assert.deepEqual(pi.sentUserMessages, []);
});

test("handoff tool rejects when context usage cannot be estimated", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: null, percent: 20, contextWindow: null }) },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Context usage unavailable") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.stagedHandoff, null, "unestimable usage must not stage");
});

test("session_start new clears stale handoff status and warning widget", async () => {
	const pi = await createTestHost();
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "stale"]]);
	const widgets = new Map<string, string[] | undefined>([[WIDGET_KEY_WARNING, ["stale"]]]);
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: (key: string, value: string[] | undefined) => { widgets.set(key, value); },
		},
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => null,
	};
	await emitAll(pi, "session_start", { reason: "new" }, ctx);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.equal(widgets.get(WIDGET_KEY_WARNING), undefined);
});

