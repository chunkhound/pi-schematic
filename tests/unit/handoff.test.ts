import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { Value } from "typebox/value";
import { createState, resetState } from "../../state.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { buildContinuationFrame, buildHandoffCompactionSummary, buildNextUserMessage } from "../../handoff/format.js";
import { registerHandoffCompaction } from "../../handoff/compact.js";
import registerAgenticoding from "../../index.js";
import { STATUS_KEY_HANDOFF, WIDGET_KEY_WARNING, updateIndicators } from "../../tui.js";
import { registerWatchdog } from "../../watchdog.js";
import { createTestPI, makeTUICtx } from "./helpers.js";

/**
 * The successor turn must OPEN with the delivered instruction + context. The
 * exceptional completion reports may follow it, so assert the prefix rather than
 * duplicating report copy in every test.
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

test("/handoff sends the direction back through the LLM without opening the editor", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => null,
		ui: { notify: (_message: string) => {} },
	});

	assert.deepEqual(state.pendingRequestedHandoff, {
		enforcementAttempts: 0,
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
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	const notifications: string[] = [];
	await pi.commands.get("handoff")!.handler("   ", {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (message: string) => notifications.push(message) },
	});

	assert.deepEqual(notifications, ["Usage: /handoff <direction>"]);
	assert.deepEqual(pi.sentUserMessages, []);
});

test("handoff tool queues the split request and delivers it verbatim after compaction", async () => {
	const pi = createTestPI();
	const state = createState();
	state.notebookPages.set("auth-refresh", "sensitive notebook body");
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, nextInstruction: null };
	registerHandoffTool(pi as any, state);

	let compactOptions: any;
	const result = await pi.tools.get("handoff").execute(
		"1",
		{ nextInstruction: "Goal: continue auth-refresh" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: (options: any) => {
				compactOptions = options;
			},
		},
	);

	assert.notEqual(state.pendingHandoff, null, "the handoff must queue its generation marker");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);
	assert.equal(typeof compactOptions?.onComplete, "function");
	assert.equal(result.content[0].text, "Handoff started.");
	assert.equal(result.terminate, true);

	compactOptions.onComplete({});
	assert.equal(pi.sentUserMessages.length, 1);
	assertSuccessorTurn(pi.sentUserMessages[0].content, { nextInstruction: "Goal: continue auth-refresh" });
});

test("successful handoff discards pages after compaction", async () => {
	const pi = createTestPI();
	const state = createState();
	state.epoch = 1;
	state.notebookPages.set("stale", "obsolete");
	const notifications: string[] = [];
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	const result = await pi.tools.get("handoff").execute(
		"discard",
		{ nextInstruction: "continue without stale grounding", discardPages: ["stale"] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			hasUI: true,
			ui: {
				setStatus: () => {},
				notify: (message: string) => notifications.push(message),
			},
			compact: (options: any) => { callbacks = options; },
		},
	);

	assert.equal(state.notebookPages.get("stale"), "obsolete", "retryable compaction must retain pages");
	callbacks.onComplete();
	assert.equal(state.notebookPages.size, 0);
	assert.match(notifications.at(-1) ?? "", /Notebook: 0 pages kept, 1 discarded/);
	assertSuccessorTurn(pi.sentUserMessages.at(-1)?.content ?? "", { nextInstruction: "continue without stale grounding" });
	assert.doesNotMatch(pi.sentUserMessages.at(-1)?.content ?? "", /## Handoff report/,
		"a successful TUI report must not pollute the successor message");
	assert.deepEqual(pi.appendedEntries, [
		{ customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ customType: "notebook-generation", data: { version: 1, epoch: 2 } },
	]);
	assert.equal(result.content[0].text, "Handoff started.");
});

test("handoff onComplete fails gracefully when the discard commit marker throws", async () => {
	const pi = createTestPI();
	const state = createState();
	state.epoch = 1;
	state.notebookPages.set("stale", "obsolete");
	state.activeNotebookTopic = "oauth";
	state.pendingRequestedHandoff = { toolCalled: true, enforcementAttempts: 0, nextInstruction: null };
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute(
		"discard-fail",
		{ nextInstruction: "continue", discardPages: ["stale"] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			compact: (options: any) => { callbacks = options; },
		},
	);

	// Patch appendEntry to throw — simulates a persistence failure during discard
	const original = (pi as any).appendEntry;
	(pi as any).appendEntry = () => { throw new Error("disk full"); };
	callbacks.onComplete();
	(pi as any).appendEntry = original;

	// Compaction succeeded even though its final discard marker did not. Pages
	// remain available and the fresh context receives an explicit warning. The
	// completion still finalizes durable state like an ordinary success.
	assert.equal(state.notebookPages.get("stale"), "obsolete", "pages must survive a failed discard");
	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null, "requested handoff cleared after successful compaction");
	assert.equal(state.activeNotebookTopic, null, "active topic cleared after successful compaction");
	assert.equal(state.readonlyNudgePending, false, "a clean OFF-to-OFF handoff stays silent; the ON posture is announced only when readonly is active");
	const fallback = pi.sentUserMessages.at(-1)?.content ?? "";
	assert.match(fallback, /## Next instruction\n\ncontinue/);
	assert.match(fallback, /## Handoff report\n\nHandoff completed, but notebook discard was not persisted/);
});

test("post-commit reporting failure does not claim pages were retained", async () => {
	const pi = createTestPI();
	const state = createState();
	state.epoch = 1;
	state.notebookPages.set("stale", "obsolete");
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute(
		"report-fail",
		{ nextInstruction: "continue", discardPages: ["stale"] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			hasUI: true,
			ui: {
				setStatus: () => {},
				notify: () => { throw new Error("notification channel closed"); },
			},
			compact: (options: any) => { callbacks = options; },
		},
	);

	// Commit succeeds, then the completion notification throws during reporting
	callbacks.onComplete();

	// The failure is explicit and never misclaims retention. A UI-report failure must
	// not cost the successor its instruction.
	assert.equal(state.notebookPages.size, 0, "pages must be gone after successful commit");
	assert.equal(state.pendingHandoff, null);
	assert.equal(state.activeNotebookTopic, null, "topic cleared after successful commit");
	const report = pi.sentUserMessages.at(-1)?.content ?? "";
	assert.equal(pi.sentUserMessages.at(-1)?.options?.deliverAs, "followUp",
		"UI-rerouted delivery must queue while the agent run is active");
	assert.match(report, /UI completion notification failed/,
		"UI report failure must be explicit through sendUserMessage");
	assert.match(report, /## Next instruction\n\ncontinue/,
		"the successor instruction must survive a UI report failure");
	assert.doesNotMatch(report, /retained/i,
		"post-commit reporting failure must not claim pages were retained");
});

test("a host delivery rejection finalizes the cut while its persisted payload remains recoverable", async () => {
	const pi = createTestPI();
	const state = createState();
	state.epoch = 1;
	state.notebookPages.set("stale", "obsolete");
	state.activeNotebookTopic = "auth";
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, nextInstruction: "continue" };
	let callbacks: any;
	registerHandoffTool(pi as any, state);
	registerHandoffCompaction(pi as any, state);

	await pi.tools.get("handoff").execute(
		"delivery-fail",
		{ discardPages: ["stale"] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			compact: (options: any) => { callbacks = options; },
		},
	);

	const [beforeCompact] = pi.handlers.get("session_before_compact")!;
	const cut = await beforeCompact({ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] }, {});
	assert.deepEqual(cut.compaction.details.payload, { version: 1, nextInstruction: "continue", context: "" });
	assert.match(cut.compaction.details.recoveryKey, /^[0-9a-f-]{36}$/i,
		"the completed cut persists a unique recovery key");

	// Commit succeeds; the final delivery throws and must propagate out of
	// onComplete — the failure is explicit, never silent. Real Pi's
	// sendUserMessage is fire-and-forget, so this covers a host that rejects
	// synchronously; recovery remains the net for silent losses.
	(pi as any).sendUserMessage = () => { throw new Error("channel closed"); };
	assert.throws(() => callbacks.onComplete(), /channel closed/);

	// The discard commit and handoff finalization are durable; recovery reads the
	// exact payload from the completed compaction entry.
	assert.equal(state.notebookPages.size, 0, "pages must be gone after successful commit");
	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingHandoffDelivery, null, "recovery reads the payload persisted on the completed cut");
	assert.equal(state.pendingRequestedHandoff, null, "a completed cut must not retain its handoff bypass");
	assert.equal(state.activeNotebookTopic, null, "the completed cut must clear the old topic");
	assert.equal(state.readonlyNudgePending, false, "an OFF-at-cut handoff stays silent; the ON posture is announced only when readonly is active");
});

test("commit failure and UI failure both ride along with the instruction", async () => {
	const pi = createTestPI();
	const state = createState();
	state.epoch = 1;
	state.notebookPages.set("stale", "obsolete");
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute(
		"compound-fail",
		{ nextInstruction: "continue", discardPages: ["stale"] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			hasUI: true,
			ui: {
				setStatus: () => {},
				notify: () => { throw new Error("notification channel closed"); },
			},
			compact: (options: any) => { callbacks = options; },
		},
	);

	// Both the discard commit and the UI report fail.
	const original = (pi as any).appendEntry;
	(pi as any).appendEntry = () => { throw new Error("disk full"); };
	callbacks.onComplete();
	(pi as any).appendEntry = original;

	// One message carries the instruction first and both failures in the report.
	assert.equal(pi.sentUserMessages.length, 1, "both failures must ride a single delivery");
	const delivered = pi.sentUserMessages[0].content;
	assert.ok(delivered.startsWith("## Next instruction\n\ncontinue"),
		"compound failures must not cost the successor its instruction");
	assert.match(delivered, /## Handoff report\n\nUI completion notification failed/);
	assert.match(delivered, /notebook discard was not persisted/);
	assert.equal(state.notebookPages.get("stale"), "obsolete", "pages must survive a failed discard");
	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
});

test("a synchronous successor-delivery rejection is reported as such and propagates", async () => {
	const pi = createTestPI();
	const state = createState();
	let callbacks: any;
	const notifications: string[] = [];
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute(
		"delivery-reject",
		{ nextInstruction: "continue" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			hasUI: true,
			ui: {
				setStatus: () => {},
				notify: (message: string) => notifications.push(message),
			},
			compact: (options: any) => { callbacks = options; },
		},
	);

	// Real Pi's sendUserMessage is fire-and-forget, so this covers a host that
	// rejects synchronously; recovery remains the net for silent losses.
	(pi as any).sendUserMessage = () => { throw new Error("channel closed"); };
	assert.throws(() => callbacks.onComplete(), /channel closed/);

	assert.ok(notifications.some((message) => message.includes("Successor delivery failed: channel closed")),
		"a delivery rejection must be reported distinctly from a compaction failure");
});

test("successor delivery is requested as a followUp (queue-safe contract)", async () => {
	const pi = createTestPI();
	const state = createState();
	state.epoch = 1;
	state.notebookPages.set("stale", "obsolete");
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute(
		"queue-on-active-run",
		{ nextInstruction: "continue", discardPages: ["stale"] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			compact: (options: any) => { callbacks = options; },
		},
	);

	// The real host binding is void and swallows rejections, so delivery must be
	// queue-safe: `followUp` lets an active run (e.g. a user message flushed during
	// compaction) take the instruction after it instead of rejecting it.
	callbacks.onComplete();

	assert.equal(pi.sentUserMessages.at(-1)?.options?.deliverAs, "followUp");
	assert.match(pi.sentUserMessages.at(-1)?.content ?? "", /## Next instruction\n\ncontinue/);
	// Durable state was finalized before the fallible report, so pages are gone
	// even though delivery is the last step.
	assert.equal(state.notebookPages.size, 0, "pages must be gone after successful commit");
	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(state.activeNotebookTopic, null, "topic cleared after successful commit");
});

test("handoff with empty discardPages retains all pages", async () => {
	const pi = createTestPI();
	const state = createState();
	state.notebookPages.set("keep", "value");
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	const result = await pi.tools.get("handoff").execute(
		"no-discard",
		{ nextInstruction: "continue with all pages", discardPages: [] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			compact: (options: any) => { callbacks = options; },
		},
	);

	callbacks.onComplete();
	assert.equal(state.notebookPages.get("keep"), "value", "pages must be retained when discardPages is empty");
	assert.equal(result.content[0].text, "Handoff started.");
});

test("handoff compaction keeps the frame constant and the state contract intact", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingHandoff = { generation: state.handoffGeneration };
	state.pendingHandoffDelivery = {
		generation: state.handoffGeneration,
		payload: { version: 1, nextInstruction: "next task", context: "remaining state" },
		recoveryKey: "recovery-key",
	};
	state.pendingRequestedHandoff = { enforcementAttempts: 1, toolCalled: true, nextInstruction: null };
	state.activeNotebookTopic = "oauth";
	state.activeNotebookTopicSource = "human";
	registerHandoffCompaction(pi as any, state);

	const [handler] = pi.handlers.get("session_before_compact")!;
	const result = await handler(
		{
			preparation: { tokensBefore: 123 },
			branchEntries: [{ id: "leaf-1" }],
		},
		{},
	);

	assert.equal(state.pendingHandoff, null);
	assert.notEqual(state.pendingRequestedHandoff, null, "pendingRequestedHandoff stays until onComplete in tool.ts");
	// Notebook topic is cleared in handoff tool's onComplete, not in compaction itself
	assert.equal(state.activeNotebookTopic, "oauth");
	assert.equal(state.activeNotebookTopicSource, "human");
	assert.equal(result.compaction.summary, buildHandoffCompactionSummary("recovery-key"));
	assert.equal(result.compaction.tokensBefore, 123);
	assert.equal(result.compaction.firstKeptEntryId, "leaf-1-handoff-cut");
	assert.deepEqual(result.compaction.details, {
		handoff: true,
		payload: { version: 1, nextInstruction: "next task", context: "remaining state" },
		recoveryKey: "recovery-key",
	});
});

test("/handoff sets the handoff status indicator", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
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
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
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
	const pi = createTestPI();
	registerAgenticoding(pi as any);
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

test("handoff compaction ignores a reservation without a delivery payload", async () => {
	const pi = createTestPI();
	const state = createState();
	// Two-phase contract: the tool records the generation marker and the payload
	// together, and only the pair may be compacted. A marker without a payload
	// (stale or partially cleared state) must leave the reservation untouched.
	state.pendingHandoff = { generation: state.handoffGeneration };
	registerHandoffCompaction(pi as any, state);
	const [handler] = pi.handlers.get("session_before_compact")!;

	const result = await handler(
		{ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] },
		{},
	);

	assert.equal(result, undefined, "a marker without a payload must not compact");
	assert.notEqual(state.pendingHandoff, null, "the unconsumed reservation stays intact");
});

test("handoff compaction ignores a delivery payload from a stale generation", async () => {
	const pi = createTestPI();
	const state = createState();
	// The marker and its payload are recorded as a pair; a payload whose generation
	// no longer matches the marker (a superseded reservation) must not compact.
	state.pendingHandoff = { generation: state.handoffGeneration };
	state.pendingHandoffDelivery = {
		generation: state.handoffGeneration - 1,
		payload: { version: 1, nextInstruction: "stale", context: "" },
		recoveryKey: "stale-key",
	};
	registerHandoffCompaction(pi as any, state);
	const [handler] = pi.handlers.get("session_before_compact")!;

	const result = await handler(
		{ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] },
		{},
	);

	assert.equal(result, undefined, "a stale-generation payload must not compact");
	assert.notEqual(state.pendingHandoff, null, "the current reservation stays intact");
	assert.notEqual(state.pendingHandoffDelivery, null, "the stale payload stays recoverable for its owner");
});

test("handoff success sends a completion notification", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);
	let compactOptions: any;
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();

	await pi.tools.get("handoff").execute(
		"1",
		{ nextInstruction: "Goal: continue" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			hasUI: true,
			ui: {
				setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
				notify: (message: string, level: string) => { notifications.push({ message, level }); },
			},
			compact: (options: any) => { compactOptions = options; },
		},
	);
	compactOptions.onComplete();

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.ok(notifications.some((n) => n.message.includes("Handoff complete") && n.level === "info"));
	// The UI already saw the report, so the successor's turn carries only its instruction.
	assert.equal(pi.sentUserMessages.at(-1)?.content, buildNextUserMessage({ nextInstruction: "Goal: continue" }));
	assert.equal(pi.sentUserMessages.at(-1)?.options?.deliverAs, "followUp");
});

test("async handoff compaction error retains discard pages and restores a ready retry status", async () => {
	const pi = createTestPI();
	const state = createState();
	state.notebookPages.set("stale", "obsolete");
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, nextInstruction: null };
	registerHandoffTool(pi as any, state);
	let compactOptions: any;
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ message: string; level: string }> = [];

	await pi.tools.get("handoff").execute(
		"1",
		{ nextInstruction: "Goal: continue", discardPages: ["stale"] },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			hasUI: true,
			ui: {
				theme: { fg: (_name: string, text: string) => text },
				setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
				notify: (message: string, level: string) => { notifications.push({ message, level }); },
			},
			compact: (options: any) => { compactOptions = options; },
		},
	);
	compactOptions.onError(new Error("Nothing to compact (session too small)"));

	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingHandoffDelivery, null, "a failed compaction releases the undelivered payload");
	assert.equal(state.notebookPages.get("stale"), "obsolete");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
	assert.deepEqual(notifications, [{ message: "Handoff compaction failed: Nothing to compact (session too small). The handoff can be retried.", level: "error" }]);
	// onError re-engages the LLM via sendUserMessage
	assert.ok(pi.sentUserMessages.length > 0);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);
});

test("stored human direction survives a failed compaction and is delivered on retry", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	registerHandoffTool(pi as any, state);

	await pi.commands.get("handoff")!.handler("Goal: continue", { hasUI: false, isIdle: () => true });

	let firstCallbacks: any;
	await pi.tools.get("handoff").execute("retry-first", { context: "first attempt" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { firstCallbacks = options; },
	});
	firstCallbacks.onError(new Error("host failed"));

	let retryCallbacks: any;
	await pi.tools.get("handoff").execute("retry-second", { context: "retry context" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { retryCallbacks = options; },
	});
	retryCallbacks.onComplete();

	// Issue #36: the human direction is stored in pendingRequestedHandoff, which a
	// failed compaction only resets to toolCalled=false — so the retry must deliver
	// the stored direction, never anything the model supplied.
	const delivered = pi.sentUserMessages.at(-1)?.content ?? "";
	assert.ok(delivered.startsWith("## Next instruction\n\nGoal: continue"),
		"the stored human direction must lead the retried delivery");
	assert.match(delivered, /## Context\n\nretry context/);
});

test("synchronous compaction failure retains discard pages and restores a retryable handoff", async () => {
	const pi = createTestPI();
	const state = createState();
	state.notebookPages.set("stale", "obsolete");
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, nextInstruction: null };
	registerHandoffTool(pi as any, state);
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"sync-failure",
			{ nextInstruction: "continue work", discardPages: ["stale"] },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					theme: { fg: (_name: string, text: string) => text },
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: () => {},
				},
				getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
				compact: () => { throw new Error("synchronous compact failure"); },
			},
		),
		/synchronous compact failure/,
	);

	assert.equal(state.pendingHandoff, null);
	assert.equal(state.notebookPages.get("stale"), "obsolete");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
	assert.match(pi.sentUserMessages.at(-1)?.content ?? "", /Handoff failed/);
});

test("failed handoff shows waiting status when usage becomes unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, nextInstruction: null };
	registerHandoffTool(pi as any, state);
	let compactOptions: any;
	let usage: { tokens: number; percent: number; contextWindow: number } | null = {
		tokens: 50_000, percent: 25, contextWindow: 200_000,
	};
	const statuses = new Map<string, string | undefined>();

	await pi.tools.get("handoff").execute("1", { nextInstruction: "Goal: continue" }, undefined, undefined, {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			notify: () => {},
		},
		getContextUsage: () => usage,
		compact: (options: any) => { compactOptions = options; },
	});
	usage = null;
	compactOptions.onError(new Error("host failed"));

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");
});

test("handoff rejects overlapping compaction and preserves the first task", async () => {
	const pi = createTestPI();
	const state = createState();
	let firstCallbacks: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute("first", { nextInstruction: "first" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { firstCallbacks = options; },
	});
	const queuedGeneration = state.pendingHandoff?.generation;
	assert.equal(typeof queuedGeneration, "number", "the first handoff must queue a generation marker");
	await assert.rejects(
		() => pi.tools.get("handoff").execute("second", { nextInstruction: "second" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: () => {},
		}),
		/handoff compaction already in progress/i,
	);
	assert.equal(state.pendingHandoff?.generation, queuedGeneration,
		"the rejected second call must not clobber the queued handoff marker");

	firstCallbacks.onComplete();
	assert.equal(state.pendingHandoff, null);
	assert.equal(pi.sentUserMessages.length, 1, "only the winning handoff reports completion");
	assertSuccessorTurn(pi.sentUserMessages[0].content, { nextInstruction: "first" });
});

test("/handoff rejects a replacement while compaction is reserved", async () => {
	const pi = createTestPI();
	const state = createState();
	let firstCallbacks: any;
	registerHandoffCommand(pi as any, state);
	registerHandoffTool(pi as any, state);

	await pi.commands.get("handoff")!.handler("first", { hasUI: false, isIdle: () => true } as any);
	await pi.tools.get("handoff").execute("first", { nextInstruction: "first" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { firstCallbacks = options; },
	});

	const queuedGeneration = state.pendingHandoff?.generation;
	assert.equal(typeof queuedGeneration, "number", "the first handoff must queue a generation marker");
	await assert.rejects(
		() => pi.commands.get("handoff")!.handler("second", { hasUI: false, isIdle: () => true } as any),
		/handoff compaction already in progress/i,
	);
	assert.equal(state.pendingHandoff?.generation, queuedGeneration,
		"a rejected replacement must not clobber the queued handoff marker");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);

	firstCallbacks.onComplete();
	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
});

test("failed compaction releases the overlap guard without mutating state twice", async () => {
	const pi = createTestPI();
	const state = createState();
	let firstCallbacks: any;
	let secondCallbacks: any;
	const notifications: string[] = [];
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute("first", { nextInstruction: "first" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { firstCallbacks = options; },
	});
	await assert.rejects(
		() => pi.tools.get("handoff").execute("second", { nextInstruction: "second" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: () => {},
		}),
		/handoff compaction already in progress/i,
	);

	firstCallbacks.onError(new Error("first failure"));
	assert.equal(state.pendingHandoff, null);
	assert.deepEqual(notifications, []);
	assert.match(pi.sentUserMessages.at(-1)?.content ?? "", /Handoff failed/);

	await pi.tools.get("handoff").execute("second", { nextInstruction: "second" }, undefined, undefined, {
		hasUI: true,
		ui: { notify: () => {}, setStatus: () => {} } as any,
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { secondCallbacks = options; },
	});
	secondCallbacks.onComplete();
	assert.equal(pi.sentUserMessages.length, 2);
	assert.equal(pi.sentUserMessages[0].content, "Handoff failed — first failure. No required handoff remains pending; retry when ready.");
	assert.equal(pi.sentUserMessages[0].options?.deliverAs, "followUp",
		"failure guidance must queue while the agent run is active");
	assertSuccessorTurn(pi.sentUserMessages[1].content, { nextInstruction: "second" });
});

test("reset invalidates late handoff callbacks", async () => {
	const pi = createTestPI();
	const state = createState();
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	state.epoch = 1;
	state.notebookPages.set("stale", "retain");
	await pi.tools.get("handoff").execute("reset", { nextInstruction: "reset", discardPages: ["stale"] }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { callbacks = options; },
	});
	resetState(state);
	const recreatedGeneration = state.handoffGeneration;
	state.pendingHandoff = { generation: recreatedGeneration };
	state.pendingRequestedHandoff = { toolCalled: true, enforcementAttempts: 0, nextInstruction: null };
	callbacks.onComplete();

	assert.equal(state.pendingHandoff?.generation, recreatedGeneration,
		"the stale callback must not clear the re-created pending handoff");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);
	assert.equal(pi.sentUserMessages.length, 0);
	assert.deepEqual(pi.appendedEntries, [
		{ customType: "notebook-generation", data: { version: 1, epoch: 1 } },
	]);
});

test("handoff terminal callbacks are idempotent", async () => {
	const pi = createTestPI();
	const state = createState();
	let compactOptions: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute(
		"callbacks",
		{ nextInstruction: "continue work" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: (options: any) => { compactOptions = options; },
		},
	);

	compactOptions.onComplete({});
	compactOptions.onComplete({});
	compactOptions.onError(new Error("late failure"));

	assert.equal(pi.sentUserMessages.filter((message: any) => message.content.startsWith("## Next instruction")).length, 1);
	assert.equal(state.pendingHandoff, null);
});

test("handoff rejects malformed numeric context usage", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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
	const pi = createTestPI();
	registerAgenticoding(pi as any);
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

	const [turnEnd] = pi.handlers.get("turn_end")!;
	await turnEnd({}, {
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

test("handoff tool metadata and schema describe the prompt contract", () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	const tool = pi.tools.get("handoff");
	assert.match(tool.description, /past ~30%/i);
	assert.match(tool.description, /call handoff/i);
	assert.match(tool.description, /current notebook/i);
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

test("handoff compaction summaries identify each cut without changing the frame", () => {
	const first = buildHandoffCompactionSummary("first-cut");
	const second = buildHandoffCompactionSummary("second-cut");
	assert.notEqual(first, second, "Pi must be able to identify each compaction entry");
	assert.ok(first.startsWith(buildContinuationFrame()));
	assert.match(first, /<!-- handoff-cut:first-cut -->$/);
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
		"- The next user message carries your instruction verbatim, plus the previous agent's remaining situational context",
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
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null, "an empty instruction must not queue state");
});

test("handoff tool rejects small session with clear error", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null, "small-session rejection must not queue state");
});

test("handoff tool preserves pending requested handoff and re-engages LLM after synchronous small-session rejection", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, nextInstruction: null };
	registerHandoffTool(pi as any, state);
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

test("command handoff waits for eligibility and retries without watchdog cancellation", async () => {
	const pi = createTestPI();
	const state = createState();
	let compactOptions: any;
	registerHandoffCommand(pi as any, state);
	registerHandoffTool(pi as any, state);
	registerWatchdog(pi as any, state);
	const [watchdogHandler] = pi.handlers.get("agent_end")!;

	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => true } as any);
	await assert.rejects(
		() => pi.tools.get("handoff").execute("small", { nextInstruction: "continue work" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }),
		}),
	);
	await watchdogHandler({}, { hasUI: false, getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) } as any);
	assert.equal(state.pendingRequestedHandoff?.enforcementAttempts, 0);

	await pi.tools.get("handoff").execute("eligible", { nextInstruction: "continue work" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { compactOptions = options; },
	});
	compactOptions.onComplete();
	assert.equal(state.pendingRequestedHandoff, null);
});

test("handoff tool rejects small session with null percent without crashing", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null, "null-percent rejection must not queue state");
});

test("handoff tool rejects small session estimated from percent when tokens are unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null, "estimated small-session rejection must not queue state");
});

test("handoff tool accepts large estimated session when tokens are unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: null, percent: 20, contextWindow: 200000 }),
				compact: () => {},
			},
		),
	);
	assert.equal(state.pendingHandoff?.generation, state.handoffGeneration, "the handoff must queue its generation marker");
});

test("handoff tool accepts the exact 30000-token minimum", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"1",
			{ nextInstruction: "Goal: continue" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 30000, percent: 15, contextWindow: 200000 }),
				compact: () => {},
			},
		),
	);
	assert.equal(state.pendingHandoff?.generation, state.handoffGeneration, "the handoff must queue its generation marker");
});

test("handoff tool rejects session just below the 30000-token minimum", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null, "just-below-boundary rejection must not queue state");
});

test("handoff tool rejects a whitespace-only nextInstruction", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null);
});

test("a pending human direction wins over a model-supplied nextInstruction", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	registerHandoffTool(pi as any, state);

	const direction = "  Audit the retry budget.  ";
	await pi.commands.get("handoff")!.handler(direction, {
		hasUI: false,
		isIdle: () => true,
		getContextUsage: () => null,
	} as any);

	let compactOptions: any;
	await pi.tools.get("handoff").execute(
		"direction-precedence",
		{
			nextInstruction: "Verify the audit is done",
			context: "state machine rebuilt from scratch",
		},
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: (options: any) => { compactOptions = options; },
		},
	);

	compactOptions.onComplete();
	const delivered = pi.sentUserMessages.at(-1)?.content ?? "";
	assert.ok(delivered.startsWith(`## Next instruction\n\n${direction.trim()}`),
		"the human direction must be delivered verbatim modulo surrounding whitespace");
	assert.doesNotMatch(delivered, /Verify the audit is done/, "the model must not smuggle its own instruction through");
	assert.match(delivered, /## Context\n\nstate machine rebuilt from scratch/);
});

test("a pending human direction needs no tool arguments", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	registerHandoffTool(pi as any, state);

	await pi.commands.get("handoff")!.handler("finish the migration", { hasUI: false, isIdle: () => true } as any);

	let compactOptions: any;
	await pi.tools.get("handoff").execute("no-args", {}, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { compactOptions = options; },
	});

	compactOptions.onComplete();
	assertSuccessorTurn(pi.sentUserMessages.at(-1)!.content, { nextInstruction: "finish the migration" });
});

test("/handoff queues as a followUp while a run is active", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => false } as any);

	assert.equal(pi.sentUserMessages[0]?.options?.deliverAs, "followUp",
		"a direction sent mid-run must queue instead of being rejected");
});

test("handoff with no pending direction requires nextInstruction but not context", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute("missing-instruction", { context: "only context" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: () => {},
		}),
		/Empty handoff nextInstruction rejected/,
	);

	let compactOptions: any;
	const instruction = "  Ship the fix  ";
	await pi.tools.get("handoff").execute("instruction-only", { nextInstruction: instruction }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { compactOptions = options; },
	});

	compactOptions.onComplete();
	const delivered = pi.sentUserMessages.at(-1)!.content;
	// Surrounding whitespace is normalized at the resolver (like context); inner bytes preserved.
	assertSuccessorTurn(delivered, { nextInstruction: "Ship the fix" });
	assert.doesNotMatch(delivered, /## Context/, "no context means no empty context section");
});

test("handoff tool ignores a legacy task field and rejects the resulting empty instruction", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	// The harness calls execute directly, bypassing Pi's schema validation. TypeBox
	// tolerates the unknown key, so this pins that the removed fused field is never
	// consumed as the instruction: with no nextInstruction the call fails loudly.
	await assert.rejects(
		() => pi.tools.get("handoff").execute("legacy-task", { task: "old field" } as any, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: () => {},
		}),
		/Empty handoff nextInstruction rejected/,
	);

	assert.equal(state.pendingHandoff, null, "a legacy task field must not queue state");
});

test("handoff tool rejects when context usage is unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null, "unavailable usage must not queue state");
});

test("handoff tool preserves pending requested handoff and re-engages LLM after synchronous unavailable-usage rejection", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, nextInstruction: null };
	registerHandoffTool(pi as any, state);
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
		nextInstruction: null,
	});
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	// sendHandoffFailure re-engages the LLM
	assert.ok(pi.sentUserMessages.length > 0);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /required handoff remains pending/);
});

test("handoff tool rejects when context usage cannot be estimated", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

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

	assert.equal(state.pendingHandoff, null, "unestimable usage must not queue state");
});

test("session_start new clears stale handoff status and warning widget", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "stale"]]);
	const widgets = new Map<string, string[] | undefined>([[WIDGET_KEY_WARNING, ["stale"]]]);
	const sessionStartHandlers = pi.handlers.get("session_start")!;
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
	for (const sessionStart of sessionStartHandlers) {
		await sessionStart({ reason: "new" }, ctx);
	}

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.equal(widgets.get(WIDGET_KEY_WARNING), undefined);
});

test("session_before_compact ignores a stale generation", async () => {
	const pi = createTestPI();
	const state = createState();
	// Queue a handoff at generation N, then bump the generation counter
	// as if a newer request superseded it.
	state.pendingHandoff = { generation: 1 };
	state.handoffGeneration = 2;
	registerHandoffCompaction(pi as any, state);

	const [handler] = pi.handlers.get("session_before_compact")!;
	const result = await handler(
		{ preparation: { tokensBefore: 100 }, branchEntries: [{ id: "leaf-1" }] },
		{} as any,
	);

	assert.equal(result, undefined, "generation mismatch must skip compaction");
	assert.equal(state.pendingHandoff?.generation, 1,
		"pendingHandoff must keep its original generation for a stale compaction");
});
