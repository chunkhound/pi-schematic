/**
 * Real-host E2E tests: pi-schematic inside the real pi CLI in RPC mode, driven
 * through `RpcClient` with the scripted probe provider. The turn_end boundary,
 * follow-up handling, compaction, branch lineage and tree navigation are pi's own.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { RpcClient, type CompactionEntry, type CustomMessageEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
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
} from "../../handoff/format.js";
import {
	READONLY_ACTIVE_SUMMARY,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
	READONLY_SANDBOX_BLOCK_NOTICE,
	READONLY_WRITE_EDIT_BLOCK_REASON,
} from "../../notifications.js";
import { canUseOsSandbox, quoteShellArgument } from "../../os-sandbox.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { buildNudge, MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import { assertPresent } from "../assertions.js";
import {
	messageText,
	projectStatuses,
	RealHost,
	REAL_HOST_TEST_TIMEOUT_MS,
	SCHEMATIC_ENTRY,
	toolResults,
	withRealHost,
	type RpcEvent,
} from "./real-host.js";
import {
	CHILD_EMPTY_REPLY_MARKER,
	CHILD_REPLY_TEXT,
	NEXT_INSTRUCTION_PREFIX,
	PROBE_COMMAND,
	PROBE_CONTEXT_WINDOW,
	cutHandoffId,
	type ProbeRecord,
	type ScriptedCall,
} from "./real-host-protocol.js";

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

/** Request records logged after the probe saw the kept cut of `handoffId` in its turn_end. */
function requestsAfterCut(log: ProbeRecord[], handoffId: string): RequestRecord[] {
	const index = log.findIndex((record) => record.kind === "cut" && record.handoffId === handoffId && !record.dropped);
	expect(index, `cut record for ${handoffId}`).not.toBe(-1);
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
	assertPresent(record, `request record for step ${step} of ${JSON.stringify(calls)}`);
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
	const handoffStatuses = host.statuses.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
	expect(handoffStatuses.map((status) => status.statusText), "the handoff required status was shown").toContain(HANDOFF_REQUIRED_STATUS);
	expect(handoffStatuses.at(-1)?.statusText, "the handoff status is cleared").toBeUndefined();
}

function onlyResult<T>(results: T[], label: string): T {
	expect(results, `exactly one ${label} result`).toHaveLength(1);
	return results[0];
}

/**
 * A context for driving `withRealHost` by hand: `abort` stands in for a Vitest timeout, and
 * `finish` runs the collected finish callbacks newest first, as Vitest does, and returns what
 * each of them threw; later calls return that first outcome and run nothing. `finish` is also
 * registered on `vitest`, the test's own context, so the host closes even when the test fails
 * before its own call.
 */
