import { expect, test } from "vitest";
import { expectPrefix, expectSuffix } from "../assertions.js";
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
	REASON_SUCCESSOR_NOT_PERSISTED,
	REASON_TURN_FAILED,
} from "../../handoff/copy.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import {
	buildContinuationFrame,
	buildNextUserMessage,
	formatHandoffFailure,
	formatLostSuccessorFailure,
} from "../../handoff/format.js";
import { STATUS_KEY_HANDOFF, STATUS_KEY_NOTEBOOK, STATUS_KEY_TOPIC, WIDGET_KEY_WARNING } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS, registerWatchdog } from "../../watchdog.js";
import {
	SessionManager,
	type ContextEvent,
	type ContextUsage,
	type CustomMessageEntryDraft,
	type ExtensionContext,
	type ExtensionToolContext,
	type SessionBoundaryDraft,
	type SessionEntry,
	type ToolCallEventResult,
	type TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { assertPresent } from "../assertions.js";
import {
	callHandlers,
	createCommandContext,
	createExtensionContext,
	createToolContext,
	createUIContext,
	emitAll,
	handoffToolResult,
	makeTUICtx,
	turnEndEvent,
} from "./helpers.js";
import {
	createTestHost,
	getCommand,
	getHandlers,
	getHostRecords,
	getTool,
	invokeHandler,
	type HostEvent,
	type HostEventName,
	type HostEventResult,
	type TestPI,
} from "./test-host.js";

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
	if (context) {expected.push(`## Context\n\n${context}`);}
	const prefix = expected.join("\n\n");
	expectPrefix(content, prefix, "successor turn must start with the delivered instruction and context:");
}

const ELIGIBLE_USAGE: ContextUsage = { tokens: 50_000, percent: 25, contextWindow: 200_000 };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Recording UI context; `session.branch` is what `sessionManager.getBranch()` returns. */
function makeCtx(options: { usage?: ContextUsage; aborted?: boolean; hasUI?: boolean } = {}) {
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const notifications: { message: string; level: string | undefined }[] = [];
	const session: { branch: SessionEntry[]; usage: ContextUsage | undefined } = { branch: [], usage: options.usage ?? ELIGIBLE_USAGE };
	const ctx = createToolContext({
		hasUI: options.hasUI ?? true,
		signal: options.aborted === true ? AbortSignal.abort() : undefined,
		ui: createUIContext({
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: (key: string, value: string[] | ((...args: never[]) => unknown) | undefined) => {
				if (typeof value === "function") {throw new Error("This test context records only text widgets.");}
				widgets.set(key, value);
			},
			notify: (message: string, level?: string) => { notifications.push({ message, level }); },
		}),
		getContextUsage: () => session.usage,
		sessionManager: branchOnlySessionManager(() => session.branch),
	});
	return { ctx, statuses, widgets, notifications, session };
}

// The methods `SessionManager` declares.
const SESSION_MANAGER_METHODS = new Set(Object.getOwnPropertyNames(SessionManager.prototype).filter((name) => name !== "constructor"));

/**
 * A session manager whose `getBranch` returns `branch()`; calling any other
 * `SessionManager` method throws naming it, so code that reads more of the session
 * than its branch fails instead of answering from an empty session.
 */
function branchOnlySessionManager(branch: () => SessionEntry[]): SessionManager {
	return new Proxy(SessionManager.inMemory(), {
		get(manager, property, receiver) {
			if (property === "getBranch") {return branch;}
			if (typeof property === "string" && SESSION_MANAGER_METHODS.has(property)) {
				return () => {
					throw new Error(`ctx.sessionManager.${property} is not stubbed in this test context; only getBranch is.`);
				};
			}
			const value: unknown = Reflect.get(manager, property, receiver);
			return value;
		},
	});
}

/**
 * Runs every `event` handler in registration order on the same payload and
 * returns the first result a handler returned. pi's chaining of `turn_end`
 * results into the next handler's event and its stop at the first blocking
 * `tool_call` result are not emulated.
 */
async function firstHandlerResult<K extends HostEventName>(
	pi: TestPI,
	event: K,
	payload: HostEvent<K>,
	ctx: ExtensionContext,
): Promise<HostEventResult<K> | undefined> {
	const results: (HostEventResult<K> | undefined)[] = [];
	for (const handler of getHandlers(pi, event)) {
		const result = await handler(payload, ctx);
		results.push(result === undefined ? undefined : result);
	}
	return results.find((result) => result !== undefined);
}

/** The entries of a boundary result; throws when there is no result or it carries no entries. */
function boundaryEntries(result: TurnEndEventResult | undefined): SessionBoundaryDraft[] {
	if (result?.entries === undefined) {throw new Error("turn_end returned no boundary entries.");}
	return result.entries;
}

/** `draft` as a custom-message draft; throws on any other draft. */
function customMessageDraft(draft: SessionBoundaryDraft | undefined): CustomMessageEntryDraft {
	if (draft?.type !== "custom_message") {throw new Error(`Expected a custom_message draft, got ${draft?.type ?? "none"}.`);}
	return draft;
}

/** The text of a custom-message draft; throws on any other draft or on non-text content. */
function customMessageText(draft: SessionBoundaryDraft | undefined): string {
	const { content } = customMessageDraft(draft);
	if (typeof content !== "string") {throw new Error("The custom_message draft has no text content.");}
	return content;
}

/** The `epoch` in a custom draft's data; `undefined` for any other draft and for data without an `epoch`. */
function customDraftEpoch(draft: SessionBoundaryDraft): unknown {
	if (draft.type !== "custom" || typeof draft.data !== "object" || draft.data === null || !("epoch" in draft.data)) {return undefined;}
	return draft.data.epoch;
}

/** The text of the message the host recorded at `index` of its `pi.sendMessage` calls; throws unless it is text. */
function sentMessageText(pi: TestPI, index: number): string {
	const content = getHostRecords(pi).sentMessages[index]?.message.content;
	if (typeof content !== "string") {throw new Error(`The sent message at index ${String(index)} has no text content.`);}
	return content;
}

const ignore = (): void => undefined;

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

function executeHandoff(pi: TestPI, ctx: ExtensionToolContext, params: Record<string, unknown> = { nextInstruction: "continue work", context: "state" }, toolCallId = "call-1") {
	return getTool(pi, "handoff").execute(toolCallId, params, undefined, undefined, ctx);
}

/** Run the turn_end handlers and return the boundary result (the one handler that answers). */
async function endTurn(pi: TestPI, ctx: ExtensionContext, overrides: Parameters<typeof turnEndEvent>[0] = {}, toolCallId = "call-1"): Promise<TurnEndEventResult | undefined> {
	return firstHandlerResult(pi, "turn_end", turnEndEvent({ toolResults: [handoffToolResult(toolCallId)], ...overrides }), ctx);
}

