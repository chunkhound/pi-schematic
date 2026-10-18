/**
 * Real-host E2E tests: pi-schematic inside the real pi CLI in RPC mode, driven
 * through `RpcClient` with the scripted probe provider. The turn_end boundary,
 * follow-up handling, compaction, branch lineage and tree navigation are pi's own.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CompactionEntry, CustomMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	HANDOFF_IN_PROGRESS_STATUS,
	HANDOFF_REQUIRED_STATUS,
	HANDOFF_NOT_ALONE_REFUSAL,
	HANDOFF_STAGED_RESULT,
	REASON_ABORTED,
	REASON_NOT_PERSISTED,
	REASON_SUCCESSOR_NOT_PERSISTED,
} from "../../handoff/copy.js";
import {
	HANDOFF_FAILED_CUSTOM_TYPE,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SUCCESSOR_CUSTOM_TYPE,
	buildNextUserMessage,
	formatHandoffFailure,
	formatLostSuccessorFailure,
} from "../../handoff/format.js";
import {
	READONLY_ACTIVE_SUMMARY,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
	READONLY_WRITE_EDIT_BLOCK_REASON,
} from "../../notifications.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { buildNudge, MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import {
	messageText,
	projectStatuses,
	REAL_HOST_TEST_TIMEOUT_MS,
	SCHEMATIC_ENTRY,
	toolResults,
	withRealHost,
	type RealHost,
	type RpcEvent,
} from "./real-host.js";
import {
	NEXT_INSTRUCTION_PREFIX,
	PROBE_COMMAND,
	PROBE_CONTEXT_WINDOW,
	cutHandoffId,
	type ProbeRecord,
	type ScriptedCall,
} from "./real-host-protocol.js";

const TEST_OPTIONS = { timeout: REAL_HOST_TEST_TIMEOUT_MS };

type RequestRecord = Extract<ProbeRecord, { kind: "request" }>;

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
	if (entry.type !== "message" || entry.message.role !== "user") return null;
	return messageText(entry.message.content);
}

function handoffCuts(entries: SessionEntry[]): CompactionEntry[] {
	return entries.filter((entry): entry is CompactionEntry => cutHandoffId(entry) !== null);
}

function onlyHandoffCut(entries: SessionEntry[]): CompactionEntry {
	const cuts = handoffCuts(entries);
	assert.equal(cuts.length, 1, "exactly one handoff cut entry");
	return cuts[0];
}

function customMessages(entries: SessionEntry[], customType: string): CustomMessageEntry[] {
	return entries.filter((entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === customType);
}

function onlyCustomMessage(entries: SessionEntry[], customType: string): CustomMessageEntry {
	const messages = customMessages(entries, customType);
	assert.equal(messages.length, 1, `exactly one ${customType} entry`);
	return messages[0];
}

function userEntriesWithText(entries: SessionEntry[], text: string): SessionEntry[] {
	return entries.filter((entry) => userText(entry) === text);
}

function firstAssistantAfter(entries: SessionEntry[], entryId: string): SessionEntry {
	const index = entries.findIndex((entry) => entry.id === entryId);
	assert.notEqual(index, -1, `entry ${entryId} exists`);
	const assistant = entries.slice(index + 1).find((entry) => entry.type === "message" && entry.message.role === "assistant");
	assert.ok(assistant, `an assistant entry follows ${entryId}`);
	return assistant;
}

/** Request records logged after the probe saw the kept cut of `handoffId` in its turn_end. */
function requestsAfterCut(log: ProbeRecord[], handoffId: string): RequestRecord[] {
	const index = log.findIndex((record) => record.kind === "cut" && record.handoffId === handoffId && !record.dropped);
	assert.notEqual(index, -1, `cut record for ${handoffId}`);
	return log.slice(index + 1).filter((record): record is RequestRecord => record.kind === "request");
}

/** Indexes of the `entry_appended` events in `events` that carry a handoff cut. */
function cutAppendedIndexes(events: RpcEvent[]): number[] {
	return events.flatMap((event, index) =>
		event.type === "entry_appended" && cutHandoffId(event.entry as SessionEntry) !== null ? [index] : []
	);
}

/** The first request record whose script deep-equals `calls` at step `step`. */
function scriptedRequest(log: ProbeRecord[], calls: ScriptedCall[], step: number): RequestRecord {
	const record = log.find((entry): entry is RequestRecord =>
		entry.kind === "request" && entry.step === step && JSON.stringify(entry.calls) === JSON.stringify(calls)
	);
	assert.ok(record, `request record for step ${step} of ${JSON.stringify(calls)}`);
	return record;
}

