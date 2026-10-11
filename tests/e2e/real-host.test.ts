/**
 * Real-host E2E tests: pi-schematic inside the real pi CLI in RPC mode, driven
 * through `RpcClient` with the scripted probe provider. Handoff delivery,
 * follow-up handling, compaction, branch lineage and tree navigation are pi's own.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { HANDOFF_IN_PROGRESS_STATUS, HANDOFF_REQUIRED_STATUS } from "../../handoff/copy.js";
import { buildNextUserMessage } from "../../handoff/format.js";
import {
	READONLY_ACTIVE_SUMMARY,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
	READONLY_WRITE_EDIT_BLOCK_REASON,
} from "../../notifications.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import {
	messageText,
	projectStatuses,
	REAL_HOST_TEST_TIMEOUT_MS,
	SCHEMATIC_ENTRY,
	toolResults,
	withRealHost,
	type RealHost,
} from "./real-host.js";
import { PROBE_COMMAND, type ProbeRecord, type ScriptedCall } from "./real-host-protocol.js";

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

function handoffCompactions(entries: SessionEntry[]): SessionEntry[] {
	return entries.filter((entry) =>
		entry.type === "compaction" && (entry.details as { handoff?: unknown } | undefined)?.handoff === true
	);
}

function onlyHandoffCompaction(entries: SessionEntry[]): SessionEntry {
	const compactions = handoffCompactions(entries);
	assert.equal(compactions.length, 1, "exactly one handoff compaction entry");
	return compactions[0];
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

/** Request records logged after the `compact` record of compaction `entryId`. */
function requestsAfterCompaction(log: ProbeRecord[], entryId: string): RequestRecord[] {
	const index = log.findIndex((record) => record.kind === "compact" && record.entryId === entryId);
	assert.notEqual(index, -1, `compact record for ${entryId}`);
	return log.slice(index + 1).filter((record): record is RequestRecord => record.kind === "request");
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
		// The rejection's failure report queues into the same run.
		await handoff(host, { context: "situational only" }, 1);
		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "handoff"), "handoff");
		assert.equal(result.isError, true);
		assert.ok(result.text.includes("Empty handoff nextInstruction rejected"), result.text);
	}));

	it("handoff queues the successor instruction and re-announces readonly in its turn", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/readonly");
		await host.say("start", 1);
		// The handoff run, then the successor's run.
		await handoffCommand(host, "continue readonly work", { context: "mid-task state" }, 2);

		const { entries } = await host.entries();
		const result = onlyResult(toolResults(entries, "handoff"), "handoff");
		assert.ok(result.text.startsWith("Handoff started."), result.text);
		const compaction = onlyHandoffCompaction(entries);
		const successors = userEntriesWithText(entries, buildNextUserMessage({ nextInstruction: "continue readonly work", context: "mid-task state" }));
		assert.equal(successors.length, 1, "exactly one successor user entry");
		assert.equal(successors[0].parentId, compaction.id, "successor is the compaction's child");
		// The delivered text carries both payload parts verbatim, whatever the builder produces.
		const deliveredText = userText(successors[0]);
		assert.ok(deliveredText !== null, "the successor entry has user text");
		assert.ok(deliveredText.includes("continue readonly work"), `successor carries the instruction: ${deliveredText}`);
		assert.ok(deliveredText.includes("mid-task state"), `successor carries the context: ${deliveredText}`);
		assert.ok(
			requestsAfterCompaction(host.probeLog(), compaction.id).some((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		);
		assert.equal(host.events.filter((event) => event.type === "compaction_end").length, 1, "one compaction_end");
		assert.deepEqual(await host.client.clearQueue(), { steering: [], followUp: [] });
	}));

	it("persisted successor is not re-delivered by settle or tree navigation", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		await handoff(host, payload, 2);
		const before = await host.entries();
		const [successor] = userEntriesWithText(before.entries, buildNextUserMessage(payload));
		assert.ok(successor, "successor delivered");
		await host.navigate(firstAssistantAfter(before.entries, successor.id).id, 0);
		await host.turn("/" + PROBE_COMMAND.turn, 1);

		const sends = host.successorSends();
		assert.equal(sends.length, 1, "a persisted successor must be delivered exactly once");
		assert.equal(sends[0].dropped, false);
		const { entries } = await host.entries();
		assert.equal(userEntriesWithText(entries, buildNextUserMessage(payload)).length, 1, "one successor user entry");
	}));

	it("editing a persisted successor never re-delivers its original instruction", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		await handoff(host, payload, 2);
		const before = await host.entries();
		const compaction = onlyHandoffCompaction(before.entries);
		const [successor] = userEntriesWithText(before.entries, buildNextUserMessage(payload));
		assert.ok(successor, "successor delivered");
		await host.navigate(successor.id, 0);

		const { entries, leafId } = await host.entries();
		assert.equal(leafId, compaction.id, "editing the successor moves the leaf to the compaction");
		assert.equal(host.successorSends().length, 1, "editing a successor must not requeue its original instruction");
		assert.equal(userEntriesWithText(entries, buildNextUserMessage(payload)).length, 1, "one successor user entry");
	}));

	it("recovery resends a lost successor and stops once it lands", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const payload = { nextInstruction: "do the resumed work", context: "remaining state" };
		const successorText = buildNextUserMessage(payload);
		await host.command("/" + PROBE_COMMAND.dropNextSuccessor);
		// The dropped successor starts no run.
		await handoff(host, payload, 1);
		// The tick's run, then the run of the successor recovery resends once it settles.
		await host.turn("/" + PROBE_COMMAND.turn, 2);

		const sends = host.successorSends();
		assert.equal(sends.length, 2, "recovery must resend the absent successor");
		assert.equal(sends[0].dropped, true);
		assert.equal(sends[1].dropped, false);
		assert.equal(userEntriesWithText((await host.entries()).entries, successorText).length, 1, "one successor user entry");

		await host.turn("/" + PROBE_COMMAND.turn, 1);
		assert.equal(host.successorSends().length, 2, "a delivered successor must not be re-sent");
	}));

	it("recovery never appends a lost handoff after newer user work", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.dropNextSuccessor);
		await handoff(host, { nextInstruction: "old handoff work" }, 1);
		await host.say("newer user work", 1);

		const sends = host.successorSends();
		assert.equal(sends.length, 1, "recovery must not enqueue superseded work");
		assert.equal(sends[0].dropped, true);
		const { entries } = await host.entries();
		assert.equal(userEntriesWithText(entries, buildNextUserMessage({ nextInstruction: "old handoff work" })).length, 0, "no successor user entry");
	}));

	it("tree navigation never appends a lost handoff after newer user work", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.dropNextSuccessor);
		await handoff(host, { nextInstruction: "old handoff work" }, 1);
		await host.say("newer user work", 1);
		const before = await host.entries();
		const newer = userEntriesWithText(before.entries, "newer user work");
		assert.equal(newer.length, 1, "one newer user entry");
		await host.navigate(firstAssistantAfter(before.entries, newer[0].id).id, 0);

		const sends = host.successorSends();
		assert.equal(sends.length, 1, "tree recovery must not enqueue superseded work");
		assert.equal(sends[0].dropped, true);
		const { entries } = await host.entries();
		assert.equal(userEntriesWithText(entries, buildNextUserMessage({ nextInstruction: "old handoff work" })).length, 0, "no successor user entry");
	}));

	it("failed handoff compaction preserves retryability", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		await host.command("/" + PROBE_COMMAND.cancelNextCompaction);
		// The handoff run, then the run of the failure report sent after the cancelled compaction.
		await handoffCommand(host, "retry after failure", { nextInstruction: "retry after failure" }, 2);

		const failed = await host.entries();
		assert.equal(handoffCompactions(failed.entries).length, 0, "no handoff compaction after the failed call");
		assert.ok(host.notifications.some((notification) => notification.message.includes("Handoff compaction failed")), "failure notified");
		assert.ok(failed.entries.some((entry) => userText(entry)?.includes("Handoff failed") === true), "failure reported to the model");
		const handoffStatuses = host.statuses.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
		assert.equal(handoffStatuses.at(-1)?.statusText, HANDOFF_REQUIRED_STATUS, "the handoff stays required");

		await handoff(host, { nextInstruction: "retry after failure" }, 2);
		const retried = await host.entries();
		const results = toolResults(retried.entries, "handoff");
		assert.equal(results.length, 2, "two handoff results");
		assert.ok(results[1].text.startsWith("Handoff started."), results[1].text);
		onlyHandoffCompaction(retried.entries);
	}));

	it("readonly lifecycle: handoff bypass clears after compaction while readonly persists", TEST_OPTIONS, async (t) => withRealHost(t, async (host) => {
		const blocked = join(host.projectDir, "blocked.txt");
		await host.command("/readonly");
		await host.say("start", 1);
		await handoffCommand(host, "continue readonly work", { nextInstruction: "continue readonly work" }, 2);
		await host.script([
			{ name: "handoff", arguments: { nextInstruction: "direct call" } },
			{ name: "write", arguments: { path: blocked, content: "x" } },
		], 1);

		const { entries } = await host.entries();
		const handoffResults = toolResults(entries, "handoff");
		assert.equal(handoffResults.length, 2, "two handoff results");
		assert.ok(handoffResults[0].text.startsWith("Handoff started."), handoffResults[0].text);
		const compaction = onlyHandoffCompaction(entries);
		assert.ok(
			requestsAfterCompaction(host.probeLog(), compaction.id).some((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		);
		assert.equal(handoffResults[1].isError, true, "handoff is blocked again after compaction");
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
		await host.script(boundaryCall, 2);
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
		const compactionEnds = throughHandoff.flatMap((event, index) => event.type === "compaction_end" ? [index] : []);
		assert.equal(compactionEnds.length, 1, "one compaction ended during the handoff run");
		const statusesAfterCompaction = projectStatuses(throughHandoff.slice(compactionEnds[0] + 1))
			.filter((status) => status.statusKey === STATUS_KEY_HANDOFF);
		assert.ok(statusesAfterCompaction.length > 0, "a handoff status follows the compaction");
		assert.equal(statusesAfterCompaction.at(-1)?.statusText, undefined, "handoff status cleared after the compaction");
		assert.ok(host.notifications.some((notification) => notification.message.includes("Readonly topic boundary detected")), "boundary promotion notified");

		const { entries } = await host.entries();
		const handoffResults = toolResults(entries, "handoff");
		assert.equal(handoffResults.length, 2, "two handoff results");
		assert.ok(handoffResults[0].text.startsWith("Handoff started."), handoffResults[0].text);
		const compaction = onlyHandoffCompaction(entries);
		assert.ok(
			requestsAfterCompaction(log, compaction.id).some((record) => containsText(record, READONLY_ACTIVE_SUMMARY)),
			"readonly is re-announced after the handoff",
		);
		assert.equal(handoffResults[1].isError, true, "handoff is blocked again after compaction");
		assert.equal(handoffResults[1].text, READONLY_HANDOFF_BLOCK_REASON);
	}));
});