/**
 * What pi persists for submitted drafts: the same entries with ids and parents. A
 * compaction also gets the fields pi adds: a draft without a first kept entry keeps
 * itself, and `tokensBefore` is a placeholder the extension never reads.
 */
function persist(drafts: readonly SessionBoundaryDraft[]): SessionEntry[] {
	return drafts.map((draft, index): SessionEntry => {
		const id = `entry-${index}`;
		const persisted = { id, parentId: index === 0 ? null : `entry-${index - 1}`, timestamp: "2026-01-01T00:00:00.000Z" };
		if (draft.type !== "compaction") {return { ...draft, ...persisted };}
		return { ...draft, ...persisted, firstKeptEntryId: draft.firstKeptEntryId ?? id, tokensBefore: 0, fromHook: true };
	});
}

/** A failed handoff stages nothing, starts no run and reports through one displayed message; returns its content. */
function assertFailedWithoutRun(state: SchematicState, pi: TestPI): string {
	const { sentMessages, sentUserMessages } = getHostRecords(pi);
	expect(state.stagedHandoff).toBeNull();
	expect(sentUserMessages, "a failed handoff must not start a new run").toStrictEqual([]);
	const content = sentMessageText(pi, 0);
	expect(sentMessages).toStrictEqual([{
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

	await getCommand(pi, "handoff").handler("implement auth", createCommandContext({
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => undefined,
		ui: createUIContext({ notify: (_message: string) => {}, setStatus: ignore }),
	}));

	expect(state.pendingRequestedHandoff).toStrictEqual({
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		toolCalled: false,
		nextInstruction: "implement auth",
	});
	expect(pi.sentUserMessages).toHaveLength(1);
	expect(pi.sentUserMessages[0].content).toMatch(/<next-instruction>\nimplement auth\n<\/next-instruction>/);
	expect(pi.sentUserMessages[0].content).toMatch(/Do NOT start this instruction/);
	expect(pi.sentUserMessages[0].content).toMatch(/discarded at compaction/);
	expect(pi.sentUserMessages[0].content).toMatch(/Curate the notebook/);
	expect(pi.sentUserMessages[0].content).toMatch(/Call the handoff tool with `context`/);
	expect(pi.sentUserMessages[0].content).toMatch(/non-recoverable knowledge/i);
	expect(pi.sentUserMessages[0].content).toMatch(/A real handoff is required in the current session/);
	expect(pi.sentUserMessages[0].content).not.toMatch(/User explicitly requested|\/handoff/);
	expect(pi.sentUserMessages[0].content).not.toMatch(/\bbrief\b/i);
	expect(pi.sentUserMessages[0].options).toBeUndefined();
});

test("/handoff requires a direction", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});

	const notifications: string[] = [];
	await getCommand(pi, "handoff").handler("   ", createCommandContext({
		hasUI: true,
		isIdle: () => true,
		ui: createUIContext({ notify: (message: string) => notifications.push(message) }),
	}));

	expect(notifications).toStrictEqual(["Usage: /handoff <direction>"]);
	expect(pi.sentUserMessages).toStrictEqual([]);
});

// ── Staging (the handoff tool) ───────────────────────────────────────

test("handoff stages the request, marks it called, shows progress and appends nothing", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, statuses } = makeCtx();

	const result = await executeHandoff(pi, ctx, {
		nextInstruction: "Goal: continue auth-refresh",
		context: "blocked on the token spike",
		discardPages: ["stale", "stale", "old"],
	});

	expect(result).toStrictEqual({
		content: [{ type: "text", text: HANDOFF_STAGED_RESULT }],
		details: {},
		terminate: true,
	});
	const stagedHandoff = state.stagedHandoff;
	assertPresent(stagedHandoff, "the handoff is staged");
	const { handoffId, ...staged } = stagedHandoff;
	expect(handoffId).toMatch(UUID_PATTERN);
	expect(staged).toStrictEqual({
		toolCallId: "call-1",
		nextInstruction: "Goal: continue auth-refresh",
		context: "blocked on the token spike",
		discardPages: ["stale", "old"],
		discardedPages: [],
		phase: "staged",
		declineReason: null,
	});
	expect(state.pendingRequestedHandoff?.toolCalled).toBe(true);
	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff in progress");
	expect(pi.appendedEntries).toStrictEqual([]);
	expect(pi.sentMessages).toStrictEqual([]);
	expect(pi.sentUserMessages).toStrictEqual([]);
});

test("a pending human direction wins over a model-supplied nextInstruction in the staged request", async () => {
	const { state, pi } = await boundaryHost();
	const direction = "  Audit the retry budget.  ";
	await getCommand(pi, "handoff").handler(direction, createCommandContext({ isIdle: () => true, getContextUsage: () => undefined }));

	await executeHandoff(pi, makeCtx().ctx, {
		nextInstruction: "Verify the audit is done",
		context: "state machine rebuilt from scratch",
	});

	expect(state.stagedHandoff?.nextInstruction).toBe("Audit the retry budget.");
	expect(state.stagedHandoff?.context).toBe("state machine rebuilt from scratch");
});

test("a pending human direction needs no tool arguments", async () => {
	const { state, pi } = await boundaryHost();
	await getCommand(pi, "handoff").handler("finish the migration", createCommandContext({ isIdle: () => true }));

	await executeHandoff(pi, makeCtx().ctx, {});

	expect(state.stagedHandoff?.nextInstruction).toBe("finish the migration");
	expect(state.stagedHandoff?.context).toBe("");
});

test("handoff with no pending direction requires nextInstruction but not context", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx } = makeCtx();

	await expect(executeHandoff(pi, ctx, { context: "only context" })).rejects.toThrow(/Empty handoff nextInstruction rejected/);
	expect(state.stagedHandoff, "a rejected call must not stage").toBeNull();

	await executeHandoff(pi, ctx, { nextInstruction: "  Ship the fix  " });

	// Surrounding whitespace is trimmed.
	expect((state.stagedHandoff)?.nextInstruction).toBe("Ship the fix");
	expect((state.stagedHandoff)?.context).toBe("");
});

test("handoff is rejected while another handoff is staged, and /handoff reports it busy", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "first task" }, "first");

	await expect(executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second")).rejects.toThrow(new Error(HANDOFF_ALREADY_STAGED));
	await expect(getCommand(pi, "handoff").handler("replacement direction", createCommandContext({ isIdle: () => true }))).rejects.toThrow(new Error(HANDOFF_COMMAND_BUSY));

	expect(state.stagedHandoff?.nextInstruction, "the first staged request must survive").toBe("first task");
	expect(state.stagedHandoff?.toolCallId).toBe("first");
	expect(state.pendingRequestedHandoff, "a rejected /handoff must not store its direction").toBeNull();
});

