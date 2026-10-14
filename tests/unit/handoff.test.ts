import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { Value } from "typebox/value";
import { createState } from "../../state.js";
import type { SchematicState } from "../../state.js";
import { registerHandoffBoundary } from "../../handoff/boundary.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import {
	HANDOFF_ALREADY_STAGED,
	HANDOFF_COMMAND_BUSY,
	HANDOFF_EXTRA_CALL_REFUSAL,
	HANDOFF_SIBLING_REFUSAL,
	HANDOFF_STAGED_RESULT,
	HANDOFF_SUCCESSOR_NOT_RUN,
	REASON_ABORTED,
	REASON_NOT_PERSISTED,
	REASON_NO_BOUNDARY,
	REASON_RESULT_MISSING,
} from "../../handoff/copy.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { buildContinuationFrame, buildNextUserMessage } from "../../handoff/format.js";
import { STATUS_KEY_HANDOFF, WIDGET_KEY_WARNING } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
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
	const notifications: Array<{ message: string; level: string }> = [];
	const session = { branch: [] as any[], usage: options.usage === undefined ? ELIGIBLE_USAGE : options.usage };
	const ctx: any = {
		hasUI: options.hasUI ?? true,
		signal: options.aborted ? AbortSignal.abort() : undefined,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: () => {},
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
		},
		getContextUsage: () => session.usage,
		sessionManager: { getBranch: () => session.branch },
	};
	return { ctx, statuses, notifications, session };
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

	// Surrounding whitespace is normalized at the resolver; inner bytes preserved.
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
	const { ctx, statuses, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx, { discardPages: ["stale"] });
	const result = await endTurn(pi, ctx);
	session.branch = persist(result.entries);

	await emitAll(pi, "turn_start", { type: "turn_start" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(state.activeNotebookTopic, null);
	assert.equal(state.readonlyNudgePending, true);
	assert.deepEqual([...state.notebookPages], [["keep", "durable"]], "pages follow what the branch persisted");
	assert.equal(state.epoch, 2);
	assert.equal(statuses.has(STATUS_KEY_HANDOFF) && statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.deepEqual(notifications, [{ message: "Handoff complete. Notebook: 1 page kept, 1 discarded.", level: "info" }]);
	assert.deepEqual(pi.sentUserMessages, []);
	assert.deepEqual(pi.sentMessages, []);
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
	assert.deepEqual(pi.sentMessages, []);
	assert.equal(pi.sentUserMessages.length, 1);
	assert.equal(pi.sentUserMessages[0].content,
		`Handoff failed — ${REASON_NOT_PERSISTED}. The required handoff remains pending; retry when context usage is eligible.`);
	assert.deepEqual(pi.sentUserMessages[0].options, { deliverAs: "followUp" });
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
	assert.equal(statuses.has(STATUS_KEY_HANDOFF) && statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.match(pi.sentUserMessages[0].content, /No required handoff remains pending; retry when ready\.$/);
});

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

test("agent_settled fails a declined handoff with its decline reason as a follow-up", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx, { toolResults: [] });

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.deepEqual(pi.sentMessages, []);
	assert.match(pi.sentUserMessages[0].content, new RegExp(`^Handoff failed — ${REASON_RESULT_MISSING}\\.`));
	assert.deepEqual(pi.sentUserMessages[0].options, { deliverAs: "followUp" });
	assert.equal(notifications[0].level, "error");
});

test("agent_settled fails a handoff whose turn_end never ran", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.match(pi.sentUserMessages[0].content, new RegExp(`^Handoff failed — ${REASON_NO_BOUNDARY}\\.`));
	assert.deepEqual(notifications, [{ message: `Handoff failed: ${REASON_NO_BOUNDARY}. The handoff can be retried.`, level: "error" }]);
});

