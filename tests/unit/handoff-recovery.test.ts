import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { buildNextUserMessage, HANDOFF_REPORT_DELIMITER } from "../../handoff/format.js";
import { getUndeliveredHandoffMessage } from "../../handoff/recovery.js";
import { emitAll } from "./helpers.js";
import { createTestHost } from "./test-host.js";

const payload = { version: 1 as const, nextInstruction: "resume\nexactly", context: "blocked on CI" };
const message = buildNextUserMessage(payload);

// A legacy session persisted its successor with the operational report appended
// after this delimiter.
function legacyReportText(successorMessage: string, report: string): string {
	return successorMessage + HANDOFF_REPORT_DELIMITER + report;
}

let boundaryCutId = 0;

// A cut written by the turn_end boundary: no payload, identified by its handoffId.
function boundaryCut(details?: Record<string, unknown>): any {
	const id = ++boundaryCutId;
	return { id: `boundary-cut-${id}`, type: "compaction", details: details ?? { handoff: true, handoffId: `boundary-${id}` } };
}

function boundarySuccessor(): any {
	return { type: "custom_message", customType: "pi-schematic-handoff", content: "## Next instruction\n\nboundary work", display: true };
}

let handoffId = 0;
let messageId = 0;

function handoff(payloadOverride: unknown = payload): any {
	return { id: `handoff-${++handoffId}`, type: "compaction", details: { handoff: true, payload: payloadOverride } };
}

function recoveredMessage(entries: any[]): string | null {
	return getUndeliveredHandoffMessage(entries)?.message ?? null;
}

// `owner` sets the parent link that decides which cut owns this user turn.
function delivered(content: string | Array<{ type: string; text: string }>, owner?: { id: string }): any {
	return { id: `message-${++messageId}`, parentId: owner?.id ?? null, type: "message", message: { role: "user", content } };
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

test("a successor retained outside the active branch ends recovery", () => {
	const cut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([cut], [cut, delivered(message, cut)]),
		null,
		"editing the successor from /tree must not make its already delivered instruction recoverable",
	);
});

test("a predecessor's identical successor does not suppress a later lost delivery", () => {
	const firstCut = handoff();
	const secondCut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([secondCut], [firstCut, delivered(message, firstCut), secondCut])?.message,
		message,
		"delivery evidence belongs only to the cut that precedes it",
	);
});

test("an identical successor appended after a lost cut does not suppress its recovery", () => {
	// Cross-branch late delivery: the other branch's identical successor lands in
	// full history after the lost cut, but lineage attributes it to the other cut,
	// so the lost cut recovers.
	const otherCut = handoff();
	const lostCut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([lostCut], [otherCut, lostCut, delivered(message, otherCut)])?.message,
		message,
		"a same-text successor from another cut must not mask a genuinely lost cut",
	);
});

test("a later identical cut does not hide an earlier cut's delivered successor", () => {
	const deliveredCut = handoff();
	const laterCut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([deliveredCut], [deliveredCut, delivered(message, deliveredCut), laterCut]),
		null,
		"a later same-text cut cannot own a successor that was already delivered",
	);
});

test("a later same-message cut cannot claim a lost cut's delivery", () => {
	// The matching successor is owned by the later cut, so it does not prove the
	// lost cut delivered; lineage lets the lost cut recover instead of being masked.
	const lostCut = handoff();
	const laterDuplicateCut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([lostCut], [lostCut, laterDuplicateCut, delivered(message, laterDuplicateCut)])?.message,
		message,
		"a successor owned by a different cut must not suppress the lost cut",
	);
});

test("a delivered successor edited away is not re-sent when an earlier cut shares its text", () => {
	// Lineage attributes the surviving successor to this cut even though an earlier
	// cut carries the same payload, so the already-delivered instruction is not
	// duplicated.
	const earlierDuplicate = handoff();
	const deliveredCut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([deliveredCut], [earlierDuplicate, deliveredCut, delivered(message, deliveredCut)]),
		null,
		"lineage ownership must prevent a duplicate resend during /tree editing",
	);
});

test("an orphaned parent chain fails open toward resend", () => {
	const cut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([cut], [cut, delivered(message, { id: "missing-parent" })])?.message,
		message,
		"a match with no traceable owner must not suppress recovery",
	);
});