// ── turn_end: the boundary drafts ────────────────────────────────────

test("turn_end appends the cut, successor and note after the existing entries and continues", async () => {
	const { state, pi } = await boundaryHost();
	await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "Goal: ship", context: "left off at step 3" });
	const stagedHandoff = state.stagedHandoff;
	assertPresent(stagedHandoff, "the handoff is staged");
	const handoffId = stagedHandoff.handoffId;
	const foreign: SessionBoundaryDraft = { type: "custom", customType: "other-extension", data: { kept: true } };

	const result = await endTurn(pi, makeCtx().ctx, { entries: [foreign] });

	expect(result).toStrictEqual({
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
				content: "The system prompt above was written before this handoff and is refreshed when the next run starts; a message typed during this run does not refresh it. Until then, ignore its notebook topic (the topic is cleared) and its notebook page list (use `notebook_index` for the current pages).",
				display: false,
				details: { handoffId },
			},
		],
		continue: true,
	});
	expect(state.stagedHandoff?.phase).toBe("submitted");
});

test("turn_end with discardPages writes the notebook rewrite before the cut", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("stale", "obsolete");
		s.notebookPages.set("keep", "durable");
		s.clippedPages.add("keep");
	});
	await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "go", discardPages: ["stale", "ghost"] });
	const stagedHandoff = state.stagedHandoff;
	assertPresent(stagedHandoff, "the handoff is staged");
	const handoffId = stagedHandoff.handoffId;

	const result = await endTurn(pi, makeCtx().ctx);

	expect(boundaryEntries(result).slice(0, 3)).toStrictEqual([
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "keep", content: "durable", clipped: true } },
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 2 } },
	]);
	expect(boundaryEntries(result)[3].type).toBe("compaction");
	expect(customMessageDraft(boundaryEntries(result)[4]).details).toStrictEqual({ handoffId });
	expect(state.stagedHandoff?.discardedPages, "only the requested page that existed is discarded").toStrictEqual(["stale"]);
	expect([...state.notebookPages.keys()], "the in-memory notebook changes only once the cut is confirmed").toContain("stale");
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

	const epochs = boundaryEntries(result).map(customDraftEpoch);
	expect(epochs.slice(0, 3)).toStrictEqual([1, 4, 4]);
});

test.for([{ discardPages: [] }, { discardPages: ["ghost"] }])("turn_end adds no notebook entries when discardPages is empty or names no page (when discardPages is $discardPages)", async ({ discardPages }) => {
	const { pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("keep", "durable");
	});
	await executeHandoff(pi, makeCtx().ctx, { nextInstruction: "go", discardPages });

	const result = await endTurn(pi, makeCtx().ctx);

	expect(boundaryEntries(result).map((entry) => entry.type), `discardPages ${JSON.stringify(discardPages)}`).toStrictEqual(["compaction", "custom_message", "custom_message"]);
});

const declineCases: { name: string; reason: string; ctx?: { aborted: boolean }; event: Parameters<typeof turnEndEvent>[0] }[] = [
	{ name: "ctx.signal aborted", reason: REASON_ABORTED, ctx: { aborted: true }, event: {} },
	{ name: "outcome aborted", reason: REASON_ABORTED, event: { outcome: "aborted" } },
	{ name: "outcome error", reason: REASON_TURN_FAILED, event: { outcome: "error" } },
	{ name: "result missing", reason: REASON_RESULT_MISSING, event: { toolResults: [] } },
	{ name: "result for another call", reason: REASON_RESULT_MISSING, event: { toolResults: [handoffToolResult("other-call")] } },
	{ name: "result is an error", reason: REASON_RESULT_MISSING, event: { toolResults: [handoffToolResult("call-1", true)] } },
];

test.for(declineCases)("turn_end declines the cut when $name", async ({ name, reason, ctx, event }) => {
	const { state, pi } = await boundaryHost();
	await executeHandoff(pi, makeCtx().ctx);

	const results = await callHandlers(pi, "turn_end", turnEndEvent({ toolResults: [handoffToolResult("call-1")], ...event }), makeCtx(ctx).ctx);

	expect(results, name).toStrictEqual([undefined]);
	expect(state.stagedHandoff).toMatchObject({ phase: "declined", declineReason: reason });
});

test("turn_end without a staged handoff returns nothing", async () => {
	const { pi } = await boundaryHost();

	expect(await callHandlers(pi, "turn_end", turnEndEvent(), makeCtx().ctx)).toStrictEqual([undefined]);
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
	session.branch = persist(boundaryEntries(result));
	widgets.set(WIDGET_KEY_WARNING, ["⚠ Context at 85% — readonly"]);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff).toBeNull();
	expect(state.activeNotebookTopic).toBeNull();
	expect(state.readonlyNudgePending).toBe(true);
	expect([...state.notebookPages], "pages follow what the branch persisted").toStrictEqual([["keep", "durable"]]);
	expect(state.epoch).toBe(2);
	expect(statuses.get(STATUS_KEY_HANDOFF), "the in-progress status the tool set is cleared").toBeUndefined();
	expect(notifications).toStrictEqual([{ message: "Handoff complete. Notebook: 1 page kept, 1 discarded.", level: "info" }]);
	expect(statuses.get(STATUS_KEY_TOPIC), "the topic indicator shows the cleared topic").toBe("🧭 -");
	expect(statuses.get(STATUS_KEY_NOTEBOOK), "the notebook indicator shows the kept pages").toBe("📒 1");
	expect(widgets.get(WIDGET_KEY_WARNING), "the high-context warning is cleared").toBeUndefined();
	expect(pi.sentUserMessages).toStrictEqual([]);
	expect(pi.sentMessages).toStrictEqual([]);
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
		...boundaryEntries(result),
	]);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.notebookPages.size, "the pages survive, so the plain form does not depend on an empty notebook").toBe(2);
	expect(notifications).toStrictEqual([{ message: "Handoff complete.", level: "info" }]);
});

test("a discard naming no page reports the kept pages without a discarded count", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("a", "one");
		s.notebookPages.set("b", "two");
	});
	const { ctx, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "go", discardPages: ["ghost"] });
	const stagedHandoff = state.stagedHandoff;
	assertPresent(stagedHandoff, "the handoff is staged");
	const handoffId = stagedHandoff.handoffId;
	const result = await endTurn(pi, ctx);
	session.branch = persist([
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "a", content: "one", clipped: false } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "b", content: "two", clipped: false } },
		...boundaryEntries(result),
	]);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(notifications).toStrictEqual([{ message: "Handoff complete. Notebook: 2 pages kept.", level: "info" }]);
});