test("a handoff declined for an abort fails at agent_settled with a displayed message and starts no run", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, makeCtx({ aborted: true }).ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.deepEqual(pi.sentUserMessages, [], "an abort must not start a new run");
	assert.deepEqual(pi.sentMessages, [{
		message: {
			customType: "pi-schematic-handoff-failed",
			content: `Handoff failed — ${REASON_ABORTED}. The required handoff remains pending; retry when context usage is eligible.`,
			display: true,
		},
		options: { triggerTurn: false },
	}]);
	assert.deepEqual(notifications, [{ message: `Handoff failed: ${REASON_ABORTED}. The handoff can be retried.`, level: "error" }]);
});

test("a run that settles aborted before its turn_end fails the handoff as aborted and starts no run", async () => {
	const { state, pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: true }, ctx);

	assert.equal(state.stagedHandoff, null);
	assert.deepEqual(pi.sentUserMessages, [], "an abort must not start a new run");
	assert.equal(pi.sentMessages.length, 1);
	assert.equal(pi.sentMessages[0].message.content,
		`Handoff failed — ${REASON_ABORTED}. The required handoff remains pending; retry when context usage is eligible.`);
	assert.deepEqual(pi.sentMessages[0].options, { triggerTurn: false });
});

test("a run that settles aborted without the submitted cut reports the missing cut and starts no run", async () => {
	const { pi } = await boundaryHost((s) => requestHandoff(s));
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: true }, ctx);

	assert.deepEqual(pi.sentUserMessages, [], "an abort must not start a new run");
	assert.equal(pi.sentMessages.length, 1);
	assert.match(pi.sentMessages[0].message.content, new RegExp(`^Handoff failed — ${REASON_NOT_PERSISTED.replace(/[()]/g, "\\$&")}\\.`));
	assert.deepEqual(pi.sentMessages[0].options, { triggerTurn: false });
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

test("calls sharing an assistant message with handoff are refused and the first handoff runs", async () => {
	const { pi } = await boundaryHost();
	await callHandlers(pi, "message_end", assistantMessage(
		{ id: "w1", name: "write" },
		{ id: "h1", name: "handoff" },
		{ id: "n1", name: "notebook_write" },
		{ id: "h2", name: "handoff" },
	), makeCtx().ctx);

	assert.equal(await toolCall(pi, "h1", "handoff"), undefined);
	assert.deepEqual(await toolCall(pi, "w1", "write"), { block: true, reason: HANDOFF_SIBLING_REFUSAL, terminate: true });
	assert.deepEqual(await toolCall(pi, "n1", "notebook_write"), { block: true, reason: HANDOFF_SIBLING_REFUSAL, terminate: true });
	assert.deepEqual(await toolCall(pi, "h2", "handoff"), { block: true, reason: HANDOFF_EXTRA_CALL_REFUSAL, terminate: true });
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
	assert.equal((await toolCall(pi, "w1", "write")).block, true, "a tool result message must not clear refusals");

	await callHandlers(pi, "message_end", assistantMessage({ id: "w2", name: "write" }), ctx);
	assert.equal(await toolCall(pi, "w1", "write"), undefined, "the next assistant message clears the previous refusals");
});

test("turn_end clears the refusals", async () => {
	const { pi } = await boundaryHost();
	const ctx = makeCtx().ctx;
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);

	await callHandlers(pi, "turn_end", turnEndEvent(), ctx);

	assert.equal(await toolCall(pi, "w1", "write"), undefined);
});

// ── session_tree ─────────────────────────────────────────────────────

test("session_tree invalidates a staged handoff and the sibling refusals", async () => {
	const pi = await createTestHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "first task" }, "first");
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);
	await assert.rejects(() => executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second"), (error: unknown) =>
		error instanceof Error && error.message === HANDOFF_ALREADY_STAGED);
	assert.equal((await toolCall(pi, "w1", "write")).block, true);

	await emitAll(pi, "session_tree", { type: "session_tree" }, ctx);

	await executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second");
	assert.equal(await toolCall(pi, "w1", "write"), undefined);
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