function containsText(record: RequestRecord, text: string): boolean {
	return record.texts.some((candidate) => candidate.includes(text));
}

/** First line of the watchdog nudge that tells the model to hand off now, read off the production builder. */
const ELIGIBLE_HANDOFF_NUDGE = buildNudge({
	activeNotebookTopic: null,
	pendingTopicBoundaryHint: null,
	readonlyEnabled: false,
	pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: "x" },
}, null, true).split("\n")[0];

/** Threshold compaction reserve: pi compacts once a reply reports more than the window minus this. */
const COMPACTION_RESERVE_TOKENS = PROBE_CONTEXT_WINDOW / 2;

function eventsOfType(events: RpcEvent[], type: string): RpcEvent[] {
	return events.filter((event) => event.type === type);
}

/** Notices of a required handoff the watchdog cancelled. */
function handoffCancellations(host: RealHost): string[] {
	return host.notifications
		.filter((notification) => notification.message.startsWith("Required handoff cancelled"))
		.map((notification) => notification.message);
}

/**
 * After a `/handoff` run that counted one attempt: the next MAX_HANDOFF_ATTEMPTS - 2 runs, each
 * nudged and counted once, leave the handoff required, and the run after them cancels it.
 */
async function expectCancellationAtLastAttempt(host: RealHost): Promise<void> {
	const middleRuns = MAX_HANDOFF_ATTEMPTS - 2;
	await host.turn(`/${PROBE_COMMAND.turn} ${middleRuns}`, middleRuns);
	assert.deepEqual(handoffCancellations(host), [], `the handoff stays required after ${MAX_HANDOFF_ATTEMPTS - 1} settled runs`);
	await host.turn("/" + PROBE_COMMAND.turn, 1);
	assert.equal(handoffCancellations(host).length, 1, `settled run ${MAX_HANDOFF_ATTEMPTS} cancels the handoff`);
	const handoffStatuses = host.statuses.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
	assert.equal(handoffStatuses.at(-1)?.statusText, undefined, "the handoff status is cleared");
}

function onlyResult<T>(results: T[], label: string): T {
	assert.equal(results.length, 1, `exactly one ${label} result`);
	return results[0];
}