test("a discard dropped from the boundary is counted from the branch and warned about", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("a", "one");
		s.notebookPages.set("stale", "obsolete");
	});
	const { ctx, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "go", discardPages: ["stale"] });
	const result = await endTurn(pi, ctx);
	// Another extension's turn_end handler keeps the cut, successor and note but drops the notebook rewrite.
	session.branch = persist([
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "a", content: "one", clipped: false } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "stale", content: "obsolete", clipped: false } },
		...boundaryEntries(result).filter((entry) => entry.type !== "custom"),
	]);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.notebookPages.get("stale"), "the page stays on the branch").toBe("obsolete");
	expect(notifications).toStrictEqual([
		{ message: "Handoff complete. Notebook: 2 pages kept.", level: "info" },
		{ message: "The notebook discard was not persisted (another extension's turn_end handler may have dropped it); still in the notebook: stale.", level: "warning" },
	]);
});

test("a page created under a requested discard name after staging is neither counted nor warned about", async () => {
	const { state, pi } = await boundaryHost((s) => {
		s.epoch = 1;
		s.notebookPages.set("stale", "obsolete");
	});
	const { ctx, notifications, session } = makeCtx();
	// "ghost" names no page when the boundary is built, so the drafts discard only "stale".
	await executeHandoff(pi, ctx, { nextInstruction: "go", discardPages: ["stale", "ghost"] });
	const result = await endTurn(pi, ctx);
	// Another extension's turn_end handler keeps the boundary and adds a page named
	// by the request, which never existed when the boundary was built and was never discarded.
	session.branch = persist([
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "stale", content: "obsolete", clipped: false } },
		...boundaryEntries(result),
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "ghost", content: "created after staging", clipped: false } },
	]);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect([...state.notebookPages], "the page added after staging survives").toStrictEqual([["ghost", "created after staging"]]);
	expect(notifications).toStrictEqual([
		{ message: "Handoff complete. Notebook: 1 page kept, 1 discarded.", level: "info" },
	]);
});

test("a completed handoff leaves the readonly nudge off when readonly is off", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx, session } = makeCtx();
	await executeHandoff(pi, ctx);
	session.branch = persist(boundaryEntries(await endTurn(pi, ctx)));

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.stagedHandoff).toBeNull();
	expect(state.readonlyNudgePending).toBe(false);
});

test("turn_start leaves a handoff staged until its turn_end has run", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.stagedHandoff?.phase).toBe("staged");
	expect(notifications).toStrictEqual([]);
	expect(pi.sentUserMessages).toStrictEqual([]);
});

test("turn_start without the cut on the branch fails the handoff and keeps the request retryable", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s, "implement auth"); });
	const { ctx, statuses, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff).toStrictEqual({
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: "implement auth",
	});
	expect(pi.sentUserMessages, "a missing cut never starts a run").toStrictEqual([]);
	expect(pi.sentMessages).toStrictEqual([{
		message: {
			customType: "pi-schematic-handoff-failed",
			content: `Handoff failed — ${REASON_NOT_PERSISTED}. The required handoff remains pending; retry when context usage is eligible.`,
			display: true,
		},
		options: { triggerTurn: false },
	}]);
	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff required — ready to compact");
	expect(notifications).toStrictEqual([{ message: `Handoff failed: ${REASON_NOT_PERSISTED}. The handoff can be retried.`, level: "error" }]);
});

test("a failed handoff shows the waiting status when usage becomes unavailable", async () => {
	const { pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, statuses, session } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);
	session.usage = undefined;

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff requested — waiting for eligible context");
});

test("a failed handoff without a pending request clears the status and says nothing remains pending", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx, statuses } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	const { sentMessages, sentUserMessages } = getHostRecords(pi);
	expect(state.pendingRequestedHandoff).toBeNull();
	expect(statuses.get(STATUS_KEY_HANDOFF), "the in-progress status the tool set is cleared").toBeUndefined();
	expect(sentUserMessages).toStrictEqual([]);
	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0].message.customType).toBe("pi-schematic-handoff-failed");
	expect(sentMessages[0].message.display).toBe(true);
	expectSuffix(sentMessageText(pi, 0), "No required handoff remains pending; retry when ready.");
	expect(sentMessages[0].options).toStrictEqual({ triggerTurn: false });
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

		await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

		if (requestSurvives) {expect(state.pendingRequestedHandoff).not.toBeNull();}
		else {expect(state.pendingRequestedHandoff).toBeNull();}
		expect(getHostRecords(pi).sentMessages).toHaveLength(1);
		expectSuffix(sentMessageText(pi, 0), requestSurvives
			? "The required handoff remains pending; retry when context usage is eligible."
			: "No required handoff remains pending; retry when ready.");
		expect(statuses.get(STATUS_KEY_HANDOFF)).toBe(requestSurvives ? "🤝 Handoff required — ready to compact" : undefined);
		expect(notifications[0]?.message).toBe(`Handoff failed: ${REASON_NOT_PERSISTED}. The handoff can be retried.`);
	});
}

test("agent_settled with the cut on the branch completes with the successor-did-not-run warning", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, notifications, session } = makeCtx();
	await executeHandoff(pi, ctx);
	session.branch = persist(boundaryEntries(await endTurn(pi, ctx)));

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff).toBeNull();
	expect(notifications).toStrictEqual([{ message: HANDOFF_SUCCESSOR_NOT_RUN, level: "warning" }]);
	expect(pi.sentUserMessages).toStrictEqual([]);
});

test("agent_settled fails a declined handoff with its decline reason in a displayed message and starts no run", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx, { toolResults: [] });

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expectPrefix(assertFailedWithoutRun(state, pi), `Handoff failed — ${REASON_RESULT_MISSING}.`);
	expect(notifications[0].level).toBe("error");
});

test("agent_settled fails a handoff whose turn_end never ran", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expectPrefix(assertFailedWithoutRun(state, pi), `Handoff failed — ${REASON_NO_BOUNDARY}.`);
	expect(notifications).toStrictEqual([{ message: `Handoff failed: ${REASON_NO_BOUNDARY}. The handoff can be retried.`, level: "error" }]);
});