test("a cyclic parent chain terminates without an owner", () => {
	const cut = handoff();
	const a = delivered(message);
	const b = { id: "cycle-b", parentId: a.id, type: "custom", data: {} };
	a.parentId = b.id;
	assert.equal(
		getUndeliveredHandoffMessage([cut], [cut, a, b])?.message,
		message,
		"a cyclic chain must not loop or claim ownership",
	);
});

test("an intermediate entry between cut and successor preserves ownership", () => {
	const cut = handoff();
	const bridge = { id: "bridge", parentId: cut.id, type: "custom", data: {} };
	assert.equal(
		getUndeliveredHandoffMessage([cut], [cut, bridge, delivered(message, bridge)]),
		null,
		"a successor below any entry owned by the cut is still the cut's delivery",
	);
});

test("a successor carrying an appended operational report is owned delivery", () => {
	const cut = handoff();
	assert.equal(
		getUndeliveredHandoffMessage([cut], [cut, delivered(legacyReportText(message, "Notebook: 1 page kept."), cut)]),
		null,
		"the report-delimited successor prefix is still delivery evidence",
	);
});

test("malformed user content shapes do not throw recovery", () => {
	const cut = handoff();
	const malformed: any[] = [
		{ type: "message", message: { role: "user", content: 42 } },
		{ type: "message", message: { role: "user", content: { type: "text", text: message } } },
		{ type: "message", message: { role: "user", content: null } },
		{ type: "message", message: { role: "user", content: [null, { type: "text" }] } },
	];
	for (const entry of malformed) {
		assert.equal(
			getUndeliveredHandoffMessage([cut], [cut, entry])?.message,
			message,
			"malformed content is skipped, not crashed on",
		);
	}
});