describe("pi-schematic real-host E2E", () => {
	it("host starts and extension registers", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.tools);
		await host.settle(0);
		const tools = host.probeLog().filter((record) => record.kind === "tools");
		assert.equal(tools.length, 1, "one tools record");
		for (const name of ["notebook_write", "notebook_read", "notebook_index", "notebook_topic_set", "handoff", "spawn"]) {
			assert.ok(tools[0].names.includes(name), `${name} tool registered`);
		}
	}));

	it("commands are registered", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const commands = await host.client.getCommands();
		const names = commands
			.filter((command) => command.source === "extension" && resolve(command.sourceInfo.path) === SCHEMATIC_ENTRY)
			.map((command) => command.name)
			.sort();
		assert.deepEqual(names, ["handoff", "model-groups", "notebook", "readonly"]);
	}));

	it("notebook write/read round-trip", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.script([
			{ name: "notebook_write", arguments: { name: "my-page", content: "Hello World" } },
			{ name: "notebook_read", arguments: { name: "my-page" } },
		], 1);
		const { entries } = await host.entries();
		const write = onlyResult(toolResults(entries, "notebook_write"), "notebook_write");
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		assert.equal(write.isError, false);
		assert.ok(write.text.startsWith("Saved notebook page"), write.text);
		assert.equal(read.isError, false);
		assert.ok(read.text.startsWith("--- my-page ---"), read.text);
		assert.ok(read.text.includes("Hello World"), "content persisted");
	}));

	it("notebook index reflects written pages", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.script([
			{ name: "notebook_write", arguments: { name: "page-a", content: "Page A" } },
			{ name: "notebook_index", arguments: {} },
		], 1);
		await host.script([
			{ name: "notebook_write", arguments: { name: "page-b", content: "Page B" } },
			{ name: "notebook_index", arguments: {} },
		], 1);
		const { entries } = await host.entries();
		const indexes = toolResults(entries, "notebook_index");
		assert.equal(indexes.length, 2, "two notebook_index results");
		assert.ok(indexes[0].text.includes("page-a"), "page-a in first index");
		assert.ok(indexes[1].text.includes("page-a"), "page-a in second index");
		assert.ok(indexes[1].text.includes("page-b"), "page-b in second index");
	}));

	it("notebook_write overwrites existing page", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.script([
			{ name: "notebook_write", arguments: { name: "page", content: "v1" } },
			{ name: "notebook_write", arguments: { name: "page", content: "v2" } },
			{ name: "notebook_read", arguments: { name: "page" } },
		], 1);
		const { entries } = await host.entries();
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		assert.ok(read.text.includes("v2"), "overwritten content present");
		assert.ok(!read.text.includes("v1"), "old content absent");
	}));

	it("notebook topic lifecycle: set via command, agent-set blocked", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/notebook my-e2e-topic");
		await host.script([{ name: "notebook_topic_set", arguments: { topic: "agent-topic" } }], 1);
		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "notebook_topic_set"), "notebook_topic_set");
		assert.equal(result.isError, true);
		assert.ok(result.text.includes("authoritative"), result.text);
	}));

	it("agent-set topic works when unset", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.script([{ name: "notebook_topic_set", arguments: { topic: "fresh-agent-topic" } }], 1);
		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "notebook_topic_set"), "notebook_topic_set");
		assert.ok(result.text.startsWith("Active notebook topic:"), result.text);
		assert.ok(result.text.includes("fresh-agent-topic"), result.text);
	}));

	it("handoff tool rejects a missing instruction", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await handoff(host, { context: "situational only" }, 1);
		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "handoff"), "handoff");
		assert.equal(result.isError, true);
		assert.ok(result.text.includes("Empty handoff nextInstruction rejected"), result.text);
		assert.equal(entries.filter((entry) => userText(entry)?.includes("Handoff failed")).length, 0, "no failure follow-up user message");
		assert.equal(customMessages(entries, HANDOFF_FAILED_CUSTOM_TYPE).length, 0, "no failure message");
	}));

	it("handoff writes the cut, the successor and the note as one boundary and re-announces readonly in the successor turn", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/readonly");
		await host.say("start", 1);
		const mark = host.events.length;
		await handoffCommand(host, "continue readonly work", { context: "mid-task state" }, 1);

		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "handoff"), "handoff");
		assert.equal(result.text, HANDOFF_STAGED_RESULT);
		const cut = onlyHandoffCut(entries);
		assert.equal(cut.firstKeptEntryId, cut.id, "the cut retains no earlier entry");
		const successor = onlyCustomMessage(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		assert.equal(successor.parentId, cut.id, "the successor is the cut's child");
		assert.equal(successor.content, buildNextUserMessage({ nextInstruction: "continue readonly work", context: "mid-task state" }));
		assert.equal(successor.display, true, "the successor is shown");
		const note = onlyCustomMessage(entries, HANDOFF_NOTE_CUSTOM_TYPE);
		assert.equal(note.parentId, successor.id, "the note follows the successor");
		assert.equal(note.display, false, "the note is hidden");
		const handoffRun = host.events.slice(mark);
		assert.equal(cutAppendedIndexes(handoffRun).length, 1, "the cut arrives as one entry_appended event");
		assert.equal(eventsOfType(handoffRun, "compaction_end").length, 0, "the cut fires no compaction_end");
		assert.ok(
			requestsAfterCut(host.probeLog(), cutHandoffId(cut)!).some((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		);
		assert.deepEqual(await host.client.clearQueue(), { steering: [], followUp: [] });
	}));

	it("the successor turn continues the handoff run without the pre-cut user turn or handoff result", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		const mark = host.events.length;
		await handoff(host, payload, 1);

		const handoffRun = host.events.slice(mark);
		assert.equal(eventsOfType(handoffRun, "agent_start").length, 1, "the successor turn starts no second pass");
		assert.equal(eventsOfType(handoffRun, "agent_settled").length, 1, "the run settles once");
		const cut = onlyHandoffCut((await host.entries()).entries);
		const [successorRequest] = requestsAfterCut(host.probeLog(), cutHandoffId(cut)!);
		assert.ok(successorRequest, "the model is called after the cut");
		assert.deepEqual(
			successorRequest.texts.filter((text) => text.startsWith(NEXT_INSTRUCTION_PREFIX)),
			[buildNextUserMessage(payload)],
			"the successor request carries the successor once",
		);
		assert.equal(successorRequest.texts.includes("go"), false, "the pre-cut user turn is gone from the successor request");
		// The probe records only text blocks, so the handoff toolCall block is not in `texts`.
		assert.equal(successorRequest.texts.includes(HANDOFF_STAGED_RESULT), false, "the pre-cut handoff result is gone from the successor request");
	}));

	it("a handoff sharing its message with another call is refused, the other call runs, and a lone handoff then lands the cut", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.script([
			{
				calls: [
					{ name: "notebook_write", arguments: { name: "kept-page", content: "survives the cut" } },
					{ name: "handoff", arguments: { nextInstruction: "continue alone" } },
				],
			},
			{ name: "handoff", arguments: { nextInstruction: "continue alone" } },
			{ name: "notebook_read", arguments: { name: "kept-page" } },
		], 1);

		const { entries } = await host.entries();
		const write = onlyResult(toolResults(entries, "notebook_write"), "notebook_write");
		assert.equal(write.isError, false, "the sibling call ran");
		assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "notebook-entry").length, 1, "the notebook entry persisted");
		const handoffResults = toolResults(entries, "handoff");
		assert.equal(handoffResults.length, 2, "one refused and one landed handoff result");
		const [refused, landed] = handoffResults;
		assert.equal(refused.isError, true, "the handoff sharing its message is refused as an error");
		assert.equal(refused.text, HANDOFF_NOT_ALONE_REFUSAL, "the refusal names the not-alone rule");
		assert.equal(landed.text, HANDOFF_STAGED_RESULT, "the run continued to the lone handoff");
		const cut = onlyHandoffCut(entries);
		const handoffResultIndexes = entries.flatMap((entry, index) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "handoff" ? [index] : []);
		assert.ok(entries.indexOf(cut) > handoffResultIndexes[1], "the cut follows the lone handoff, not the refused one");
		onlyCustomMessage(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		assert.equal(customMessages(entries, HANDOFF_FAILED_CUSTOM_TYPE).length, 0, "the refusal stages nothing, so nothing fails");
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		assert.equal(read.isError, false, "the page written before the cut can be read after it");
		assert.ok(read.text.includes("survives the cut"), read.text);
		const readIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notebook_read");
		assert.ok(readIndex > entries.indexOf(cut), "the page is read after the cut");
	}));

	it("a boundary successor is not re-sent by settle or tree navigation", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		await handoff(host, payload, 1);
		const before = await host.entries();
		const successor = onlyCustomMessage(before.entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		await host.navigate(firstAssistantAfter(before.entries, successor.id).id, 0);
		await host.turn("/" + PROBE_COMMAND.turn, 1);

		const { entries } = await host.entries();
		assert.equal(customMessages(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE).length, 1, "one successor entry");
		assert.equal(userEntriesWithText(entries, buildNextUserMessage(payload)).length, 0, "no successor resent as a user message");
	}));

	it("editing a boundary successor never re-delivers its instruction", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		await handoff(host, payload, 1);
		const before = await host.entries();
		const cut = onlyHandoffCut(before.entries);
		const successor = onlyCustomMessage(before.entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		await host.navigate(successor.id, 0);

		const { entries, leafId } = await host.entries();
		assert.equal(leafId, cut.id, "editing the successor moves the leaf to the cut");
		assert.equal(customMessages(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE).length, 1, "one successor entry");
		assert.equal(userEntriesWithText(entries, buildNextUserMessage(payload)).length, 0, "no successor resent as a user message");
	}));

	it("a dropped handoff cut fails in one run without a follow-up and stays retryable", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.dropNextCut);
		// No run starts for the failure.
		await handoffCommand(host, "retry after failure", { nextInstruction: "retry after failure" }, 1);

		const failed = await host.entries();
		assert.deepEqual(host.cuts().map((cut) => cut.dropped), [true], "the probe dropped the one cut");
		assert.equal(handoffCuts(failed.entries).length, 0, "no handoff cut after the failed call");
		assert.equal(customMessages(failed.entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE).length, 0, "no successor after the failed call");
		assert.ok(
			host.notifications.some((notification) => notification.message.startsWith(`Handoff failed: ${REASON_NOT_PERSISTED}.`)),
			"failure notified",
		);
		const failure = onlyCustomMessage(failed.entries, HANDOFF_FAILED_CUSTOM_TYPE);
		assert.equal(failure.content, formatHandoffFailure(REASON_NOT_PERSISTED, true));
		assert.equal(failure.display, true, "the failure is shown");
		assert.equal(userEntriesWithText(failed.entries, formatHandoffFailure(REASON_NOT_PERSISTED, true)).length, 0, "no follow-up user message");
		const handoffStatuses = host.statuses.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
		assert.equal(handoffStatuses.at(-1)?.statusText, HANDOFF_REQUIRED_STATUS, "the handoff stays required");

		await handoff(host, { nextInstruction: "retry after failure" }, 1);
		const retried = await host.entries();
		const results = toolResults(retried.entries, "handoff");
		assert.equal(results.length, 2, "two handoff results");
		assert.equal(results[1].text, HANDOFF_STAGED_RESULT);
		onlyHandoffCut(retried.entries);
	}));

	for (const variant of [
		{ name: "another extension drops its successor", command: PROBE_COMMAND.dropNextSuccessor },
		{ name: "another extension appends a compaction after it", command: PROBE_COMMAND.compactAfterNextCut },
	]) {
		it(`a cut that lands without its successor in context fails, aborts the run, and a later handoff still lands (${variant.name})`, TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
			await host.command("/" + variant.command);
			await handoffCommand(host, "finish the report", { context: "mid-task state" }, 1);

			const failed = await host.entries();
			const cut = onlyHandoffCut(failed.entries);
			const handoffId = cutHandoffId(cut)!;
			assert.deepEqual(requestsAfterCut(host.probeLog(), handoffId), [], "the run is aborted before the model is called after the cut");
			const lostSuccessor = buildNextUserMessage({ nextInstruction: "finish the report", context: "mid-task state" });
			const failure = onlyCustomMessage(failed.entries, HANDOFF_FAILED_CUSTOM_TYPE);
			assert.equal(failure.content, formatLostSuccessorFailure(REASON_SUCCESSOR_NOT_PERSISTED, lostSuccessor), "the failure carries the instruction");
			assert.equal(failure.display, true, "the failure is shown");
			assert.ok(
				host.notifications.some((notification) => notification.message.startsWith(`Handoff failed: ${REASON_SUCCESSOR_NOT_PERSISTED}.`)),
				"failure notified",
			);
			assert.ok(!host.notifications.some((notification) => notification.message.startsWith("Handoff complete")), "no completion notice");
			const handoffStatuses = host.statuses.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
			assert.equal(handoffStatuses.at(-1)?.statusText, undefined, "no handoff stays required");

			await handoff(host, { nextInstruction: "later work" }, 1);
			const retried = await host.entries();
			const results = toolResults(retried.entries, "handoff");
			assert.equal(results.length, 2, "two handoff results");
			assert.equal(results[1].text, HANDOFF_STAGED_RESULT, "a later handoff is accepted");
			const laterCut = handoffCuts(retried.entries).find((entry) => entry.id !== cut.id);
			assert.ok(laterCut, "the later handoff lands its cut");
			const [laterRequest] = requestsAfterCut(host.probeLog(), cutHandoffId(laterCut)!);
			assert.ok(laterRequest, "the model is called after the later cut");
			assert.deepEqual(
				laterRequest.texts.filter((text) => text.startsWith(NEXT_INSTRUCTION_PREFIX)),
				[buildNextUserMessage({ nextInstruction: "later work" })],
				"only the later successor reaches the model",
			);
		}));
	}

	it("a cut whose notebook rewrite another extension dropped reports the discard from the branch and warns", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.dropNotebookRewriteAtNextCut);
		await host.script([
			{ name: "notebook_write", arguments: { name: "p1", content: "page one" } },
			{ name: "notebook_write", arguments: { name: "p2", content: "page two" } },
			{ name: "notebook_write", arguments: { name: "p3", content: "page three" } },
			{ name: "handoff", arguments: { nextInstruction: "continue with the pages", discardPages: ["p3"] } },
			{ name: "notebook_read", arguments: { name: "p3" } },
		], 1);

		const { entries } = await host.entries();
		const cut = onlyHandoffCut(entries);
		const successor = onlyCustomMessage(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		assert.deepEqual(successor.details, { handoffId: cutHandoffId(cut) }, "the successor details carry no discard report");
		assert.deepEqual(
			host.notifications.filter((notification) => notification.message.startsWith("Handoff complete")).map((notification) => notification.message),
			["Handoff complete. Notebook: 3 pages kept."],
			"the completion counts follow the branch",
		);
		assert.ok(
			host.notifications.some((notification) => notification.notifyType === "warning" &&
				notification.message === "The notebook discard was not persisted (another extension's turn_end handler may have dropped it); still in the notebook: p3."),
			JSON.stringify(host.notifications),
		);
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		assert.equal(read.isError, false, "the page is still in the notebook after the cut");
		assert.ok(read.text.includes("page three"), read.text);
	}));

	it("readonly is re-announced in the run after a handoff whose successor was dropped", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/readonly");
		await host.say("start", 1);
		await host.command("/" + PROBE_COMMAND.dropNextSuccessor);
		await handoffCommand(host, "continue readonly work", { context: "mid-task state" }, 1);
		await host.turn("/" + PROBE_COMMAND.turn, 1);

		const cut = onlyHandoffCut((await host.entries()).entries);
		const laterRequests = requestsAfterCut(host.probeLog(), cutHandoffId(cut)!);
		assert.ok(laterRequests.length > 0, "the later run calls the model");
		assert.ok(laterRequests.some((record) => containsText(record, READONLY_ACTIVE_SUMMARY)), "readonly is re-announced after the failed handoff");
	}));

	it("a handoff aborted before its cut persists the failure without starting a run", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.abortAfterHandoff);
		await handoff(host, { nextInstruction: "work after the abort" }, 1);

		const { entries } = await host.entries();
		assert.equal(handoffCuts(entries).length, 0, "no handoff cut after the abort");
		assert.deepEqual(host.cuts(), [], "no cut reached the turn_end boundary");
		const failure = onlyCustomMessage(entries, HANDOFF_FAILED_CUSTOM_TYPE);
		assert.equal(failure.content, formatHandoffFailure(REASON_ABORTED, false));
		assert.equal(failure.display, true, "the failure is shown");
		assert.ok(
			host.notifications.some((notification) => notification.message.startsWith(`Handoff failed: ${REASON_ABORTED}.`)),
			"failure notified",
		);
	}));

	it("a run pi retries counts one required-handoff attempt", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		// A tool call reports usage that makes the handoff eligible, so the call after it is nudged. The
		// first nudged call fails with a retryable error and pi retries in the same run. pi omits the
		// failed attempt with a context edit, which leaves usage unknown until the retry pass's own
		// tool call reports it again, so that pass is nudged at its second call.
		await host.arm([
			{ name: "e2e_noop", arguments: {} },
			{ error: "503 Service Unavailable" },
			{ name: "e2e_noop", arguments: {} },
		]);
		const mark = host.events.length;
		await host.turn("/handoff finish the report", 1);

		const handoffRun = host.events.slice(mark);
		const ends = eventsOfType(handoffRun, "agent_end");
		assert.equal(ends.length, 2, "the failed pass and its retry each end with agent_end");
		assert.equal(ends[0].willRetry, true, "pi retries the failed pass");
		assert.equal(eventsOfType(handoffRun, "agent_settled").length, 1, "the run settles once");
		const nudged = host.probeLog().filter((record): record is RequestRecord => record.kind === "request" && containsText(record, ELIGIBLE_HANDOFF_NUDGE));
		assert.deepEqual(nudged.map((record) => record.step), [1, 3], "the failed pass and the retry pass both carry the eligible nudge");
		await expectCancellationAtLastAttempt(host);
	}, { settings: { retry: { enabled: true, baseDelayMs: 0 } } }));

	it("a run that ends in threshold compaction counts one required-handoff attempt", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		// The nudged second call replies with usage above the threshold, so pi compacts after the run.
		// The run has one pass, so this does not tell agent_end from agent_settled counting; it fails
		// when counting reads context usage at settle, which the compaction has left unknown.
		const overThreshold = PROBE_CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS + 1;
		await host.arm([{ name: "e2e_noop", arguments: {} }, { text: "ack", inputTokens: overThreshold }]);
		const mark = host.events.length;
		await host.turn("/handoff finish the report", 1);

		const handoffRun = host.events.slice(mark);
		const compactions = eventsOfType(handoffRun, "compaction_end");
		assert.equal(compactions.length, 1, "one compaction");
		assert.equal(compactions[0].reason, "threshold", "the compaction is pi's threshold compaction");
		assert.equal(eventsOfType(handoffRun, "agent_end").length, 1, "the run has one pass");
		const nudged = host.probeLog().filter((record): record is RequestRecord => record.kind === "request" && containsText(record, ELIGIBLE_HANDOFF_NUDGE));
		assert.deepEqual(nudged.map((record) => record.step), [1], "the second call carries the eligible nudge");
		const { contextUsage } = await host.client.getSessionStats();
		assert.ok(contextUsage, "pi reports context usage");
		assert.equal(contextUsage.tokens, null, "usage is unknown once the run has settled");
		await expectCancellationAtLastAttempt(host);
	}, { settings: { compaction: { enabled: true, reserveTokens: COMPACTION_RESERVE_TOKENS } } }));

	it("readonly lifecycle: handoff bypass clears after the cut while readonly persists", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const blocked = join(host.projectDir, "blocked.txt");
		await host.command("/readonly");
		await host.say("start", 1);
		await handoffCommand(host, "continue readonly work", { nextInstruction: "continue readonly work" }, 1);
		await host.script([
			{ name: "handoff", arguments: { nextInstruction: "direct call" } },
			{ name: "write", arguments: { path: blocked, content: "x" } },
		], 1);

		const { entries } = await host.entries();
		const handoffResults = toolResults(entries, "handoff");
		assert.equal(handoffResults.length, 2, "two handoff results");
		assert.equal(handoffResults[0].text, HANDOFF_STAGED_RESULT);
		const cut = onlyHandoffCut(entries);
		assert.ok(
			requestsAfterCut(host.probeLog(), cutHandoffId(cut)!).some((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		);
		assert.equal(handoffResults[1].isError, true, "handoff is blocked again after the cut");
		assert.equal(handoffResults[1].text, READONLY_HANDOFF_BLOCK_REASON);
		const write = onlyResult(toolResults(entries, "write"), "write");
		assert.equal(write.isError, true, "write stays blocked");
		assert.equal(write.text, READONLY_WRITE_EDIT_BLOCK_REASON);
		assert.equal(existsSync(blocked), false, "blocked write left no file");
	}));

	it("readonly topic boundary enables the handoff bypass on the next context hook", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const boundaryCall = handoffCall({ nextInstruction: "continue billing work" });
		await host.command("/readonly");
		await host.say("start", 1);
		await host.command("/notebook oauth");
		await host.command("/notebook billing");
		await host.script(boundaryCall, 1);
		// Status reads stop here, so events of the later direct-call run cannot satisfy them.
		const throughHandoff = host.events.slice();
		await host.script(handoffCall({ nextInstruction: "direct call" }), 1);

		const log = host.probeLog();
		assert.ok(containsText(scriptedRequest(log, boundaryCall, 0), READONLY_HANDOFF_EXCEPTION_SUMMARY), "boundary bypass announced before the handoff call");
		const handoffStatuses = projectStatuses(throughHandoff)
			.filter((status) => status.statusKey === STATUS_KEY_HANDOFF)
			.map((status) => status.statusText);
		const required = handoffStatuses.indexOf(HANDOFF_REQUIRED_STATUS);
		assert.notEqual(required, -1, "handoff required status shown");
		assert.notEqual(handoffStatuses.indexOf(HANDOFF_IN_PROGRESS_STATUS, required + 1), -1, "handoff in progress status follows");
		const cutsAppended = cutAppendedIndexes(throughHandoff);
		assert.equal(cutsAppended.length, 1, "one cut appended during the handoff run");
		const statusesAfterCut = projectStatuses(throughHandoff.slice(cutsAppended[0] + 1))
			.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
		assert.ok(statusesAfterCut.length > 0, "a handoff status follows the cut");
		assert.equal(statusesAfterCut.at(-1)?.statusText, undefined, "handoff status cleared after the cut");
		assert.ok(host.notifications.some((notification) => notification.message.includes("Readonly topic boundary detected")), "boundary promotion notified");

		const { entries } = await host.entries();
		const handoffResults = toolResults(entries, "handoff");
		assert.equal(handoffResults.length, 2, "two handoff results");
		assert.equal(handoffResults[0].text, HANDOFF_STAGED_RESULT);
		const cut = onlyHandoffCut(entries);
		assert.ok(
			requestsAfterCut(log, cutHandoffId(cut)!).some((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		);
		assert.equal(handoffResults[1].isError, true, "handoff is blocked again after the cut");
		assert.equal(handoffResults[1].text, READONLY_HANDOFF_BLOCK_REASON);
	}));
});