test("a handoff declined for an abort fails at agent_settled with a displayed message and starts no run", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, notifications } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, makeCtx({ aborted: true }).ctx);

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	expect(state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expect(assertFailedWithoutRun(state, pi)).toBe(`Handoff failed — ${REASON_ABORTED}. The required handoff remains pending; retry when context usage is eligible.`);
	expect(notifications).toStrictEqual([{ message: `Handoff failed: ${REASON_ABORTED}. The handoff can be retried.`, level: "error" }]);
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
	session.branch = persist(boundaryEntries(result).filter((entry) => entry.type !== "compaction"));
	const expected = createState();
	reconstructNotebook(expected, session.branch);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.stagedHandoff).toBeNull();
	expect(getHostRecords(pi).sentMessages[0].message.customType).toBe("pi-schematic-handoff-failed");
	expect([...state.notebookPages], "the discard drafts persisted, so the discard applies").toStrictEqual([["keep", "durable"]]);
	expect(state.epoch).toBe(2);
	expect([...state.notebookPages]).toStrictEqual([...expected.notebookPages]);
	expect(state.epoch).toBe(expected.epoch);
	expect(state.discardEpochWatermark).toBe(expected.discardEpochWatermark);
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
	const persistedNotebook: SessionBoundaryDraft[] = [
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		...["stale", "keep", "other"].map((name): SessionBoundaryDraft => ({
			type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name, content: state.notebookPages.get(name), clipped: false },
		})),
	];
	session.branch = persist(persistedNotebook);
	await executeHandoff(pi, ctx, { nextInstruction: "first model instruction", discardPages: ["other"] }, "first");
	await endTurn(pi, ctx, {}, "first");
	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff?.nextInstruction, "the failed cut keeps the request pending").toBe("human direction");

	await executeHandoff(pi, ctx, { nextInstruction: "second model instruction", discardPages: ["stale"] }, "second");
	const result = await endTurn(pi, ctx, {}, "second");
	session.branch = persist([...persistedNotebook, ...boundaryEntries(result)]);
	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	const successor = boundaryEntries(result).find((entry) => entry.type === "custom_message" && entry.customType === "pi-schematic-handoff");
	expect(customMessageText(successor)).toBe("## Next instruction\n\nhuman direction");
	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff).toBeNull();
	expect([...state.notebookPages].sort()).toStrictEqual([["keep", "durable"], ["other", "also durable"]]);
});

test("a handoff whose branch holds only an earlier handoff's cut fails as not persisted", async () => {
	const { state, pi } = await boundaryHost();
	const { ctx, session } = makeCtx();
	session.branch = [{
		type: "compaction",
		id: "old-cut",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: buildContinuationFrame(),
		firstKeptEntryId: "old-cut",
		tokensBefore: 0,
		details: { handoff: true, handoffId: "handoff-a" },
	}];
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(state.stagedHandoff).toBeNull();
	expectPrefix(sentMessageText(pi, 0), `Handoff failed — ${REASON_NOT_PERSISTED}.`);
});

test("agent_settled after a handoff completed at turn_start sends and notifies nothing", async () => {
	const { pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx, notifications, session } = makeCtx({ hasUI: true });
	await executeHandoff(pi, ctx);
	session.branch = persist(boundaryEntries(await endTurn(pi, ctx)));
	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
	const notificationsAtCompletion = notifications.length;

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	expect(notificationsAtCompletion).toBe(1);
	expect(notifications, "no second notification at settle").toHaveLength(1);
	expect(pi.sentMessages).toStrictEqual([]);
	expect(pi.sentUserMessages).toStrictEqual([]);
});

// ── Sibling refusal ──────────────────────────────────────────────────

function assistantMessage(...calls: { id: string; name: string }[]) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		},
	};
}

async function toolCall(pi: TestPI, toolCallId: string, toolName: string): Promise<ToolCallEventResult | undefined> {
	return firstHandlerResult(pi, "tool_call", { type: "tool_call", toolCallId, toolName, input: {} }, makeCtx().ctx);
}

test("in a message holding only handoff calls, the first runs and the others are refused", async () => {
	const { pi } = await boundaryHost();
	await callHandlers(pi, "message_end", assistantMessage(
		{ id: "h1", name: "handoff" },
		{ id: "h2", name: "handoff" },
	), makeCtx().ctx);

	expect(await toolCall(pi, "h1", "handoff")).toBeUndefined();
	expect(await toolCall(pi, "h2", "handoff")).toStrictEqual({ block: true, reason: HANDOFF_EXTRA_CALL_REFUSAL, terminate: true });
});

test("every handoff sharing a message with other calls is refused and the other calls are not refused", async () => {
	const { pi } = await boundaryHost();
	await callHandlers(pi, "message_end", assistantMessage(
		{ id: "w1", name: "write" },
		{ id: "h1", name: "handoff" },
		{ id: "n1", name: "notebook_write" },
		{ id: "h2", name: "handoff" },
	), makeCtx().ctx);

	expect(await toolCall(pi, "h1", "handoff")).toStrictEqual({ block: true, reason: HANDOFF_NOT_ALONE_REFUSAL, terminate: true });
	expect(await toolCall(pi, "h2", "handoff")).toStrictEqual({ block: true, reason: HANDOFF_NOT_ALONE_REFUSAL, terminate: true });
	expect(await toolCall(pi, "w1", "write")).toBeUndefined();
	expect(await toolCall(pi, "n1", "notebook_write")).toBeUndefined();
});

test("calls in an assistant message without handoff are not refused", async () => {
	const { pi } = await boundaryHost();
	await callHandlers(pi, "message_end", assistantMessage({ id: "w1", name: "write" }, { id: "r1", name: "read" }), makeCtx().ctx);

	expect(await toolCall(pi, "w1", "write")).toBeUndefined();
	expect(await toolCall(pi, "r1", "read")).toBeUndefined();
});

test("refusals last until the next assistant message and are not cleared by other messages", async () => {
	const { pi } = await boundaryHost();
	const ctx = makeCtx().ctx;
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);

	await callHandlers(pi, "message_end", { type: "message_end", message: { role: "toolResult", content: [] } }, ctx);
	expect((await toolCall(pi, "h1", "handoff"))?.block, "a tool result message must not clear refusals").toBe(true);

	await callHandlers(pi, "message_end", assistantMessage({ id: "w2", name: "write" }), ctx);
	expect(await toolCall(pi, "h1", "handoff"), "the next assistant message clears the previous refusals").toBeUndefined();
});

test("turn_end clears the refusals", async () => {
	const { pi } = await boundaryHost();
	const ctx = makeCtx().ctx;
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);

	await callHandlers(pi, "turn_end", turnEndEvent(), ctx);

	expect(await toolCall(pi, "h1", "handoff")).toBeUndefined();
});

// ── session_tree ─────────────────────────────────────────────────────