test("a recovered resend is the bare payload without the operational report", () => {
	const lostWithReport = legacyReportText(message, "Notebook: 1 page kept.");
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
	const pi = await createTestHost();
	const branch: any[] = [handoff(), delivered([{ type: "text", text: "newer user work" }])];
	const [sessionTree] = pi.handlers.get("session_tree")!;

	// A queued follow-up may be the unpersisted successor, so the queue gate
	// suppresses recovery first — but the newer user turn must own the branch
	// once the queue drains, not resurrect the lost handoff instruction.
	const pendingCtx = { hasUI: false, hasPendingMessages: () => true, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	await sessionTree({}, pendingCtx);
	assert.deepEqual(pi.sentUserMessages, [], "an undrained queue must not be scanned for recovery");

	await emitAll(pi, "agent_settled", {}, { ...pendingCtx, hasPendingMessages: () => false });
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

test("a boundary cut after an undelivered legacy cut ends recovery", () => {
	// R1: the newest cut owns recovery, and a boundary cut writes its own successor.
	assert.equal(recoveredMessage([handoff(), boundaryCut(), boundarySuccessor()]), null);
});

test("a boundary cut is never resent even when its details carry a readable payload", () => {
	// The stop rests on handoffId, not on the payload being absent.
	assert.equal(recoveredMessage([boundaryCut({ handoff: true, handoffId: "with-payload", payload })]), null);
});

test("a non-handoff compaction does not supersede the last handoff cut", () => {
	assert.equal(recoveredMessage([
		handoff(),
		{ type: "compaction", summary: "automatic compaction", details: { reason: "auto" } },
	]), message);
});

test("repeated tree triggers coalesce and a settled run retries only while absent", async () => {
	const pi = await createTestHost();
	const branch: any[] = [handoff()];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	await sessionTree({}, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }],
		"repeated triggers must coalesce into one delivery");

	const settleCtx = { ...ctx, hasPendingMessages: () => false };
	await emitAll(pi, "agent_settled", {}, settleCtx);
	assert.equal(pi.sentUserMessages.length, 2, "a settled run retries a still-absent successor");

	branch.push(delivered([{ type: "text", text: message }]));
	await emitAll(pi, "agent_settled", {}, settleCtx);
	assert.equal(pi.sentUserMessages.length, 2, "a persisted successor must not be re-sent");
});

test("a session start re-opens the delivery scope after an in-process session load", async () => {
	const pi = await createTestHost();
	const branch: any[] = [handoff()];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	assert.equal(pi.sentUserMessages.length, 1);

	await emitAll(pi, "session_start", { reason: "load" }, ctx);
	assert.equal(pi.sentUserMessages.length, 2, "a new session scope evaluates recovery freshly");
});

test("recovery does not run while a handoff is staged", async () => {
	const pi = await createTestHost();
	const branch: any[] = [handoff()];
	await pi.tools.get("handoff")!.execute(
		"staged",
		{ nextInstruction: "new phase" },
		undefined,
		undefined,
		{
			hasUI: false,
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
		},
	);

	await emitAll(pi, "session_start", { reason: "resume" }, {
		hasUI: false,
		hasPendingMessages: () => false,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	});
	assert.deepEqual(pi.sentUserMessages, [], "the staged cut owns the next delivery; an older payload must not be resent");
});

test("tree navigation and resume queue a missing successor in a fresh process", async () => {
	const pi = await createTestHost();
	const branch = [handoff()];
	const ctx = { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;
	await sessionTree({}, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);

	const resumedPi = await createTestHost();
	await emitAll(resumedPi, "session_start", { reason: "load" }, ctx);
	assert.deepEqual(resumedPi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);
});

test("a session whose newest cut is a boundary cut never resends after tree, start, or settle", async () => {
	const pi = await createTestHost();
	// An undelivered legacy cut precedes the boundary cut that superseded it.
	const branch: any[] = [handoff(), boundaryCut(), boundarySuccessor()];
	const ctx = { hasUI: false, hasPendingMessages: () => false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } };
	const [sessionTree] = pi.handlers.get("session_tree")!;

	await sessionTree({}, ctx);
	await emitAll(pi, "session_start", { reason: "resume" }, ctx);
	await emitAll(pi, "agent_settled", {}, ctx);

	assert.deepEqual(pi.sentUserMessages, [], "a boundary cut delivers its own successor; recovery must stay silent");
});

test("identical payloads on separate branches each recover once", async () => {
	const pi = await createTestHost();
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
	const pi = await createTestHost();
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
	const pi = await createTestHost();
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
	const pi = await createTestHost();
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
	const pi = await createTestHost();
	const branch: any[] = [handoff()];
	const queuedCtx = {
		hasUI: false,
		hasPendingMessages: () => true,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	};

	const [sessionTree] = pi.handlers.get("session_tree")!;
	await sessionTree({}, queuedCtx);
	await emitAll(pi, "session_start", { reason: "load" }, queuedCtx);
	assert.deepEqual(pi.sentUserMessages, [],
		"a queued follow-up may be the unpersisted successor; resending would double-deliver");

	// Once the queue drains, the next settle is the retry boundary and recovers once.
	await emitAll(pi, "agent_settled", {}, { ...queuedCtx, hasPendingMessages: () => false });
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);
});

test("session start recovers on reasons other than load when the queue is empty", async () => {
	const pi = await createTestHost();
	const branch: any[] = [handoff()];
	const ctx = {
		hasUI: false,
		hasPendingMessages: () => false,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	};

	await emitAll(pi, "session_start", { reason: "resume" }, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }],
		"recovery must not be gated on a specific session_start reason");
});

test("a later settled run recovers an absent successor only after its queue drains", async () => {
	const pi = await createTestHost();
	const branch: any[] = [handoff()];
	const ctx = {
		hasUI: false,
		hasPendingMessages: () => false,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => branch },
	};

	await emitAll(pi, "agent_settled", {}, ctx);
	assert.deepEqual(pi.sentUserMessages, [{ content: message, options: { deliverAs: "followUp" } }]);

	branch.push({ type: "message", message: { role: "user", content: message } });
	await emitAll(pi, "agent_settled", {}, ctx);
	assert.equal(pi.sentUserMessages.length, 1, "persisted delivery must not be sent again");

	const pendingPi = await createTestHost();
	await emitAll(pendingPi, "agent_settled", {}, { ...ctx, hasPendingMessages: () => true });
	assert.deepEqual(pendingPi.sentUserMessages, [], "an undrained queue must not be duplicated");
});