function handBuiltContext(vitest: TestContext): {
	t: TestContext;
	abort: (reason: Error) => void;
	registered: () => number;
	finish: () => Promise<unknown[]>;
} {
	const controller = new AbortController();
	const callbacks: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
	const context: Pick<TestContext, "signal" | "onTestFinished"> = {
		signal: controller.signal,
		onTestFinished: (fn) => {
			callbacks.push(fn);
		},
	};
	const t = context as TestContext;
	let finished: Promise<unknown[]> | undefined;
	const finish = () => finished ??= (async () => {
		const errors: unknown[] = [];
		for (const callback of [...callbacks].reverse()) {
			try {
				await callback(t);
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	})();
	vitest.onTestFinished(async () => {
		await finish();
	});
	return { t, abort: (reason) => controller.abort(reason), registered: () => callbacks.length, finish };
}

/** The CLI process of every host started from here on, taken when `RealHost.start` returns it; `RpcClient` keeps it private. */
function captureHostChildren(): ChildProcess[] {
	const children: ChildProcess[] = [];
	const start = RealHost.start.bind(RealHost);
	vi.spyOn(RealHost, "start").mockImplementation(async (options) => {
		const host = await start(options);
		const child = (host.client as unknown as { process: ChildProcess | null }).process;
		assertPresent(child, "the started host has a CLI process");
		children.push(child);
		return host;
	});
	return children;
}

/** Asserts that exactly one host started and that its CLI process has exited. */
function expectOneExitedChild(children: ChildProcess[]): void {
	expect(children.map((child) => child.exitCode !== null || child.signalCode !== null), "one host started and its CLI exited").toStrictEqual([true]);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("pi-schematic real-host E2E", { timeout: REAL_HOST_TEST_TIMEOUT_MS }, () => {
	it("host starts and extension registers", async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.tools);
		await host.settle(0);
		const tools = host.probeLog().filter((record) => record.kind === "tools");
		expect(tools, "one tools record").toHaveLength(1);
		for (const name of ["notebook_write", "notebook_read", "notebook_index", "notebook_topic_set", "handoff", "spawn"]) {
			expect(tools[0].names, `${name} tool registered`).toContain(name);
		}
	}));

	it("commands are registered", async (t) => withRealHost(t, async (host) => {
		const commands = await host.client.getCommands();
		const names = commands
			.filter((command) => command.source === "extension" && resolve(command.sourceInfo.path) === SCHEMATIC_ENTRY)
			.map((command) => command.name)
			.sort();
		expect(names).toStrictEqual(["handoff", "model-groups", "notebook", "readonly"]);
	}));

	it("spawn adds the child's usage to the parent's session stats", async (t) => withRealHost(t, async (host) => {
		await host.script([
			{ name: "spawn", arguments: { prompt: "child task" } },
			{ text: "done", inputTokens: 50000 },
		], 1);
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

	it("a spawn that fails after its child ran still adds the child's usage to the parent's session stats", async (t) => withRealHost(t, async (host) => {
		await host.script([
			{ name: "spawn", arguments: { prompt: `child task ${CHILD_EMPTY_REPLY_MARKER}` } },
			{ text: "done", inputTokens: 50000 },
		], 1);
		const { entries } = await host.entries();
		const spawn = onlyResult(toolResults(entries, "spawn"), "spawn");
		expect(spawn).toMatchObject({ isError: true, text: "Child agent produced no output." });

		const stats = await host.client.getSessionStats();
		// Two parent assistant messages report 50000 input tokens each; the child's one empty
		// reply reports 1234 input, 56 output, 7 cache-read and 8 cache-write tokens at a cost of 0.9375.
		expect({ ...stats.tokens, cost: stats.cost }).toStrictEqual({ input: 101234, output: 56, cacheRead: 7, cacheWrite: 8, total: 101305, cost: 0.9375 });
	}));

	it("notebook write/read round-trip", async (t) => withRealHost(t, async (host) => {
		await host.script([
			{ name: "notebook_write", arguments: { name: "my-page", content: "Hello World" } },
			{ name: "notebook_read", arguments: { name: "my-page" } },
		], 1);
		const { entries } = await host.entries();
		const write = onlyResult(toolResults(entries, "notebook_write"), "notebook_write");
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		expect(write.isError).toBe(false);
		expect(write.text.slice(0, "Saved notebook page".length), write.text).toBe("Saved notebook page");
		expect(read.isError).toBe(false);
		expect(read.text.slice(0, "--- my-page ---".length), read.text).toBe("--- my-page ---");
		expect(read.text, "content persisted").toContain("Hello World");
	}));

	it("notebook index reflects written pages", async (t) => withRealHost(t, async (host) => {
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
		expect(indexes, "two notebook_index results").toHaveLength(2);
		expect(indexes[0].text, "page-a in first index").toContain("page-a");
		expect(indexes[1].text, "page-a in second index").toContain("page-a");
		expect(indexes[1].text, "page-b in second index").toContain("page-b");
	}));

	it("notebook_write overwrites existing page", async (t) => withRealHost(t, async (host) => {
		await host.script([
			{ name: "notebook_write", arguments: { name: "page", content: "v1" } },
			{ name: "notebook_write", arguments: { name: "page", content: "v2" } },
			{ name: "notebook_read", arguments: { name: "page" } },
		], 1);
		const { entries } = await host.entries();
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		expect(read.text, "overwritten content present").toContain("v2");
		expect(read.text, "old content absent").not.toContain("v1");
	}));

	it("notebook topic lifecycle: set via command, agent-set blocked", async (t) => withRealHost(t, async (host) => {
		await host.command("/notebook my-e2e-topic");
		await host.script([{ name: "notebook_topic_set", arguments: { topic: "agent-topic" } }], 1);
		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "notebook_topic_set"), "notebook_topic_set");
		expect(result.isError).toBe(true);
		expect(result.text).toContain("authoritative");
	}));

	it("agent-set topic works when unset", async (t) => withRealHost(t, async (host) => {
		await host.script([{ name: "notebook_topic_set", arguments: { topic: "fresh-agent-topic" } }], 1);
		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "notebook_topic_set"), "notebook_topic_set");
		expect(result.text.slice(0, "Active notebook topic:".length), result.text).toBe("Active notebook topic:");
		expect(result.text).toContain("fresh-agent-topic");
	}));

	it("handoff tool rejects a missing instruction", async (t) => withRealHost(t, async (host) => {
		await handoff(host, { context: "situational only" }, 1);
		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "handoff"), "handoff");
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Empty handoff nextInstruction rejected");
		expect(entries.filter((entry) => userText(entry)?.includes("Handoff failed")), "no failure follow-up user message").toHaveLength(0);
		expect(customMessages(entries, HANDOFF_FAILED_CUSTOM_TYPE), "no failure message").toHaveLength(0);
	}));

	it("handoff writes the cut, the successor and the note as one boundary and re-announces readonly in the successor turn", async (t) => withRealHost(t, async (host) => {
		await host.command("/readonly");
		await host.say("start", 1);
		const mark = host.events.length;
		await handoffCommand(host, "continue readonly work", { context: "mid-task state" }, 1);

		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "handoff"), "handoff");
		expect(result.text).toBe(HANDOFF_STAGED_RESULT);
		const cut = onlyHandoffCut(entries);
		expect(cut.firstKeptEntryId, "the cut retains no earlier entry").toBe(cut.id);
		const successor = onlyCustomMessage(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		expect(successor, "the successor is the cut's shown child").toMatchObject({
			parentId: cut.id,
			content: buildNextUserMessage({ nextInstruction: "continue readonly work", context: "mid-task state" }),
			display: true,
		});
		const note = onlyCustomMessage(entries, HANDOFF_NOTE_CUSTOM_TYPE);
		expect(note, "the note follows the successor and is hidden").toMatchObject({ parentId: successor.id, display: false });
		const handoffRun = host.events.slice(mark);
		expect(cutAppendedIndexes(handoffRun), "the cut arrives as one entry_appended event").toHaveLength(1);
		expect(eventsOfType(handoffRun, "compaction_end"), "the cut fires no compaction_end").toHaveLength(0);
		expect(
			requestsAfterCut(host.probeLog(), cutHandoffId(cut)!).filter((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		).toHaveLength(1);
		expect(await host.client.clearQueue()).toStrictEqual({ steering: [], followUp: [] });
	}));

	it("the successor turn continues the handoff run without the pre-cut user turn or handoff result", async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		const mark = host.events.length;
		await handoff(host, payload, 1);

		const handoffRun = host.events.slice(mark);
		expect(eventsOfType(handoffRun, "agent_start"), "the successor turn starts no second pass").toHaveLength(1);
		expect(eventsOfType(handoffRun, "agent_settled"), "the run settles once").toHaveLength(1);
		const cut = onlyHandoffCut((await host.entries()).entries);
		const [successorRequest] = requestsAfterCut(host.probeLog(), cutHandoffId(cut)!);
		assertPresent(successorRequest, "the model is called after the cut");
		expect(successorRequest.texts.filter((text) => text.startsWith(NEXT_INSTRUCTION_PREFIX)), "the successor request carries the successor once").toStrictEqual([buildNextUserMessage(payload)]);
		expect(successorRequest.texts, "the pre-cut user turn is gone from the successor request").not.toContain("go");
		// The probe records only text blocks, so the handoff toolCall block is not in `texts`.
		expect(successorRequest.texts, "the pre-cut handoff result is gone from the successor request").not.toContain(HANDOFF_STAGED_RESULT);
	}));

	it("a handoff sharing its message with another call is refused, the other call runs, and a lone handoff then lands the cut", async (t) => withRealHost(t, async (host) => {
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
		expect(write.isError, "the sibling call ran").toBe(false);
		expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "notebook-entry"), "the notebook entry persisted").toHaveLength(1);
		const handoffResults = toolResults(entries, "handoff");
		expect(handoffResults, "one refused and one landed handoff result").toHaveLength(2);
		const [refused, landed] = handoffResults;
		expect(refused, "the handoff sharing its message is refused as an error naming the not-alone rule").toMatchObject({ isError: true, text: HANDOFF_NOT_ALONE_REFUSAL });
		expect(landed.text, "the run continued to the lone handoff").toBe(HANDOFF_STAGED_RESULT);
		const cut = onlyHandoffCut(entries);
		const handoffResultIndexes = entries.flatMap((entry, index) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "handoff" ? [index] : []);
		const lonePosition = handoffResultIndexes[1];
		const cutIndex = entries.indexOf(cut);
		expect(cutIndex, "the cut follows the lone handoff, not the refused one").toBeGreaterThan(lonePosition);
		onlyCustomMessage(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		expect(customMessages(entries, HANDOFF_FAILED_CUSTOM_TYPE), "the refusal stages nothing, so nothing fails").toHaveLength(0);
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		expect(read.isError, "the page written before the cut can be read after it").toBe(false);
		expect(read.text).toContain("survives the cut");
		const readIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "notebook_read");
		expect(readIndex, "the page is read after the cut").toBeGreaterThan(cutIndex);
	}));

	it("a boundary successor is not re-sent by settle or tree navigation", async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		await handoff(host, payload, 1);
		const before = await host.entries();
		const successor = onlyCustomMessage(before.entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		await host.navigate(firstAssistantAfter(before.entries, successor.id).id, 0);
		await host.turn("/" + PROBE_COMMAND.turn, 1);

		const { entries } = await host.entries();
		expect(customMessages(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE), "one successor entry").toHaveLength(1);
		expect(userEntriesWithText(entries, buildNextUserMessage(payload)), "no successor resent as a user message").toHaveLength(0);
	}));

	it("editing a boundary successor never re-delivers its instruction", async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		await handoff(host, payload, 1);
		const before = await host.entries();
		const cut = onlyHandoffCut(before.entries);
		const successor = onlyCustomMessage(before.entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		await host.navigate(successor.id, 0);

		const { entries, leafId } = await host.entries();
		expect(leafId, "editing the successor moves the leaf to the cut").toBe(cut.id);
		expect(customMessages(entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE), "one successor entry").toHaveLength(1);
		expect(userEntriesWithText(entries, buildNextUserMessage(payload)), "no successor resent as a user message").toHaveLength(0);
	}));

	it("a dropped handoff cut fails in one run without a follow-up and stays retryable", async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.dropNextCut);
		// No run starts for the failure.
		await handoffCommand(host, "retry after failure", { nextInstruction: "retry after failure" }, 1);

		const failed = await host.entries();
		expect(host.cuts().map((cut) => cut.dropped), "the probe dropped the one cut").toStrictEqual([true]);
		expect(handoffCuts(failed.entries), "no handoff cut after the failed call").toHaveLength(0);
		expect(customMessages(failed.entries, HANDOFF_SUCCESSOR_CUSTOM_TYPE), "no successor after the failed call").toHaveLength(0);
		expect(
			notificationsStartingWith(host, `Handoff failed: ${REASON_NOT_PERSISTED}.`),
			"failure notified",
		).toHaveLength(1);
		const failure = onlyCustomMessage(failed.entries, HANDOFF_FAILED_CUSTOM_TYPE);
		expect(failure.content).toBeTypeOf("string");
		const failureText = failure.content as string;
		expect(failureText, "the failure names its reason").toContain(REASON_NOT_PERSISTED);
		expect(failureText, "the failure says the handoff stays required").toContain("The required handoff remains pending");
		expect(failure.display, "the failure is shown").toBe(true);
		expect(userEntriesWithText(failed.entries, failureText), "no follow-up user message").toHaveLength(0);
		const handoffStatuses = host.statuses.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
		expect(handoffStatuses.at(-1)?.statusText, "the handoff stays required").toBe(HANDOFF_REQUIRED_STATUS);

		await handoff(host, { nextInstruction: "retry after failure" }, 1);
		const retried = await host.entries();
		const results = toolResults(retried.entries, "handoff");
		expect(results, "two handoff results").toHaveLength(2);
		expect(results[1].text).toBe(HANDOFF_STAGED_RESULT);
		onlyHandoffCut(retried.entries);
	}));

	for (const variant of [
		{ name: "another extension drops its successor", command: PROBE_COMMAND.dropNextSuccessor },
		{ name: "another extension appends a compaction after it", command: PROBE_COMMAND.compactAfterNextCut },
	]) {
		it(`a cut that lands without its successor in context fails, aborts the run, and a later handoff still lands (${variant.name})`, async (t) => withRealHost(t, async (host) => {
			await host.command("/" + variant.command);
			await handoffCommand(host, "finish the report", { context: "mid-task state" }, 1);

			const failed = await host.entries();
			const cut = onlyHandoffCut(failed.entries);
			const handoffId = cutHandoffId(cut)!;
			expect(requestsAfterCut(host.probeLog(), handoffId), "the run is aborted before the model is called after the cut").toStrictEqual([]);
			const failure = onlyCustomMessage(failed.entries, HANDOFF_FAILED_CUSTOM_TYPE);
			expect(failure.content).toBeTypeOf("string");
			const failureText = failure.content as string;
			expect(failureText, "the failure carries the instruction").toContain("## Next instruction\n\nfinish the report");
			expect(failureText, "the failure carries the context").toContain("mid-task state");
			expect(failure.display, "the failure is shown").toBe(true);
			expect(
				notificationsStartingWith(host, `Handoff failed: ${REASON_SUCCESSOR_NOT_PERSISTED}.`),
				"failure notified",
			).toHaveLength(1);
			expect(notificationsStartingWith(host, "Handoff complete"), "no completion notice").toHaveLength(0);
			const handoffStatuses = host.statuses.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
			expect(handoffStatuses.map((status) => status.statusText), "the handoff in progress status was shown").toContain(HANDOFF_IN_PROGRESS_STATUS);
			expect(handoffStatuses.at(-1)?.statusText, "no handoff stays required").toBeUndefined();

			await handoff(host, { nextInstruction: "later work" }, 1);
			const retried = await host.entries();
			const results = toolResults(retried.entries, "handoff");
			expect(results, "two handoff results").toHaveLength(2);
			expect(results[1].text, "a later handoff is accepted").toBe(HANDOFF_STAGED_RESULT);
			const laterCut = handoffCuts(retried.entries).find((entry) => entry.id !== cut.id);
			assertPresent(laterCut, "the later handoff lands its cut");
			const [laterRequest] = requestsAfterCut(host.probeLog(), cutHandoffId(laterCut)!);
			assertPresent(laterRequest, "the model is called after the later cut");
			expect(laterRequest.texts.filter((text) => text.startsWith(NEXT_INSTRUCTION_PREFIX)), "only the later successor reaches the model").toStrictEqual([buildNextUserMessage({ nextInstruction: "later work" })]);
		}));
	}

	it("a cut whose notebook rewrite another extension dropped reports the discard from the branch and warns", async (t) => withRealHost(t, async (host) => {
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
		expect(successor.details, "the successor details carry no discard report").toStrictEqual({ handoffId: cutHandoffId(cut) });
		expect(notificationsStartingWith(host, "Handoff complete"), "the completion counts follow the branch").toStrictEqual(["Handoff complete. Notebook: 3 pages kept."]);
		expect(
			host.notifications.filter((notification) => notification.notifyType === "warning" && notification.message === "The notebook discard was not persisted (another extension's turn_end handler may have dropped it); still in the notebook: p3."),
			JSON.stringify(host.notifications),
		).toHaveLength(1);
		const read = onlyResult(toolResults(entries, "notebook_read"), "notebook_read");
		expect(read.isError, "the page is still in the notebook after the cut").toBe(false);
		expect(read.text).toContain("page three");
	}));

	it("readonly is re-announced in the run after a handoff whose successor was dropped", async (t) => withRealHost(t, async (host) => {
		await host.command("/readonly");
		await host.say("start", 1);
		await host.command("/" + PROBE_COMMAND.dropNextSuccessor);
		await handoffCommand(host, "continue readonly work", { context: "mid-task state" }, 1);
		await host.turn("/" + PROBE_COMMAND.turn, 1);

		const cut = onlyHandoffCut((await host.entries()).entries);
		const laterRequests = requestsAfterCut(host.probeLog(), cutHandoffId(cut)!);
		expect(laterRequests, "the later run calls the model").toHaveLength(2);
		expect(laterRequests.filter((record) => containsText(record, READONLY_ACTIVE_SUMMARY)), "readonly is re-announced after the failed handoff").toHaveLength(1);
	}));

	it("a handoff aborted before its cut persists the failure without starting a run", async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.abortAfterHandoff);
		await handoff(host, { nextInstruction: "work after the abort" }, 1);

		const { entries } = await host.entries();
		expect(handoffCuts(entries), "no handoff cut after the abort").toHaveLength(0);
		expect(host.cuts(), "no cut reached the turn_end boundary").toStrictEqual([]);
		const failure = onlyCustomMessage(entries, HANDOFF_FAILED_CUSTOM_TYPE);
		expect(failure.content).toBeTypeOf("string");
		const failureText = failure.content as string;
		expect(failureText, "the failure names its reason").toContain(REASON_ABORTED);
		expect(failureText, "the failure says no handoff stays required").toContain("No required handoff remains pending");
		expect(failure.display, "the failure is shown").toBe(true);
		expect(
			notificationsStartingWith(host, `Handoff failed: ${REASON_ABORTED}.`),
			"failure notified",
		).toHaveLength(1);
	}));

	it("a run pi retries counts one required-handoff attempt", async (t) => withRealHost(t, async (host) => {
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
		expect(ends, "the failed pass and its retry each end with agent_end").toHaveLength(2);
		expect(ends[0].willRetry, "pi retries the failed pass").toBe(true);
		expect(eventsOfType(handoffRun, "agent_settled"), "the run settles once").toHaveLength(1);
		const nudged = host.probeLog().filter((record): record is RequestRecord => record.kind === "request" && containsText(record, ELIGIBLE_HANDOFF_NUDGE));
		expect(nudged.map((record) => record.step), "the failed pass and the retry pass both carry the eligible nudge").toStrictEqual([1, 3]);
		await expectCancellationAtLastAttempt(host);
	}, { settings: { retry: { enabled: true, baseDelayMs: 0 } } }));

	it("a run that ends in threshold compaction counts one required-handoff attempt", async (t) => withRealHost(t, async (host) => {
		// The nudged second call replies with usage above the threshold, so pi compacts after the run.
		// The run has one pass, so this does not tell agent_end from agent_settled counting; it fails
		// when counting reads context usage at settle, which the compaction has left unknown.
		const overThreshold = PROBE_CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS + 1;
		await host.arm([{ name: "e2e_noop", arguments: {} }, { text: "ack", inputTokens: overThreshold }]);
		const mark = host.events.length;
		await host.turn("/handoff finish the report", 1);

		const handoffRun = host.events.slice(mark);
		const compactions = eventsOfType(handoffRun, "compaction_end");
		expect(compactions, "one compaction").toHaveLength(1);
		expect(compactions[0].reason, "the compaction is pi's threshold compaction").toBe("threshold");
		expect(eventsOfType(handoffRun, "agent_end"), "the run has one pass").toHaveLength(1);
		const nudged = host.probeLog().filter((record): record is RequestRecord => record.kind === "request" && containsText(record, ELIGIBLE_HANDOFF_NUDGE));
		expect(nudged.map((record) => record.step), "the second call carries the eligible nudge").toStrictEqual([1]);
		const { contextUsage } = await host.client.getSessionStats();
		assertPresent(contextUsage, "pi reports context usage");
		expect(contextUsage.tokens, "usage is unknown once the run has settled").toBeNull();
		await expectCancellationAtLastAttempt(host);
	}, { settings: { compaction: { enabled: true, reserveTokens: COMPACTION_RESERVE_TOKENS } } }));

	it("readonly lifecycle: handoff bypass clears after the cut while readonly persists", async (t) => withRealHost(t, async (host) => {
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
		expect(handoffResults, "two handoff results").toHaveLength(2);
		expect(handoffResults[0].text).toBe(HANDOFF_STAGED_RESULT);
		const cut = onlyHandoffCut(entries);
		expect(
			requestsAfterCut(host.probeLog(), cutHandoffId(cut)!).filter((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		).toHaveLength(1);
		expect(handoffResults[1], "handoff is blocked again after the cut").toMatchObject({ isError: true, text: READONLY_HANDOFF_BLOCK_REASON });
		const write = onlyResult(toolResults(entries, "write"), "write");
		expect(write, "write stays blocked").toMatchObject({ isError: true, text: READONLY_WRITE_EDIT_BLOCK_REASON });
		expect(existsSync(blocked), "blocked write left no file").toBe(false);
	}));

	it.skipIf(!canUseOsSandbox())("readonly sandboxed bash write outside temp fails with the readonly block notice", async (t) => {
		// The harness HOME and project live under the OS temp dir, which the sandbox lets writes into,
		// so the target sits under the real home directory of the test process instead.
		const target = join(os.homedir(), `pi-schematic-e2e-readonly-${process.pid}-${Date.now()}`);
		t.onTestFinished(() => rmSync(target, { force: true }));
		return withRealHost(t, async (host) => {
			const script = `require("fs").writeFileSync(${JSON.stringify(target)}, "x")`;
			await host.command("/readonly");
			await host.script([{ name: "bash", arguments: { command: `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(script)}` } }], 1);

			const { entries } = await host.entries();
			const bash = onlyResult(toolResults(entries, "bash"), "bash");
			expect(bash.isError, "the write fails").toBe(true);
			expect(bash.text.slice(-READONLY_SANDBOX_BLOCK_NOTICE.length), bash.text).toBe(READONLY_SANDBOX_BLOCK_NOTICE);
			const probed = onlyResult(host.probeLog().filter((record) => record.kind === "bashResult"), "probed bash");
			expect(probed.structuredOutput?.slice(-READONLY_SANDBOX_BLOCK_NOTICE.length), String(probed.structuredOutput)).toBe(READONLY_SANDBOX_BLOCK_NOTICE);
			expect(existsSync(target), "the sandbox blocked the write").toBe(false);
		});
	});

	it("readonly topic boundary enables the handoff bypass on the next context hook", async (t) => withRealHost(t, async (host) => {
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
		expect(
			scriptedRequest(log, boundaryCall, 0).texts.filter((text) => text.includes(READONLY_HANDOFF_EXCEPTION_SUMMARY)),
			"boundary bypass announced before the handoff call",
		).toHaveLength(1);
		const handoffStatuses = projectStatuses(throughHandoff)
			.filter((status) => status.statusKey === STATUS_KEY_HANDOFF)
			.map((status) => status.statusText);
		const required = handoffStatuses.indexOf(HANDOFF_REQUIRED_STATUS);
		expect(required, "handoff required status shown").not.toBe(-1);
		expect(handoffStatuses.indexOf(HANDOFF_IN_PROGRESS_STATUS, required + 1), "handoff in progress status follows").not.toBe(-1);
		const cutsAppended = cutAppendedIndexes(throughHandoff);
		expect(cutsAppended, "one cut appended during the handoff run").toHaveLength(1);
		const statusesAfterCut = projectStatuses(throughHandoff.slice(cutsAppended[0] + 1))
			.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
		expect(statusesAfterCut, "one handoff status follows the cut and clears it").toStrictEqual([{ statusKey: STATUS_KEY_HANDOFF, statusText: undefined }]);
		expect(
			host.notifications.map((notification) => notification.message).filter((message) => message.includes("Readonly topic boundary detected")),
			"boundary promotion notified",
		).toHaveLength(1);

		const { entries } = await host.entries();
		const handoffResults = toolResults(entries, "handoff");
		expect(handoffResults, "two handoff results").toHaveLength(2);
		expect(handoffResults[0].text).toBe(HANDOFF_STAGED_RESULT);
		const cut = onlyHandoffCut(entries);
		expect(
			requestsAfterCut(log, cutHandoffId(cut)!).filter((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		).toHaveLength(1);
		expect(handoffResults[1], "handoff is blocked again after the cut").toMatchObject({ isError: true, text: READONLY_HANDOFF_BLOCK_REASON });
	}));

	describe("withRealHost closes its host from the finish callback", () => {
		it("after a timeout in the body, the body settles against the live host before the host closes once", async (vitest) => {
			const children = captureHostChildren();
			const stop = vi.spyOn(RpcClient.prototype, "stop");
			const close = RealHost.prototype.close;
			let bodySettled = false;
			const bodySettledAtClose: boolean[] = [];
			vi.spyOn(RealHost.prototype, "close").mockImplementation(function (this: RealHost) {
				bodySettledAtClose.push(bodySettled);
				return close.call(this);
			});
			const { t, abort, finish } = handBuiltContext(vitest);
			const entered = deferred();
			const release = deferred();
			// Runs before the registered finish, so a test that fails early does not hold the body.
			vitest.onTestFinished(() => release.resolve());
			const running = withRealHost(t, async (host) => {
				try {
					entered.resolve();
					await release.promise;
					await host.entries();
				} finally {
					bodySettled = true;
				}
			});
			await entered.promise;
			abort(new Error("hand-built timeout"));
			const finishing = finish();
			// Released only after the callbacks have started, so a close that does not wait for the body begins first.
			setTimeout(release.resolve, 0);
			expect(await finishing, "the callbacks threw nothing").toStrictEqual([]);
			await running;
			expect(bodySettledAtClose, "the host closed once, after the body settled").toStrictEqual([true]);
			expect(stop, "the CLI stopped once").toHaveBeenCalledOnce();
			expectOneExitedChild(children);
		});

		it("after a timeout during start, the body never runs and the host closes once", async (vitest) => {
			const children = captureHostChildren();
			const stop = vi.spyOn(RpcClient.prototype, "stop");
			const { t, abort, registered, finish } = handBuiltContext(vitest);
			const reason = new Error("hand-built timeout");
			let bodyRan = false;
			const running = withRealHost(t, async () => {
				bodyRan = true;
			});
			// A callback registered only once start settled would never run after a real timeout during start.
			expect(registered(), "the finish callback is registered before start settles").toBe(1);
			abort(reason);
			await expect(running, "withRealHost rejects with the abort reason").rejects.toBe(reason);
			expect(bodyRan, "the body never ran").toBe(false);
			expect(await finish(), "the callbacks threw nothing").toStrictEqual([]);
			expect(stop, "the host closed once").toHaveBeenCalledOnce();
			expectOneExitedChild(children);
		});

		it("a close error after a passing body is thrown from the finish callback once", async (vitest) => {
			const children = captureHostChildren();
			const stop = vi.spyOn(RpcClient.prototype, "stop");
			const close = RealHost.prototype.close;
			const closeError = new Error("hand-built close failure");
			vi.spyOn(RealHost.prototype, "close").mockImplementation(async function (this: RealHost) {
				await close.call(this);
				throw closeError;
			});
			const { t, finish } = handBuiltContext(vitest);
			await withRealHost(t, async () => {});
			expect(await finish(), "the close error, once").toStrictEqual([closeError]);
			expect(stop, "the host closed once").toHaveBeenCalledOnce();
			expectOneExitedChild(children);
		});
	});
});