test("session_tree invalidates a staged handoff and the handoff refusals", async () => {
	const pi = await createTestHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx, { nextInstruction: "first task" }, "first");
	await callHandlers(pi, "message_end", assistantMessage({ id: "h1", name: "handoff" }, { id: "w1", name: "write" }), ctx);
	await expect(executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second")).rejects.toThrow(new Error(HANDOFF_ALREADY_STAGED));
	expect((await toolCall(pi, "h1", "handoff"))?.block).toBe(true);

	await emitAll(pi, "session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);

	await executeHandoff(pi, ctx, { nextInstruction: "second task" }, "second");
	expect(await toolCall(pi, "h1", "handoff")).toBeUndefined();
});

test("after a failed cut the run refuses further handoff calls until the agent settles", async () => {
	const { pi } = await boundaryHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);
	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	expect(await toolCall(pi, "again", "handoff")).toStrictEqual({ block: true, reason: HANDOFF_FAILED_IN_RUN_REFUSAL, terminate: true });
	expect(await toolCall(pi, "w1", "write"), "other tools are not refused for the failed cut").toBeUndefined();

	await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	expect(await toolCall(pi, "again", "handoff")).toBeUndefined();
});

test("a declined handoff resolved at turn_start fails without starting a run and refuses a repeat call", async () => {
	const { state, pi } = await boundaryHost((s) => { requestHandoff(s); });
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx, { toolResults: [handoffToolResult("call-1", true)] });

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

	assertFailedWithoutRun(state, pi);
	expect(await toolCall(pi, "again", "handoff")).toStrictEqual({ block: true, reason: HANDOFF_FAILED_IN_RUN_REFUSAL, terminate: true });
});

test("session_tree clears the failed-in-run refusal", async () => {
	const pi = await createTestHost();
	const { ctx } = makeCtx();
	await executeHandoff(pi, ctx);
	await endTurn(pi, ctx);
	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
	expect((await toolCall(pi, "again", "handoff"))?.block).toBe(true);

	await emitAll(pi, "session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);

	expect(await toolCall(pi, "again", "handoff")).toBeUndefined();
});

test("the handoff tool definition declares model-only exposure", async () => {
	const { pi } = await boundaryHost();

	// The host does not model Pi's nested-call runner; the field is what Pi reads.
	expect(getTool(pi, "handoff").exposure).toBe("model-only");
});

// ── Registration order ───────────────────────────────────────────────

test("the boundary settles a failed handoff before the watchdog counts the run, so each failed attempt counts once", async () => {
	const pi = await createTestHost();
	const { ctx, notifications } = makeCtx();
	const warnings = () => notifications.filter((notification) => notification.level === "warning");
	const nudge = () => watchdogNudge(pi, ctx);

	await getCommand(pi, "handoff").handler("continue work", createCommandContext({ isIdle: () => true }));
	for (let attempt = 1; attempt <= MAX_HANDOFF_ATTEMPTS; attempt++) {
		expect(await nudge(), `attempt ${attempt} is still nudged`).toMatch(/A real handoff is required/);
		await executeHandoff(pi, ctx, { nextInstruction: "continue work" });
		await endTurn(pi, ctx, { toolResults: [] });
		await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

		expect(warnings(), `after failed attempt ${attempt}`).toHaveLength(attempt < MAX_HANDOFF_ATTEMPTS ? 0 : 1);
	}

	expectPrefix(warnings()[0].message, `Required handoff cancelled after ${MAX_HANDOFF_ATTEMPTS} attempts`);
});

type ContextMessage = ContextEvent["messages"][number];

/** The watchdog nudge the real context hook injects for `ctx`, or undefined when it injects none. */
async function watchdogNudge(pi: TestPI, ctx: ExtensionContext): Promise<string | undefined> {
	const result = await invokeHandler(pi, "context", { type: "context", messages: [{ role: "user", content: "work", timestamp: 1 }] }, ctx);
	if (result === undefined) {return undefined;}
	if (result.messages === undefined) {throw new Error("The context hook returned a result without messages.");}
	const nudge = result.messages.find((message): message is Extract<ContextMessage, { role: "custom" }> =>
		message.role === "custom" && message.customType === "pi-schematic-watchdog");
	if (nudge === undefined) {return undefined;}
	if (typeof nudge.content !== "string") {throw new Error("The watchdog nudge has no text content.");}
	return nudge.content;
}

test("unready runs do not consume the enforcement budget", async () => {
	// Full host: the real context hook sends the not-ready nudge. Runs that carried only
	// that nudge must not count, so MAX_HANDOFF_ATTEMPTS of them leave the handoff pending.
	const pi = await createTestHost();
	const warnings: string[] = [];
	const small = makeCtx({ usage: { tokens: 5000, percent: 2.5, contextWindow: 200000 } });
	small.ctx.ui.notify = (message: string, level?: string) => { if (level === "warning") {warnings.push(message);} };
	await getCommand(pi, "handoff").handler("continue work", createCommandContext({ isIdle: () => true }));

	for (let run = 0; run < MAX_HANDOFF_ATTEMPTS; run++) {
		expect(await watchdogNudge(pi, small.ctx) ?? "").toMatch(/not yet ready for compaction/);
		await expect(executeHandoff(pi, small.ctx, { nextInstruction: "continue work" }, "small")).rejects.toThrow(/handoff unavailable yet/);
		await emitAll(pi, "agent_settled", { type: "agent_settled", aborted: false }, small.ctx);
	}

	expect(warnings, "runs nudged only to keep working must not cancel the handoff").toStrictEqual([]);
	expect(await watchdogNudge(pi, makeCtx().ctx) ?? "", "the handoff is still required once context is eligible").toMatch(/A real handoff is required/);
});

test("a completed handoff clears the requested-handoff nudge", async () => {
	const pi = await createTestHost();
	const eligible = makeCtx();
	await getCommand(pi, "handoff").handler("continue work", createCommandContext({ isIdle: () => true }));
	expect(await watchdogNudge(pi, eligible.ctx) ?? "").toMatch(/A real handoff is required/);
	await executeHandoff(pi, eligible.ctx, { nextInstruction: "continue work" });
	const result = await endTurn(pi, eligible.ctx);
	eligible.session.branch = persist(boundaryEntries(result));

	await emitAll(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, eligible.ctx);

	assertSuccessorTurn(customMessageText(boundaryEntries(result)[1]), { nextInstruction: "continue work" });
	expect(await watchdogNudge(pi, eligible.ctx), "a completed handoff leaves no requested-handoff nudge").toBeUndefined();
});

test("/handoff sets the handoff status indicator", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});
	const statuses = new Map<string, string | undefined>();

	await getCommand(pi, "handoff").handler("implement auth", createCommandContext({
		hasUI: true,
		isIdle: () => true,
		ui: createUIContext({
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		}),
		getContextUsage: () => undefined,
	}));

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff requested — waiting for eligible context");
});

