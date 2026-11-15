/**
 * Real-host E2E tests: pi-schematic inside the real pi CLI in RPC mode, driven
 * through `RpcClient` with the scripted probe provider. The turn_end boundary,
 * follow-up handling, compaction, branch lineage and tree navigation are pi's own.
 */

import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompactionEntry, CustomMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { canUseOsSandbox, quoteShellArgument } from "../../os-sandbox.js";
import { MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import { assertPresent, expectSuffix } from "../assertions.js";
import { messageText, RealHost, REAL_HOST_TEST_TIMEOUT_MS, SCHEMATIC_ENTRY, toolResults, withRealHost, type RpcEvent } from "./real-host.js";
import {
	CHILD_EMPTY_REPLY_MARKER,
	CHILD_REPLY_TEXT,
	PROBE_COMMAND,
	PROBE_CONTEXT_WINDOW,
	cutHandoffId,
	isJsonObject,
	type ProbeRecord,
	type ScriptedCall,
} from "./real-host-protocol.js";

type RequestRecord = Extract<ProbeRecord, { kind: "request" }>;

/** Custom type of the successor message the handoff boundary writes. */
const SUCCESSOR_CUSTOM_TYPE = "pi-schematic-handoff";
/** Custom type of the hidden note the handoff boundary writes after the successor. */
const NOTE_CUSTOM_TYPE = "pi-schematic-handoff-note";
/** Status key of the handoff indicator. */
const HANDOFF_STATUS_KEY = "pi-schematic-handoff";
const STAGED_RESULT = "Handoff staged. This context is cut when the turn ends, and the successor continues in the same run.";
const REQUIRED_STATUS = "🤝 Handoff required — ready to compact";
const READONLY_SUMMARY =
	"[readonly] enabled — write/edit/powershell blocked; bash writes/deletions outside temp blocked; handoff needs explicit /handoff or an eligible human topic boundary.";
const SANDBOX_BLOCK_NOTICE =
	"[readonly mode] If this command failed on a write outside the OS temp dir, the OS sandbox blocked it.\nUse /readonly to disable, or write within the OS temp dir.";
/** Successor of the handoff with "continue readonly work" and context "mid-task state". */
const READONLY_WORK_SUCCESSOR = "## Next instruction\n\ncontinue readonly work\n\n## Context\n\nmid-task state";
/** Successor of the handoff with "do the resumed work" and context "remaining state". */
const RESUMED_WORK_SUCCESSOR = "## Next instruction\n\ndo the resumed work\n\n## Context\n\nremaining state";

function handoffCall(args: ScriptedCall["arguments"]): ScriptedCall[] {
	return [{ name: "handoff", arguments: args }];
}

/** "Handoff call A": a scripted run whose first step calls handoff with A, starting `runs` runs. */
async function handoff(host: RealHost, args: ScriptedCall["arguments"], runs: number): Promise<void> {
	await host.script(handoffCall(args), runs);
}

/** "/handoff D answered by handoff call A": the command's own run consumes the script; `runs` runs start. */
async function handoffCommand(host: RealHost, direction: string, args: ScriptedCall["arguments"], runs: number): Promise<void> {
	await host.arm(handoffCall(args));
	await host.turn(`/handoff ${direction}`, runs);
}

function userText(entry: SessionEntry): string | null {
	if (entry.type !== "message" || entry.message.role !== "user") {
		return null;
	}
	return messageText(entry.message.content);
}

function handoffCuts(entries: SessionEntry[]): CompactionEntry[] {
	return entries.filter((entry): entry is CompactionEntry => cutHandoffId(entry) !== null);
}

function handoffIdOf(cut: CompactionEntry): string {
	const handoffId = cutHandoffId(cut);
	assertPresent(handoffId, "the handoff cut carries its handoff id");
	return handoffId;
}

function onlyHandoffCut(entries: SessionEntry[]): CompactionEntry {
	const cuts = handoffCuts(entries);
	expect(cuts, "exactly one handoff cut entry").toHaveLength(1);
	return cuts[0];
}

function customMessages(entries: SessionEntry[], customType: string): CustomMessageEntry[] {
	return entries.filter((entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === customType);
}

function onlyCustomMessage(entries: SessionEntry[], customType: string): CustomMessageEntry {
	const messages = customMessages(entries, customType);
	expect(messages, `exactly one ${customType} entry`).toHaveLength(1);
	return messages[0];
}

function userEntriesWithText(entries: SessionEntry[], text: string): SessionEntry[] {
	return entries.filter((entry) => userText(entry) === text);
}

function firstAssistantAfter(entries: SessionEntry[], entryId: string): SessionEntry {
	const index = entries.findIndex((entry) => entry.id === entryId);
	expect(index, `entry ${entryId} exists`).not.toBe(-1);
	const assistant = entries.slice(index + 1).find((entry) => entry.type === "message" && entry.message.role === "assistant");
	assertPresent(assistant, `an assistant entry follows ${entryId}`);
	return assistant;
}

/** Request records logged after the probe saw the cut of `handoffId` in its turn_end. */
function requestsAfterCut(log: ProbeRecord[], handoffId: string): RequestRecord[] {
	const index = log.findIndex((record) => record.kind === "cut" && record.handoffId === handoffId);
	expect(index, `cut record for ${handoffId}`).not.toBe(-1);
	return log.slice(index + 1).filter((record): record is RequestRecord => record.kind === "request");
}

/** Indexes of the `entry_appended` events in `events` that carry a handoff cut. */
function cutAppendedIndexes(events: RpcEvent[]): number[] {
	return events.flatMap((event, index) => (event.type === "entry_appended" && cutHandoffId(appendedEntry(event)) !== null ? [index] : []));
}

/** The entry an `entry_appended` event carries; throws unless it is an object with a string `type`. */
function appendedEntry(event: RpcEvent): { type: string; details?: unknown } {
	const { entry } = event;
	if (!isJsonObject(entry) || typeof entry.type !== "string") {
		throw new Error(`entry_appended event without an entry object: ${JSON.stringify(event)}`);
	}
	return { type: entry.type, details: entry.details };
}

function containsText(record: RequestRecord, text: string): boolean {
	return record.texts.some((candidate) => candidate.includes(text));
}

/** First line of the watchdog nudge that tells the model to hand off now. */
const ELIGIBLE_HANDOFF_NUDGE = "A real handoff is required in this session now.";

/** Threshold compaction reserve: pi compacts once a reply reports more than the window minus this. */
const COMPACTION_RESERVE_TOKENS = PROBE_CONTEXT_WINDOW / 2;

function eventsOfType(events: RpcEvent[], type: string): RpcEvent[] {
	return events.filter((event) => event.type === type);
}

/** Messages of the host's notifications that start with `prefix`. */
function notificationsStartingWith(host: RealHost, prefix: string): string[] {
	return host.notifications.map((notification) => notification.message).filter((message) => message.startsWith(prefix));
}

/** Notices of a required handoff the watchdog cancelled. */
function handoffCancellations(host: RealHost): string[] {
	return notificationsStartingWith(host, "Required handoff cancelled");
}

/**
 * After a `/handoff` run that counted one attempt: the next MAX_HANDOFF_ATTEMPTS - 2 runs, each
 * nudged and counted once, leave the handoff required, and the run after them cancels it.
 */
async function expectCancellationAtLastAttempt(host: RealHost): Promise<void> {
	const middleRuns = MAX_HANDOFF_ATTEMPTS - 2;
	await host.turn(`/${PROBE_COMMAND.turn} ${middleRuns}`, middleRuns);
	expect(handoffCancellations(host), `the handoff stays required after ${MAX_HANDOFF_ATTEMPTS - 1} settled runs`).toStrictEqual([]);
	await host.turn("/" + PROBE_COMMAND.turn, 1);
	expect(handoffCancellations(host), `settled run ${MAX_HANDOFF_ATTEMPTS} cancels the handoff`).toHaveLength(1);
	const handoffStatuses = host.statuses.filter((status) => status.statusKey === HANDOFF_STATUS_KEY);
	expect(
		handoffStatuses.map((status) => status.statusText),
		"the handoff required status was shown",
	).toContain(REQUIRED_STATUS);
	expect(handoffStatuses.at(-1)?.statusText, "the handoff status is cleared").toBeUndefined();
}

function onlyResult<T>(results: T[], label: string): T {
	expect(results, `exactly one ${label} result`).toHaveLength(1);
	return results[0];
}

describe("pi-schematic real-host E2E", { timeout: REAL_HOST_TEST_TIMEOUT_MS }, () => {
	it("host starts and extension registers", async (t) =>
		withRealHost(t, async (host) => {
			await host.command("/" + PROBE_COMMAND.tools);
			await host.settle(0);
			const tools = host.probeLog().filter((record) => record.kind === "tools");
			expect(tools, "one tools record").toHaveLength(1);
			for (const name of ["notebook_write", "notebook_read", "notebook_index", "notebook_topic_set", "handoff", "spawn"]) {
				expect(tools[0].names, `${name} tool registered`).toContain(name);
			}
		}));

	it("commands are registered", async (t) =>
		withRealHost(t, async (host) => {
			const commands = await host.client.getCommands();
			const names = commands
				.filter((command) => command.source === "extension" && resolve(command.sourceInfo.path) === SCHEMATIC_ENTRY)
				.map((command) => command.name)
				.sort();
			expect(names).toStrictEqual(["handoff", "model-groups", "notebook", "readonly"]);
		}));

	it("spawn adds the child's usage to the parent's session stats", async (t) =>
		withRealHost(t, async (host) => {
			await host.script(
				[
					{ name: "spawn", arguments: { prompt: "child task" } },
					{ text: "done", inputTokens: 50000 },
				],
				1,
			);
			const { entries } = await host.entries();
			const spawn = onlyResult(toolResults(entries, "spawn"), "spawn");
			expect(spawn).toMatchObject({ isError: false, text: CHILD_REPLY_TEXT });

			const stats = await host.client.getSessionStats();
			// Two parent assistant messages report 50000 input tokens each; the child reports
			// 1234 input, 56 output, 7 cache-read and 8 cache-write tokens at a cost of 0.9375.
			expect({ ...stats.tokens, cost: stats.cost }).toStrictEqual({ input: 101234, output: 56, cacheRead: 7, cacheWrite: 8, total: 101305, cost: 0.9375 });
			// Pi sizes the context from the last assistant message's usage alone: the final reply's
			// 50000 tokens, not 51305 with the child's 1305.
			expect(stats.contextUsage?.tokens).toBe(50000);
		}));

	it("a spawn that fails after its child ran still adds the child's usage to the parent's session stats", async (t) =>
		withRealHost(t, async (host) => {
			await host.script(
				[
					{ name: "spawn", arguments: { prompt: `child task ${CHILD_EMPTY_REPLY_MARKER}` } },
					{ text: "done", inputTokens: 50000 },
				],
				1,
			);
			const { entries } = await host.entries();
			const spawn = onlyResult(toolResults(entries, "spawn"), "spawn");
			expect(spawn).toMatchObject({ isError: true, text: "Child agent produced no output." });

			const stats = await host.client.getSessionStats();
			// Two parent assistant messages report 50000 input tokens each; the child's one empty
			// reply reports 1234 input, 56 output, 7 cache-read and 8 cache-write tokens at a cost of 0.9375.
			expect({ ...stats.tokens, cost: stats.cost }).toStrictEqual({ input: 101234, output: 56, cacheRead: 7, cacheWrite: 8, total: 101305, cost: 0.9375 });
		}));

	it("handoff writes the cut, the successor and the note as one boundary and re-announces readonly in the successor turn", async (t) =>
		withRealHost(t, async (host) => {
			await host.command("/readonly");
			await host.say("start", 1);
			const mark = host.events.length;
			await handoffCommand(host, "continue readonly work", { context: "mid-task state" }, 1);

			const { entries } = await host.entries();
			const result = onlyResult(toolResults(entries, "handoff"), "handoff");
			expect(result.text).toBe(STAGED_RESULT);
			const cut = onlyHandoffCut(entries);
			expect(cut.firstKeptEntryId, "the cut retains no earlier entry").toBe(cut.id);
			const successor = onlyCustomMessage(entries, SUCCESSOR_CUSTOM_TYPE);
			expect(successor, "the successor is the cut's shown child").toMatchObject({
				parentId: cut.id,
				content: READONLY_WORK_SUCCESSOR,
				display: true,
			});
			const note = onlyCustomMessage(entries, NOTE_CUSTOM_TYPE);
			expect(note, "the note follows the successor and is hidden").toMatchObject({ parentId: successor.id, display: false });
			const handoffRun = host.events.slice(mark);
			expect(cutAppendedIndexes(handoffRun), "the cut arrives as one entry_appended event").toHaveLength(1);
			expect(eventsOfType(handoffRun, "compaction_end"), "the cut fires no compaction_end").toHaveLength(0);
			expect(
				requestsAfterCut(host.probeLog(), handoffIdOf(cut)).filter((record) => containsText(record, READONLY_SUMMARY)),
				"readonly is re-announced after the handoff",
			).toHaveLength(1);
			expect(await host.client.clearQueue()).toStrictEqual({ steering: [], followUp: [] });
		}));

	it("a boundary successor is not re-sent by settle or tree navigation", async (t) =>
		withRealHost(t, async (host) => {
			const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
			await handoff(host, payload, 1);
			const before = await host.entries();
			const successor = onlyCustomMessage(before.entries, SUCCESSOR_CUSTOM_TYPE);
			expect(successor.content, "the successor carries the text the resend check looks for").toBe(RESUMED_WORK_SUCCESSOR);
			await host.navigate(firstAssistantAfter(before.entries, successor.id).id, 0);
			await host.turn("/" + PROBE_COMMAND.turn, 1);

			const { entries } = await host.entries();
			expect(customMessages(entries, SUCCESSOR_CUSTOM_TYPE), "one successor entry").toHaveLength(1);
			expect(userEntriesWithText(entries, RESUMED_WORK_SUCCESSOR), "no successor resent as a user message").toHaveLength(0);
		}));

	it("editing a boundary successor never re-delivers its instruction", async (t) =>
		withRealHost(t, async (host) => {
			const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
			await handoff(host, payload, 1);
			const before = await host.entries();
			const cut = onlyHandoffCut(before.entries);
			const successor = onlyCustomMessage(before.entries, SUCCESSOR_CUSTOM_TYPE);
			expect(successor.content, "the successor carries the text the resend check looks for").toBe(RESUMED_WORK_SUCCESSOR);
			await host.navigate(successor.id, 0);

			const { entries, leafId } = await host.entries();
			expect(leafId, "editing the successor moves the leaf to the cut").toBe(cut.id);
			expect(customMessages(entries, SUCCESSOR_CUSTOM_TYPE), "one successor entry").toHaveLength(1);
			expect(userEntriesWithText(entries, RESUMED_WORK_SUCCESSOR), "no successor resent as a user message").toHaveLength(0);
		}));

	it("readonly is re-announced in the run after a handoff whose successor was dropped", async (t) =>
		withRealHost(t, async (host) => {
			await host.command("/readonly");
			await host.say("start", 1);
			await host.command("/" + PROBE_COMMAND.dropNextSuccessor);
			await handoffCommand(host, "continue readonly work", { context: "mid-task state" }, 1);
			await host.turn("/" + PROBE_COMMAND.turn, 1);

			const cut = onlyHandoffCut((await host.entries()).entries);
			const laterRequests = requestsAfterCut(host.probeLog(), handoffIdOf(cut));
			expect(laterRequests, "the later run calls the model").toHaveLength(2);
			expect(
				laterRequests.filter((record) => containsText(record, READONLY_SUMMARY)),
				"readonly is re-announced after the failed handoff",
			).toHaveLength(1);
		}));

	it("a run pi retries counts one required-handoff attempt", async (t) =>
		withRealHost(
			t,
			async (host) => {
				// A tool call reports usage that makes the handoff eligible, so the call after it is nudged. The
				// first nudged call fails with a retryable error and pi retries in the same run. pi omits the
				// failed attempt with a context edit, which leaves usage unknown until the retry pass's own
				// tool call reports it again, so that pass is nudged at its second call.
				await host.arm([{ name: "e2e_noop", arguments: {} }, { error: "503 Service Unavailable" }, { name: "e2e_noop", arguments: {} }]);
				const mark = host.events.length;
				await host.turn("/handoff finish the report", 1);

				const handoffRun = host.events.slice(mark);
				const ends = eventsOfType(handoffRun, "agent_end");
				expect(ends, "the failed pass and its retry each end with agent_end").toHaveLength(2);
				expect(ends[0].willRetry, "pi retries the failed pass").toBe(true);
				expect(eventsOfType(handoffRun, "agent_settled"), "the run settles once").toHaveLength(1);
				const nudged = host.probeLog().filter((record): record is RequestRecord => record.kind === "request" && containsText(record, ELIGIBLE_HANDOFF_NUDGE));
				expect(
					nudged.map((record) => record.step),
					"the failed pass and the retry pass both carry the eligible nudge",
				).toStrictEqual([1, 3]);
				await expectCancellationAtLastAttempt(host);
			},
			{ settings: { retry: { enabled: true, baseDelayMs: 0 } } },
		));

	it("a run that ends in threshold compaction counts one required-handoff attempt", async (t) =>
		withRealHost(
			t,
			async (host) => {
				// The nudged second call replies with usage above the threshold, so pi compacts after the run.
				// The run has one pass, so this does not tell agent_end from agent_settled counting; it fails
				// when counting reads context usage at settle, which the compaction has left unknown.
				const overThreshold = PROBE_CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS + 1;
				await host.arm([
					{ name: "e2e_noop", arguments: {} },
					{ text: "ack", inputTokens: overThreshold },
				]);
				const mark = host.events.length;
				await host.turn("/handoff finish the report", 1);

				const handoffRun = host.events.slice(mark);
				const compactions = eventsOfType(handoffRun, "compaction_end");
				expect(compactions, "one compaction").toHaveLength(1);
				expect(compactions[0].reason, "the compaction is pi's threshold compaction").toBe("threshold");
				expect(eventsOfType(handoffRun, "agent_end"), "the run has one pass").toHaveLength(1);
				const nudged = host.probeLog().filter((record): record is RequestRecord => record.kind === "request" && containsText(record, ELIGIBLE_HANDOFF_NUDGE));
				expect(
					nudged.map((record) => record.step),
					"the second call carries the eligible nudge",
				).toStrictEqual([1]);
				const { contextUsage } = await host.client.getSessionStats();
				assertPresent(contextUsage, "pi reports context usage");
				expect(contextUsage.tokens, "usage is unknown once the run has settled").toBeNull();
				await expectCancellationAtLastAttempt(host);
			},
			{ settings: { compaction: { enabled: true, reserveTokens: COMPACTION_RESERVE_TOKENS } } },
		));

	it.skipIf(!canUseOsSandbox())("readonly sandboxed bash write outside temp fails with the readonly block notice", async (t) => {
		// The harness HOME and project live under the OS temp dir, which the sandbox lets writes into,
		// so the target sits under the real home directory of the test process instead. The name is
		// fixed: the write never lands while the sandbox works, so concurrent runs cannot collide on it.
		const target = join(os.homedir(), ".pi-schematic-e2e-readonly-write-probe");
		rmSync(target, { force: true });
		t.onTestFinished(() => {
			rmSync(target, { force: true });
		});
		return withRealHost(t, async (host) => {
			const script = `require("fs").writeFileSync(${JSON.stringify(target)}, "x")`;
			await host.command("/readonly");
			await host.script([{ name: "bash", arguments: { command: `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(script)}` } }], 1);

			const { entries } = await host.entries();
			const bash = onlyResult(toolResults(entries, "bash"), "bash");
			expect(bash.isError, "the write fails").toBe(true);
			expectSuffix(bash.text, SANDBOX_BLOCK_NOTICE);
			const probed = onlyResult(
				host.probeLog().filter((record) => record.kind === "bashResult"),
				"probed bash",
			);
			assertPresent(probed.structuredOutput);
			expectSuffix(probed.structuredOutput, SANDBOX_BLOCK_NOTICE);
			expect(existsSync(target), "the sandbox blocked the write").toBe(false);
		});
	});
});