test("unready runs do not consume the enforcement budget, and a completed handoff clears the nudge", async () => {
	// Full host: the real context hook sends the not-ready nudge. Runs that carried only
	// that nudge must not count, so MAX_HANDOFF_ATTEMPTS of them leave the handoff pending.
	const pi = await createTestHost();
	const [contextHook] = pi.handlers.get("context")!;
	const smallUsage = { tokens: 5000, percent: 2.5, contextWindow: 200000 };
	const warnings: string[] = [];
	const runContextHook = async (ctx: any): Promise<string | undefined> => {
		const result = await contextHook({ messages: [{ role: "user", content: "work", timestamp: 1 }] }, ctx);
		return result?.messages.find((message: any) => message.customType === "pi-schematic-watchdog")?.content;
	};
	const small = makeCtx({ usage: smallUsage });
	small.ctx.ui.notify = (message: string, level: string) => { if (level === "warning") warnings.push(message); };
	const eligible = makeCtx();

	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => true } as any);
	for (let run = 0; run < MAX_HANDOFF_ATTEMPTS; run++) {
		assert.match(await runContextHook(small.ctx) ?? "", /not yet ready for compaction/);
		await assert.rejects(() => executeHandoff(pi, small.ctx, { nextInstruction: "continue work" }, "small"));
		await emitAll(pi, "agent_settled", { type: "agent_settled" }, small.ctx);
	}
	assert.deepEqual(warnings, [], "runs nudged only to keep working must not cancel the handoff");

	assert.match(await runContextHook(eligible.ctx) ?? "", /A real handoff is required/);
	await executeHandoff(pi, eligible.ctx, { nextInstruction: "continue work" }, "eligible");
	const result = await endTurn(pi, eligible.ctx, {}, "eligible");
	eligible.session.branch = persist(result.entries);
	await emitAll(pi, "turn_start", { type: "turn_start" }, eligible.ctx);

	assertSuccessorTurn(result.entries[1].content, { nextInstruction: "continue work" });
	assert.equal(await runContextHook(eligible.ctx), undefined, "a completed handoff leaves no requested-handoff nudge");
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
	assert.match(tool.description, /Call handoff alone: other tool calls in the same message are not run\./);
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

test("the continuation frame is constant and carries no task or constraints", () => {
	const summary = buildContinuationFrame();

	assert.match(summary, /continuing a previous agent's work in a clean context/i);
	assert.match(summary, /notebook_read/);
	assert.match(summary, /notebook_index/);
	assert.match(summary, /spawn/);
	assert.match(summary, /cache/i);
	assert.match(summary, /instruction verbatim/i);
	assert.doesNotMatch(summary, /durable grounding/i);
	assert.doesNotMatch(summary, /\bbrief\b/i);
	// A frozen task invites paraphrase; frozen constraints lie after a /tree rollback.
	assert.doesNotMatch(summary, /## Task/);
	assert.doesNotMatch(summary, /Execution Constraints/i);
	assert.doesNotMatch(summary, /readonly/i);
});

test("the continuation frame is pinned byte-for-byte", () => {
	// Golden string, hand-written on purpose: comparing against buildContinuationFrame()
	// or loose regexes would pass vacuously if the frame copy regressed. This frame is
	// the only summary text a successor sees, so every byte is a contract.
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

test("handoff tool preserves pending requested handoff and re-engages LLM after synchronous small-session rejection", async () => {
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
	);

	assert.deepEqual(state.pendingRequestedHandoff, {
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	// sendHandoffFailure re-engages the LLM
	assert.ok(pi.sentUserMessages.length > 0);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);
	assert.equal(pi.sentUserMessages.at(-1)?.options?.deliverAs, "followUp",
		"failure guidance must queue while the agent run is active");
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /required handoff remains pending/);
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

test("handoff tool preserves pending requested handoff and re-engages LLM after synchronous unavailable-usage rejection", async () => {
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
	);

	assert.deepEqual(state.pendingRequestedHandoff, {
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	// sendHandoffFailure re-engages the LLM
	assert.ok(pi.sentUserMessages.length > 0);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /required handoff remains pending/);
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