test("/handoff shows ready status when context is eligible", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});
	const statuses = new Map<string, string | undefined>();

	await getCommand(pi, "handoff").handler("implement auth", createCommandContext({
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
		ui: createUIContext({
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		}),
	}));

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff required — ready to compact");
});

test("handoff status becomes ready when later context becomes eligible", async () => {
	const pi = await createTestHost();
	const statuses = new Map<string, string | undefined>();
	const commandContext = createCommandContext({
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => undefined,
		ui: createUIContext({
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		}),
	});
	await getCommand(pi, "handoff").handler("implement auth", commandContext);
	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff requested — waiting for eligible context");

	await invokeHandler(
		pi,
		"context",
		{ type: "context", messages: [] },
		createExtensionContext({
			hasUI: true,
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			ui: commandContext.ui,
		}),
	);

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff required — ready to compact");
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
		await expect(getTool(pi, "handoff").execute(
				"invalid-usage",
				{ nextInstruction: "continue work" },
				undefined,
				undefined,
				createToolContext({ getContextUsage: () => usage }),
			)).rejects.toThrow(/Context usage unavailable/);
	}
});

test("turn_end fallback keeps requested handoff status sticky until real handoff happens", async () => {
	const pi = await createTestHost();
	const statuses = new Map<string, string | undefined>();
	await getCommand(pi, "handoff").handler("implement auth", createCommandContext({
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => undefined,
		ui: createUIContext({
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		}),
	}));

	await emitAll(pi, "turn_end", turnEndEvent(), createExtensionContext({
		hasUI: true,
		ui: createUIContext({
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: ignore,
		}),
		getContextUsage: () => undefined,
	}));

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff requested — waiting for eligible context");
});

test("handoff tool metadata and schema describe the prompt contract", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	const tool = getTool(pi, "handoff");
	assertPresent(tool.promptGuidelines);
	expect(tool.description).toMatch(/past ~30%/i);
	expect(tool.description).toMatch(/call handoff/i);
	expect(tool.description).toMatch(/current notebook/i);
	expect(tool.description).toMatch(/Call handoff alone in its message: a handoff that shares a message with other tool calls is refused, and the other calls are handled on their own\./);
	expect(tool.promptGuidelines.join(" ")).toMatch(/preparation only/i);
	expect(`${tool.description} ${tool.promptGuidelines.join(" ")} ${JSON.stringify(tool.parameters)}`).not.toMatch(/\bbrief\b/i);
	expect(`${tool.description} ${tool.promptGuidelines.join(" ")} ${JSON.stringify(tool.parameters)}`, "handoff copy must not say long-term store; use reusable knowledge").not.toMatch(/long-term/i);
	expect(JSON.stringify(tool.parameters)).toMatch(/reusable knowledge/i);
	expect(JSON.stringify(tool.parameters), "pruning policy must not require an unverifiable universal negative").not.toMatch(/merely irrelevant|will not be needed again|permanently remove/i);
	expect(JSON.stringify(tool.parameters)).toMatch(/current state, blockers/i);
	expect(tool.promptGuidelines.join(" ")).toMatch(/current state, blockers, unresolved questions/i);
	// Every field is optional: a pending human direction makes nextInstruction
	// redundant, and a handoff with nothing to add makes context redundant. The
	// runtime guard rejects the one combination that cannot work: no instruction.
	expect(Value.Check(tool.parameters, { nextInstruction: "continue work" })).toBe(true);
	expect(Value.Check(tool.parameters, { context: "blocked on auth" })).toBe(true);
	expect(Value.Check(tool.parameters, {})).toBe(true);
	expect(JSON.stringify(tool.parameters), "the fused task field must be gone").not.toMatch(/"task"/);
});

test("the continuation frame is pinned byte-for-byte", () => {
	// The frame is the only summary text a successor sees, so every byte is a contract.
	// Golden string, hand-written on purpose: comparing against buildContinuationFrame()
	// or loose regexes would pass vacuously if the frame copy regressed.
	// The frame carries no task or constraints: a frozen task invites paraphrase, and frozen
	// constraints lie after a /tree rollback.
	expect(buildContinuationFrame()).toBe([
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

test("the handoff failure guidance is pinned byte-for-byte", () => {
	// Golden strings, hand-written on purpose: comparing against formatHandoffFailure()
	// would pass vacuously if the guidance regressed.
	expect(formatHandoffFailure(REASON_NOT_PERSISTED, true)).toBe(`Handoff failed — ${REASON_NOT_PERSISTED}. The required handoff remains pending; retry when context usage is eligible.`);
	expect(formatHandoffFailure(REASON_NOT_PERSISTED, false)).toBe(`Handoff failed — ${REASON_NOT_PERSISTED}. No required handoff remains pending; retry when ready.`);
});

test("the lost-successor failure is pinned byte-for-byte and carries the instruction", () => {
	// Golden string, hand-written on purpose: the failure is the only place the lost
	// instruction survives, and comparing against formatLostSuccessorFailure() would
	// pass vacuously if the formatter dropped it.
	expect(formatLostSuccessorFailure(REASON_SUCCESSOR_NOT_PERSISTED, "## Next instruction\n\nfinish the report\n\n## Context\n\nmid-task state")).toBe(`Handoff failed — ${REASON_SUCCESSOR_NOT_PERSISTED}. The context is already cut, so the handoff is not retried and no required handoff remains pending. The instruction it carried:\n\n## Next instruction\n\nfinish the report\n\n## Context\n\nmid-task state`);
});

test("buildNextUserMessage carries the instruction verbatim and the context second", () => {
	const instruction = "  Refactor billing to use the shared meter.  ";
	expect(buildNextUserMessage({ nextInstruction: instruction, context: "  blocked on the auth spike  " })).toBe("## Next instruction\n\n  Refactor billing to use the shared meter.  \n\n## Context\n\nblocked on the auth spike");
	expect(buildNextUserMessage({ nextInstruction: "Refactor billing" })).toBe("## Next instruction\n\nRefactor billing");
	expect(buildNextUserMessage({ nextInstruction: "Refactor billing", context: "   \n " }), "whitespace-only context adds no empty section").toBe("## Next instruction\n\nRefactor billing");
});

test("buildNextUserMessage preserves instruction bytes and normalizes context padding", async () => {
	fc.assert(
		fc.property(
			// Blank instructions are rejected by validateHandoffRequest before the builder runs.
			fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0),
			fc.string(),
			(instruction, context) => {
				const message = buildNextUserMessage({ nextInstruction: instruction, context });
				expectPrefix(message, `## Next instruction\n\n${instruction}`, "the instruction must open the message byte-for-byte");
				if (context.trim()) {expect(message, "non-blank context must be preserved in the message").toContain(context.trim());}
				expect(message, "context padding must not change the delivered message").toBe(buildNextUserMessage({ nextInstruction: instruction, context: ` \n${context} ` }));
			},
		),
	);
});

test("handoff tool rejects an empty nextInstruction with context usage", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "" },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => ({ tokens: null, contextWindow: 0, percent: 42 }) }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Empty handoff nextInstruction rejected");
			expect(error.message).toContain("42%");
			return true;
		});

	expect(state.stagedHandoff, "an empty instruction must not stage").toBeNull();
	expect(pi.sentUserMessages, "the error result is the only report; nothing queues for a later turn").toStrictEqual([]);
});

