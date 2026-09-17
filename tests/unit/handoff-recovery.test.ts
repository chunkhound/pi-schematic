import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import registerAgenticoding from "../../index.js";
import { appendHandoffReport, buildNextUserMessage, HANDOFF_REPORT_DELIMITER } from "../../handoff/format.js";
import { getUndeliveredHandoffMessage } from "../../handoff/recovery.js";
import { createTestPI } from "./helpers.js";

const payload = { version: 1 as const, nextInstruction: "resume\nexactly", context: "blocked on CI" };
const message = buildNextUserMessage(payload);

let handoffId = 0;

function handoff(payloadOverride: unknown = payload): any {
	return { id: `handoff-${++handoffId}`, type: "compaction", details: { handoff: true, payload: payloadOverride } };
}

function recoveredMessage(entries: any[]): string | null {
	return getUndeliveredHandoffMessage(entries)?.message ?? null;
}

function delivered(content: string | Array<{ type: string; text: string }>): any {
	return { type: "message", message: { role: "user", content } };
}

test("recovers the exact successor message from the newest handoff compaction", () => {
	assert.equal(recoveredMessage([
		handoff({ version: 1, nextInstruction: "old", context: "old state" }),
		handoff(),
	]), message);
});

test("a persisted successor ends recovery", () => {
	// Presence, not shape, ends recovery: any user turn after the cut supersedes.
	assert.equal(recoveredMessage([handoff(), delivered(message)]), null);
});

test("a recovered resend is the bare payload without the operational report", () => {
	const lostWithReport = appendHandoffReport(message, "Notebook: 1 page kept.");
	assert.ok(lostWithReport.includes(HANDOFF_REPORT_DELIMITER));
	const recovered = recoveredMessage([handoff()]);
	assert.equal(recovered, message);
	assert.ok(!recovered!.includes(HANDOFF_REPORT_DELIMITER),
		"a recovered headless delivery must drop the stale operational report");
});

test("a distinct user turn after the cut abandons recovery", () => {
	assert.equal(
		recoveredMessage([handoff(), delivered([{ type: "text", text: "## Next instruction\n\nsomething else" }])]),
		null,
		"newer user intent must not be followed by the lost handoff instruction",
	);
	assert.equal(
		recoveredMessage([handoff(), delivered([{ type: "text" } as { type: string; text: string }])]),
		null,
		"an empty user turn is not delivery but still supersedes recovery",
	);
});

test("non-user entries after the cut do not abandon recovery", () => {
	assert.equal(
		recoveredMessage([handoff(), { type: "message", message: { role: "assistant", content: "working" } }]),
		message,
	);
});

test("a malformed message entry without content does not throw or abandon recovery", () => {
	assert.equal(recoveredMessage([handoff(), { type: "message" }]), message);
	assert.equal(recoveredMessage([handoff(), { type: "message", message: null }]), message);
});

test("a newer user turn abandons recovery even while the queue is still pending", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [handoff(), delivered([{ type: "text", text: "newer user work" }])];
	const [sessionTree] = pi.handlers.get("session_tree")!;
	const [agentSettled] = pi.handlers.get("agent_settled")!;

	// A queued follow-up may be the unpersisted successor, so the queue gate
	// suppresses recovery first — but the newer user turn must own the branch
	// once the queue drains, not resurrect the lost handoff instruction.
	const pendingCtx = { hasUI: false, hasPendingMessages: () => true, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	await sessionTree({}, pendingCtx);
	assert.deepEqual(pi.sentUserMessages, [], "an undrained queue must not be scanned for recovery");

	await agentSettled({}, { ...pendingCtx, hasPendingMessages: () => false });
	assert.deepEqual(pi.sentUserMessages, [], "a drained queue must not resend superseded handoff work");
});

test("a distinct user turn after a delivered successor does not resurrect recovery", () => {
	assert.equal(
		recoveredMessage([handoff(), delivered([{ type: "text", text: message }]), delivered([{ type: "text", text: "newer user work" }])]),
		null,
		"supersession must hold in delivery-then-user-turn order",
	);
});

test("a user turn between two cuts does not abandon the newest recovery", () => {
	assert.equal(
		recoveredMessage([
			handoff({ version: 1, nextInstruction: "old", context: "old state" }),
			delivered([{ type: "text", text: "newer work" }]),
			handoff(),
		]),
		message,
		"only entries after the newest cut supersede recovery",
	);
});