test("handoff tool rejects small session with clear error", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("handoff unavailable yet");
			expect(error.message).toContain("~3% (5000 tokens)");
			expect(error.message).toContain("Continue working");
			return true;
		});

	expect(state.stagedHandoff, "small-session rejection must not stage").toBeNull();
});

test("a small-session rejection keeps the pending request and states it in the error without queuing a follow-up", async () => {
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null };
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);
	const notifications: { message: string; level: string | undefined }[] = [];

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({
				hasUI: true,
				ui: createUIContext({
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: (message: string, level?: string) => { notifications.push({ message, level }); },
				}),
				getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }),
			}),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("handoff unavailable yet");
			expect(error.message).toContain("The required handoff remains pending");
			return true;
		});

	expect(state.pendingRequestedHandoff).toStrictEqual({
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff in progress");
	expect(notifications, "the error result is the only report of the rejection").toStrictEqual([]);
	expect(pi.sentUserMessages).toStrictEqual([]);
});

test("handoff tool rejects small session with null percent without crashing", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => ({ tokens: 5000, percent: null, contextWindow: 200000 }) }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("handoff unavailable yet");
			expect(error.message).toContain("(5000 tokens)");
			expect(error.message).toContain("Continue working");
			return true;
		});

	expect(state.stagedHandoff, "null-percent rejection must not stage").toBeNull();
});

test("handoff tool rejects small session estimated from percent when tokens are unavailable", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => ({ tokens: null, percent: 10, contextWindow: 200000 }) }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("handoff unavailable yet");
			expect(error.message).toContain("~20000 tokens estimated from context usage");
			expect(error.message).toContain("Continue working");
			return true;
		});

	expect(state.stagedHandoff, "estimated small-session rejection must not stage").toBeNull();
});

test("handoff tool accepts large estimated session when tokens are unavailable", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({
				getContextUsage: () => ({ tokens: null, percent: 20, contextWindow: 200000 }),
			}),
		)).resolves.toMatchObject({ terminate: true });
	expect(state.stagedHandoff?.phase, "an accepted handoff must stage").toBe("staged");
});

test("handoff tool accepts the exact 30000-token minimum", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({
				getContextUsage: () => ({ tokens: 30000, percent: 15, contextWindow: 200000 }),
			}),
		)).resolves.toMatchObject({ terminate: true });
	expect(state.stagedHandoff?.phase, "an accepted handoff must stage").toBe("staged");
});

test("handoff tool rejects session just below the 30000-token minimum", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => ({ tokens: 29999, percent: 15, contextWindow: 200000 }) }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("handoff unavailable yet");
			expect(error.message).toContain("29999 tokens");
			expect(error.message).toContain("Continue working");
			return true;
		});

	expect(state.stagedHandoff, "just-below-boundary rejection must not stage").toBeNull();
});

test("handoff tool rejects a whitespace-only nextInstruction", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "   \t\n " },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => undefined }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Empty handoff nextInstruction rejected");
			expect(error.message).toContain("Context at ?");
			return true;
		});

	expect(state.stagedHandoff).toBeNull();
});

test("/handoff queues as a followUp while a run is active", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffCommand(api, state);
	});

	await getCommand(pi, "handoff").handler("continue work", createCommandContext({ isIdle: () => false }));

	expect(pi.sentUserMessages[0]?.options?.deliverAs, "a direction sent mid-run must queue instead of being rejected").toBe("followUp");
});

test("handoff tool ignores a legacy task field and rejects the resulting empty instruction", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	// The harness calls execute directly, bypassing Pi's schema validation. TypeBox
	// tolerates the unknown key, so this pins that the removed fused field is never
	// consumed as the instruction: with no nextInstruction the call fails loudly.
	await expect(getTool(pi, "handoff").execute("legacy-task", { task: "old field" }, undefined, undefined, createToolContext({
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		}))).rejects.toThrow(/Empty handoff nextInstruction rejected/);

	expect(state.stagedHandoff, "a legacy task field must not stage").toBeNull();
});

test("handoff tool rejects when context usage is unavailable", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => undefined }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Context usage unavailable");
			expect(error.message).toContain("rejected");
			return true;
		});

	expect(state.stagedHandoff, "unavailable usage must not stage").toBeNull();
});

test("an unavailable-usage rejection keeps the pending request and states it in the error without queuing a follow-up", async () => {
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: null };
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);
	const notifications: { message: string; level: string | undefined }[] = [];

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({
				hasUI: true,
				ui: createUIContext({
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: (message: string, level?: string) => { notifications.push({ message, level }); },
				}),
				getContextUsage: () => undefined,
			}),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Context usage unavailable");
			expect(error.message).toContain("The required handoff remains pending");
			return true;
		});

	expect(state.pendingRequestedHandoff).toStrictEqual({
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff in progress");
	expect(notifications, "the error result is the only report of the rejection").toStrictEqual([]);
	expect(pi.sentUserMessages).toStrictEqual([]);
});

test("handoff tool rejects when context usage cannot be estimated", async () => {
	const state = createState();
	const pi = await createTestHost((api) => {
		registerHandoffTool(api, state);
	});

	await expect(getTool(pi, "handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			createToolContext({ getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 200_000 }) }),
		)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Context usage unavailable");
			expect(error.message).toContain("Continue working");
			return true;
		});

	expect(state.stagedHandoff, "unestimable usage must not stage").toBeNull();
});

test("session_start new clears stale handoff status and warning widget", async () => {
	const pi = await createTestHost();
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "stale"]]);
	const widgets = new Map<string, string[] | undefined>([[WIDGET_KEY_WARNING, ["stale"]]]);
	const ctx = makeTUICtx({ record: { statuses, widgets }, ui: { addAutocompleteProvider: () => undefined } });
	await emitAll(pi, "session_start", { type: "session_start", reason: "new" }, ctx);

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
	expect(widgets.get(WIDGET_KEY_WARNING)).toBeUndefined();
});