test("any user-entry shape after the cut abandons recovery", async () => {
	// Supersession is presence-based, so every persisted user-entry shape — string
	// content, text parts, parts with missing text, non-text parts — must end
	// recovery without the scan inspecting or choking on the content.
	const part = fc.record({ type: fc.string(), text: fc.option(fc.string(), { nil: undefined }) });
	const userEntry = fc.oneof(fc.string(), fc.array(part)).map((content) => delivered(content as any));
	await fc.assert(
		fc.property(userEntry, (entry) => {
			assert.equal(recoveredMessage([handoff(), entry]), null);
		}),
	);
});

test("ignores legacy, malformed, and future handoff details", () => {
	assert.equal(recoveredMessage([
		{ type: "compaction", details: { handoff: true } },
		handoff({ version: 2, nextInstruction: "future", context: "state" }),
		handoff({ version: 1, nextInstruction: 1, context: "state" }),
	]), null);
});

test("an unreadable newest handoff supersedes an older recoverable one", () => {
	// Mixed-version branch: the newest cut came from a build without payloads.
	// Recovery must not resurrect the older, superseded instruction.
	assert.equal(recoveredMessage([
		handoff(),
		{ type: "compaction", details: { handoff: true } },
	]), null);
});

test("a non-handoff compaction does not supersede the last handoff cut", () => {
	assert.equal(recoveredMessage([
		handoff(),
		{ type: "compaction", summary: "automatic compaction", details: { reason: "auto" } },
	]), message);
});

test("repeated tree triggers coalesce and a settled run retries only while absent", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [handoff()];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	await sessionTree({}, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }],
		"repeated triggers must coalesce into one delivery");

	const [agentSettled] = pi.handlers.get("agent_settled")!;
	const settleCtx = { ...ctx, hasPendingMessages: () => false };
	await agentSettled({}, settleCtx);
	assert.equal(pi.sentUserMessages.length, 2, "a settled run retries a still-absent successor");

	branch.push(delivered([{ type: "text", text: message }]));
	await agentSettled({}, settleCtx);
	assert.equal(pi.sentUserMessages.length, 2, "a persisted successor must not be re-sent");
});

test("a session start re-opens the delivery scope after an in-process session load", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [handoff()];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	assert.equal(pi.sentUserMessages.length, 1);

	for (const handler of pi.handlers.get("session_start") ?? []) await handler({ reason: "load" }, ctx);
	assert.equal(pi.sentUserMessages.length, 2, "a new session scope evaluates recovery freshly");
});

test("a settled run during an in-flight cut does not recover an older payload", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [handoff()];
	// Start a handoff but never settle its callbacks: the compaction reservation stays set.
	await pi.tools.get("handoff")!.execute(
		"in-flight",
		{ nextInstruction: "new phase" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			compact: () => {},
		},
	);

	const [agentSettled] = pi.handlers.get("agent_settled")!;
	await agentSettled({}, {
		hasUI: false,
		hasPendingMessages: () => false,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	});
	assert.deepEqual(pi.sentUserMessages, [], "the in-flight cut owns delivery of the newest payload");
});

test("tree navigation and resume queue a missing successor in a fresh process", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch = [handoff()];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;
	await sessionTree({}, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);

	const resumedPi = createTestPI();
	registerAgenticoding(resumedPi as any);
	for (const handler of resumedPi.handlers.get("session_start") ?? []) await handler({ reason: "load" }, ctx);
	assert.deepEqual(resumedPi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);
});

test("a direct delivery is latched against duplicate tree recovery until settle", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [];
	let callbacks: any;
	await pi.tools.get("handoff")!.execute(
		"direct",
		{ nextInstruction: "do it" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			compact: (options: any) => { callbacks = options; },
		},
	);

	// Model the cut landing in the branch, then complete the direct delivery.
	const [beforeCompact] = pi.handlers.get("session_before_compact")!;
	const result = await beforeCompact({ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] }, {});
	branch.push({ type: "compaction", id: "compaction-1", summary: result.compaction.summary, details: result.compaction.details });
	callbacks.onComplete();

	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const successorCount = () => pi.sentUserMessages.filter((message) => message.content.startsWith("## Next instruction")).length;

	const [sessionTree] = pi.handlers.get("session_tree")!;
	await sessionTree({}, ctx);
	assert.equal(successorCount(), 1, "tree recovery must not duplicate an outstanding direct delivery");

	// A settled run proves the delivery is still absent, so recovery retries once.
	const [agentSettled] = pi.handlers.get("agent_settled")!;
	await agentSettled({}, { ...ctx, hasPendingMessages: () => false });
	assert.equal(successorCount(), 2, "a settle must retry a delivery that never persisted");
});

test("identical payloads on separate branches each recover once", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branchA = [handoff()];
	const branchB = [handoff()];
	let branch = branchA;
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	branch = branchB;
	await sessionTree({}, ctx);

	assert.deepEqual(pi.sentUserMessages, [
		{ content: message, options: { deliverAs: "followUp" } },
		{ content: message, options: { deliverAs: "followUp" } },
	], "a branch change must not suppress its own undelivered successor");
});

test("a cut shared across tree branches coalesces instead of double-sending", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const shared = handoff();
	const branchA: any[] = [shared];
	const branchB: any[] = [{ type: "message", message: { role: "user", content: "older work" } }, shared];
	let branch = branchA;
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	branch = branchB;
	await sessionTree({}, ctx);

	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }],
		"the same persisted cut on a new branch must reuse the outstanding delivery latch");
});

test("a same-text new cut with a different recovery key re-arms recovery", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [{ id: "handoff-key-a", type: "compaction", details: { handoff: true, payload, recoveryKey: "key-a" } }];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	assert.equal(pi.sentUserMessages.length, 1, "the first cut must deliver once");

	// Same instruction text, new cut identity: the latch must not coalesce it away.
	branch.push({ id: "handoff-key-b", type: "compaction", details: { handoff: true, payload, recoveryKey: "key-b" } });
	await sessionTree({}, ctx);
	assert.deepEqual(pi.sentUserMessages, [
		{ content: message, options: { deliverAs: "followUp" } },
		{ content: message, options: { deliverAs: "followUp" } },
	], "a new cut with a different recovery key must re-arm recovery even for identical text");
});

test("a recovery send failure releases its latch for the next trigger", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch = [handoff()];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;
	const originalSend = pi.sendUserMessage;
	pi.sendUserMessage = () => { throw new Error("channel closed"); };

	await assert.rejects(() => sessionTree({}, ctx), /channel closed/);
	pi.sendUserMessage = originalSend;
	await sessionTree({}, ctx);

	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }],
		"a later recovery trigger must retry after a synchronous send failure");
});

test("tree and session-start recovery wait for a queued follow-up to drain", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [handoff()];
	const queuedCtx = {
		hasUI: false,
		hasPendingMessages: () => true,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	};

	const [sessionTree] = pi.handlers.get("session_tree")!;
	await sessionTree({}, queuedCtx);
	for (const handler of pi.handlers.get("session_start") ?? []) await handler({ reason: "load" }, queuedCtx);
	assert.deepEqual(pi.sentUserMessages, [],
		"a queued follow-up may be the unpersisted successor; resending would double-deliver");

	// Once the queue drains, the next settle is the retry boundary and recovers once.
	const [agentSettled] = pi.handlers.get("agent_settled")!;
	await agentSettled({}, { ...queuedCtx, hasPendingMessages: () => false });
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);
});

test("session start recovers on reasons other than load when the queue is empty", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [handoff()];
	const ctx = {
		hasUI: false,
		hasPendingMessages: () => false,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	};

	for (const handler of pi.handlers.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }],
		"recovery must not be gated on a specific session_start reason");
});

test("a later settled run recovers an absent successor only after its queue drains", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const branch: any[] = [handoff()];
	const [agentSettled] = pi.handlers.get("agent_settled")!;
	const ctx = {
		hasUI: false,
		hasPendingMessages: () => false,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	};

	await agentSettled({}, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);

	branch.push({ type: "message", message: { role: "user", content: message } });
	await agentSettled({}, ctx);
	assert.equal(pi.sentUserMessages.length, 1, "persisted delivery must not be sent again");

	const pendingPi = createTestPI();
	registerAgenticoding(pendingPi as any);
	const [pendingSettled] = pendingPi.handlers.get("agent_settled")!;
	await pendingSettled({}, { ...ctx, hasPendingMessages: () => true });
	assert.deepEqual(pendingPi.sentUserMessages, [], "an undrained queue must not be duplicated");
});
