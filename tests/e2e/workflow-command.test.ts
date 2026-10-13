/**
 * E2E: the `/workflow` command's user-facing contract, exercised through the real
 * extension in a process-isolated host. Graders read only protocol output: transcript
 * entries (exit/summary/error/shell/log), notifications, statuses, the footer, sandbox
 * options, and terminal-input verdicts. Scripted turns are the settle seam; no real
 * AgentSession runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessHarness } from "./pty-harness.js";
import { tmpDir } from "../unit/helpers.js";
import {
	type AppendedEntry,
	readAppended,
	readFooter,
	readSandboxOptions,
	readTerminal,
	readUiEvents,
	readWidgets,
	runWorkflow,
	runWorkflowArgs,
	sendOk,
	waitForSent,
	withWorkflowChild,
} from "./workflow-harness.js";

const RETURN = "tests/e2e/fixtures/command-return.js";
const CHECKPOINT_SHELL = "tests/e2e/fixtures/command-checkpoint-shell.js";
const LOG = "tests/e2e/fixtures/command-log.js";
const THROW = "tests/e2e/fixtures/command-throw.js";
const NO_CHECKPOINT = "tests/e2e/fixtures/command-no-checkpoint.js";
const NEW_RUN = "tests/e2e/fixtures/command-new-run.js";
const ECHO = "tests/e2e/fixtures/host-echo.js";
const SHELLS = "tests/e2e/fixtures/host-shell-loop.js";
const BROKEN = "tests/e2e/fixtures/broken-workflow.js";
const HANDOFF = "examples/workflows/handoff.js";
const NEW_SESSION = "examples/workflows/new-session.js";

function exits(entries: AppendedEntry[]): Array<Record<string, any>> {
	return entries.filter((entry) => entry.customType === "workflow-exit").map((entry) => entry.data as Record<string, any>);
}

function lastExit(entries: AppendedEntry[]): Record<string, any> | undefined {
	return exits(entries).at(-1);
}

function summaries(entries: AppendedEntry[]): Array<Record<string, any>> {
	return entries.filter((entry) => entry.customType === "workflow-summary").map((entry) => entry.data as Record<string, any>);
}

function lastSummary(entries: AppendedEntry[]): Record<string, any> {
	const list = summaries(entries);
	assert.ok(list.length > 0, "the run must persist its overview");
	return list.at(-1)!;
}

function entriesOf(entries: AppendedEntry[], type: string): Array<Record<string, any>> {
	return entries.filter((entry) => entry.customType === type).map((entry) => entry.data as Record<string, any>);
}

/** Park a cancellable run inside its fake shell call; the checkpoint (if any) already ran. */
async function startHeldRun(h: ProcessHarness, path: string, args = ""): Promise<void> {
	await sendOk(h, "tui");
	await sendOk(h, "hold-exec");
	h.write(`cmd-bg workflow ${path}${args ? ` ${args}` : ""}`);
	await h.waitForText("OK:started");
	await h.waitForText("EXEC-HELD");
}

async function finishHeldRun(h: ProcessHarness): Promise<void> {
	await sendOk(h, "release-exec");
	await sendOk(h, "cmd-wait");
}

/** Send one key twice in a single stdin chunk so the pair lands inside the 500ms window. */
async function cancelWith(h: ProcessHarness, key: "escape" | "ctrl+c"): Promise<void> {
	h.write(`key ${key}\nkey ${key}`);
	await h.waitForText('OK:{"consume":true}');
}

async function runHandoffToCompaction(h: ProcessHarness): Promise<void> {
	h.write(`cmd-bg workflow ${HANDOFF}`);
	await h.waitForText("OK:started");
	await waitForSent(h, "Handoff requested.");
	await sendOk(h, 'usage {"tokens":50000,"percent":25,"contextWindow":200000}');
	await sendOk(h, 'tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
	await h.waitForText("OK:Handoff started.");
}

describe("workflow command E2E — budget dialog and flags", () => {
	it("dialog cancel notifies and never builds a sandbox", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		await sendOk(h, "mock-select"); // queue one undefined -> the cost picker cancels
		await runWorkflow(h, RETURN);
		assert.equal(await readSandboxOptions(h), null, "a cancelled dialog never builds a sandbox");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => /cancel/i.test(entry.message)), "cancel is visible");
	}));

	it("flags bypass the budget dialog and reach the sandbox", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		await sendOk(h, "flag workflow-cost 2");
		await sendOk(h, "flag workflow-time 1500");
		const entries = await runWorkflow(h, RETURN);
		assert.equal((await readSandboxOptions(h))?.timeoutMs, 3000, "sanity deadline is twice the 1500ms budget");
		assert.equal(lastExit(entries)?.reason, "returned");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.message.includes("returned")), "returned exit notified");
	}));

	it("an absent --workflow-cost falls back to an unlimited budget", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		await runWorkflow(h, RETURN);
		assert.equal((await readSandboxOptions(h))?.timeoutMs, "Infinity");
	}));

	it("an empty --workflow-cost falls back to an unlimited budget", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		await sendOk(h, "flag-empty workflow-cost");
		await runWorkflow(h, RETURN);
		assert.equal((await readSandboxOptions(h))?.timeoutMs, "Infinity");
	}));

	for (const value of ["abc", "0", "-5"]) {
		it(`an invalid --workflow-cost "${value}" visibly rejects and cancels the run`, () => withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await sendOk(h, `flag workflow-cost ${value}`);
			await runWorkflow(h, RETURN);
			assert.equal(await readSandboxOptions(h), null, "an invalid flag builds no sandbox");
			const events = await readUiEvents(h);
			assert.ok(events.notifications.some((entry) => entry.level === "error" && entry.message.includes("--workflow-cost")), "invalid flag notified as error");
		}));
	}

	it("an invalid --workflow-cost flag shows exactly one notice", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		await sendOk(h, "flag workflow-cost abc");
		await runWorkflow(h, RETURN);
		const events = await readUiEvents(h);
		assert.equal(events.notifications.length, 1, "exactly one notice is shown");
		assert.equal(events.notifications[0].level, "error");
		assert.ok(events.notifications[0].message.includes("--workflow-cost"));
		assert.ok(!events.notifications.some((entry) => entry.message.includes("Workflow cancelled.")), "no double-notice regression");
	}));

	it("a zero --workflow-time visibly rejects and cancels the run", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		await sendOk(h, "flag workflow-time 0");
		await runWorkflow(h, RETURN);
		assert.equal(await readSandboxOptions(h), null);
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.level === "error" && entry.message.includes("--workflow-time")));
	}));

	it("compile errors notify and never build a sandbox", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		const entries = await runWorkflow(h, BROKEN);
		assert.equal(await readSandboxOptions(h), null, "a compile error never builds a sandbox");
		assert.equal(exits(entries).length, 0, "a broken workflow never records an exit");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.level === "error"));
	}));

	it("a missing workflow name notifies the user with the available workflows", async () => {
		const dir = await tmpDir();
		try {
			await mkdir(join(dir, ".pi", "workflows"), { recursive: true });
			await writeFile(join(dir, ".pi", "workflows", "wf.js"), "return defineWorkflow((workflow) => workflow.checkpoint({}));");
			await withWorkflowChild(async (h) => {
				await sendOk(h, `cwd ${dir}`);
				await runWorkflow(h, "definitely-missing-name");
				const events = await readUiEvents(h);
				const notice = events.notifications.find((n) => n.message.includes("Workflow not found"));
				assert.ok(notice, "the not-found notice is shown");
				assert.equal(notice!.level, "error");
				assert.match(notice!.message, /Available:/, "available names are listed");
				assert.match(notice!.message, /wf/, "the discovered workflow is named in the listing");
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("workflow command E2E — run outcome and salvage", () => {
	it("a workflow that returns without workflow.exit records {reason:returned} with no partial", () => withWorkflowChild(async (h) => {
		const entries = await runWorkflow(h, RETURN);
		const exit = lastExit(entries)!;
		assert.equal(exit.reason, "returned");
		assert.ok(!("partial" in exit), "a normal return salvages no partial");
		assert.equal(lastSummary(entries).partial, undefined, "the overview carries no partial for a normal return");
	}));

	it("workflow.exit without a string reason is reported by its metadata, not returned", () => withWorkflowChild(async (h) => {
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"foo":1}}');
		assert.equal(lastSummary(entries).reason, '{"foo":1}', "the summary names the exit metadata");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.message === '{"foo":1}'), "the notice carries the same reason");
	}));

	it("a finished run appends exactly one overview with its reason and spend", () => withWorkflowChild(async (h) => {
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"reason":"approved"}}');
		const list = summaries(entries);
		assert.equal(list.length, 1, "exactly one overview per run");
		const data = list[0];
		assert.match(String(data.workflow), /host-echo/, "the overview names the workflow");
		assert.equal(data.reason, "approved");
		assert.equal(typeof data.elapsedMs, "number");
		assert.equal(typeof data.costUsd, "number");
		assert.ok(Array.isArray(data.spend), "the overview carries per-model spend rows");
		assert.equal(typeof data.startedAt, "string");
		assert.equal(typeof data.endedAt, "string");
	}));

	it("an aborted run still appends the overview with the reserved reason", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox aborted");
		const entries = await runWorkflow(h, RETURN);
		assert.equal(summaries(entries).length, 1, "the overview is written on the failure path too");
		assert.equal(lastSummary(entries).reason, "cancelled");
	}));

	it("a throwing first exit append still records exactly one exit via the infra path", () => withWorkflowChild(async (h) => {
		await sendOk(h, "fault append-throws 1");
		const entries = await runWorkflow(h, RETURN);
		const list = exits(entries);
		assert.equal(list.length, 1, "exactly one exit record despite the first append throwing");
		assert.equal(list[0].reason, "error");
	}));

	it("a throwing workflow.exit append still records exactly one exit via the infra path", () => withWorkflowChild(async (h) => {
		await sendOk(h, "fault append-throws 1");
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"reason":"approved"}}');
		const list = exits(entries);
		assert.equal(list.length, 1, "exactly one exit record despite workflow.exit's append throwing");
		assert.equal(list[0].reason, "error");
		assert.match(String(list[0].error), /e2e append fault/);
		assert.equal(summaries(entries).length, 1, "exactly one summary per run");
	}));

	it("a throwing checkpoint exit append persists one exit with the stop reason and partial", () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'seed-entry {"type":"usage","cost":1}');
		await sendOk(h, "fault append-throws 1");
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"checkpoint","metadata":{"round":1}}');
		const list = exits(entries);
		assert.equal(list.length, 1, "exactly one exit record despite the checkpoint's append throwing");
		assert.equal(list[0].reason, "cost-limit", "the retry keeps the pending-stop reason instead of relabelling it as error");
		assert.deepEqual(list[0].partial, { round: 1 }, "the checkpoint metadata still salvages");
	}));
});

describe("workflow command E2E — sandbox failures and cleanup", () => {
	it("a sandbox timeout records and notifies a time-limit exit", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox timeout");
		const entries = await runWorkflow(h, RETURN);
		const list = exits(entries);
		assert.equal(list.length, 1);
		assert.equal(list[0].reason, "time-limit");
		assert.equal(list[0].error, "e2e sandbox timeout");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.level === "error" && n.message === "time target reached"), "soft time stop notified");
	}));

	it("a sandbox memory-limit OOM records an error exit with its message", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox oom");
		const entries = await runWorkflow(h, RETURN);
		const list = exits(entries);
		assert.equal(list[0].reason, "error");
		assert.equal(list[0].error, "e2e sandbox OOM");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.level === "error"));
	}));

	it("a sandbox script error surfaces as an error exit", () => withWorkflowChild(async (h) => {
		const entries = await runWorkflow(h, THROW);
		const list = exits(entries);
		assert.equal(list[0].reason, "error");
		assert.match(String(list[0].error), /boom/);
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.level === "error"));
	}));

	it("an infrastructure failure inside the sandbox records exactly one error exit", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox execute-throws");
		const entries = await runWorkflow(h, RETURN);
		const list = exits(entries);
		assert.equal(list.length, 1);
		assert.equal(list[0].reason, "error");
		assert.equal(list[0].error, "vm blew up");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message === "vm blew up" && n.level === "error"));
	}));

	it("a sandbox constructor failure records exactly one error exit without closing", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox factory-error");
		const entries = await runWorkflow(h, RETURN);
		const list = exits(entries);
		assert.equal(list.length, 1);
		assert.equal(list[0].reason, "error");
		assert.equal(list[0].error, "e2e sandbox factory fault");
		assert.equal(entriesOf(entries, "workflow-error").length, 0, "no sandbox exists to close");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message === "e2e sandbox factory fault" && n.level === "error"));
	}));

	it("a headless sandbox close failure persists cleanup and keeps one exit", () => withWorkflowChild(async (h) => {
		await sendOk(h, "headless");
		await sendOk(h, "sandbox close-throws");
		const entries = await runWorkflow(h, RETURN);
		const errors = entriesOf(entries, "workflow-error");
		assert.equal(errors.length, 1, "the headless cleanup failure is persisted");
		assert.equal(errors[0].phase, "cleanup");
		assert.match(String(errors[0].error), /workflow sandbox close failed: e2e sandbox close fault/);
		const list = exits(entries);
		assert.equal(list.length, 1, "the close failure does not add a second exit");
		assert.equal(list[0].reason, "returned");
		const events = await readUiEvents(h);
		assert.equal(events.notifications.length, 0, "headless runs write no notifications");
		assert.equal(Object.keys(events.statuses).length, 0, "headless runs write no status");
	}));

	it("a close failure whose record cannot persist is noticed on the UI", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox close-throws");
		// The exit record lands first (skip 1); the close record is the faulted append.
		await sendOk(h, "fault append-throws 1 1");
		const entries = await runWorkflow(h, RETURN);
		assert.equal(entriesOf(entries, "workflow-error").length, 0, "the faulted record is not persisted");
		assert.equal(exits(entries).length, 1, "the exit record stands");
		const events = await readUiEvents(h);
		assert.ok(
			events.notifications.some((n) => n.level === "warning" && n.message === "workflow sandbox close failed: e2e sandbox close fault (transcript record not persisted)"),
			JSON.stringify(events.notifications),
		);
	}));

	it("a console-output record that cannot persist is noticed on the UI without masking the exit", () => withWorkflowChild(async (h) => {
		// workflow.exit's record lands first (skip 1); the log record is the faulted append.
		await sendOk(h, "fault append-throws 1 1");
		const entries = await runWorkflow(h, LOG);
		assert.equal(entriesOf(entries, "workflow-log").length, 0, "the log record is not persisted");
		assert.equal(exits(entries)[0]?.reason, "ok", "the run outcome stands");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.level === "warning" && n.message === "workflow output could not be persisted"), JSON.stringify(events.notifications));
	}));

	it("a 16-deferred-effects hard abort reaches the overview error field", () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'seed-entry {"type":"usage","cost":1}');
		const entries = await runWorkflowArgs(h, SHELLS, '{"count":18}');
		const summary = lastSummary(entries);
		assert.equal(summary.reason, "cost-limit", "the overview records the escalation reason");
		assert.match(String(summary.error), /hard-aborted after 16 deferred effects past the cost-limit stop/, "the overview carries the escalation message");
		assert.equal(exits(entries).length, 1, "exactly one exit record");
	}));
});

describe("workflow command E2E — target crossing and salvage", () => {
	it("a branch already over --workflow-cost runs the crossing shell, then stops at the checkpoint", () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'seed-entry {"type":"usage","cost":1}');
		const entries = await runWorkflowArgs(h, SHELLS, '{"count":1,"checkpoint":{"round":1}}');
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message === "cost target reached" && n.level === "info"), "soft cost stop notified with its human label");
		const list = exits(entries);
		assert.equal(list.length, 1, "the crossing handle ran, then the checkpoint stopped the run");
		assert.equal(list[0].reason, "cost-limit");
		assert.deepEqual(list[0].partial, { round: 1 }, "the checkpoint metadata is salvaged as partial");
		assert.equal(list[0].error, undefined, "a controlled checkpoint stop carries no error");
		assert.ok(entriesOf(entries, "workflow-shell").length >= 1, "the cost-crossing guarded handle still ran");
		const summary = lastSummary(entries);
		assert.equal(summary.reason, "cost-limit");
		assert.deepEqual(summary.partial, { round: 1 }, "the overview salvages the checkpoint metadata");
	}));

	it("a branch already over --workflow-time defers the stop to the checkpoint and salvages its partial", () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-time 200");
		await sendOk(h, "sandbox no-deadline"); // isolate the soft stop from the sandbox's 2x safeguard
		await sendOk(h, "shell-delay 260"); // cross the 200ms budget
		const entries = await runWorkflowArgs(h, SHELLS, '{"count":1,"checkpoint":{"round":7}}');
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message === "time target reached"), "soft time stop notified with its human label");
		const list = exits(entries);
		assert.equal(list.length, 1);
		assert.equal(list[0].reason, "time-limit");
		assert.deepEqual(list[0].partial, { round: 7 }, "the checkpoint metadata is salvaged as partial");
		assert.equal(list[0].error, undefined, "a controlled checkpoint stop carries no error");
	}));

	it("an unlimited time budget passes Infinity so the sandbox default deadline never fires", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox ok");
		await runWorkflow(h, RETURN);
		assert.equal((await readSandboxOptions(h))?.timeoutMs, "Infinity");
	}));
});

describe("workflow command E2E — headless and rendering", () => {
	it("a headless run persists its record but renders nothing and keeps pi's defaults", () => withWorkflowChild(async (h) => {
		await sendOk(h, "headless");
		const entries = await runWorkflow(h, RETURN);
		assert.ok(exits(entries).some((entry) => entry.reason === "returned"));
		assert.equal(summaries(entries).length, 1);
		assert.equal(await readFooter(h), null, "headless runs never install the unified footer");
		assert.equal(Object.keys((await readUiEvents(h)).statuses).length, 0, "headless runs write no footer statuses");
		assert.deepEqual(await readWidgets(h), [], "headless runs write no widgets");
		assert.equal((await readTerminal(h)).registered, false, "headless runs register no cancellation funnel");
	}));

	it("status and working message track workflow progress while running", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, CHECKPOINT_SHELL, '{"metadata":{}}');
		const line = await readFooter(h);
		assert.match(String(line), /🛠️/, "the status line names the workflow");
		assert.match(String(line), /🚩 1/, "the status line reflects passed checkpoints");
		assert.match(String(line), /\$/, "the status line reflects cost");
		assert.match(String(line), /⏱/, "the status line reflects elapsed time");
		await finishHeldRun(h);
		assert.equal(await readFooter(h), null, "workflow line cleared after the run");
	}));

	it("status clears after the run", () => withWorkflowChild(async (h) => {
		await runWorkflow(h, RETURN);
		assert.equal(await readFooter(h), null);
	}));
});

describe("workflow command E2E — audit entries", () => {
	it("each shell effect persists exactly one workflow-shell audit entry", () => withWorkflowChild(async (h) => {
		const entries = await runWorkflowArgs(h, SHELLS, '{"count":2}');
		const audits = entriesOf(entries, "workflow-shell");
		assert.equal(audits.length, 2, "one audit entry per shell call, not per run");
		assert.deepEqual(audits.map((audit) => audit.detail), ["echo 0", "echo 1"]);
		for (const audit of audits) {
			assert.equal(audit.name, "shell");
			assert.equal(audit.ok, true);
			assert.equal(audit.exitCode, 0);
			assert.equal(typeof audit.durationMs, "number");
			assert.equal(typeof audit.output, "string");
		}
	}));

	it("a failing shell effect still persists its workflow-shell audit entry", () => withWorkflowChild(async (h) => {
		await sendOk(h, "fault shell error");
		const entries = await runWorkflowArgs(h, SHELLS, '{"count":1}');
		const audits = entriesOf(entries, "workflow-shell");
		assert.equal(audits.length, 1, "the failed call still writes its audit row");
		assert.equal(audits[0].detail, "echo 0");
		assert.equal(audits[0].ok, false, "the failure is recorded, not dropped");
		assert.equal(audits[0].exitCode, 3);
		assert.match(String(audits[0].output), /fault-output/);
		assert.equal(lastExit(entries)?.reason, "ok", "the run continues past a failed shell");
	}));

	it("a workflow script's console.log persists as exactly one workflow-log entry", () => withWorkflowChild(async (h) => {
		const entries = await runWorkflow(h, LOG);
		const logs = entriesOf(entries, "workflow-log");
		assert.equal(logs.length, 1, "exactly one workflow-log entry");
		assert.match(String(logs[0].text), /hello workflow log/);
	}));
});

describe("workflow command E2E — reservation and input", () => {
	it("the workflow reservation is released when the run ends", () => withWorkflowChild(async (h) => {
		await runWorkflow(h, RETURN);
		const second = await runWorkflow(h, RETURN);
		assert.equal(exits(second).length, 2, "a finished workflow admits the next one");
	}));

	it("an aborted run releases the reservation so the next /workflow starts", () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox timeout");
		const first = await runWorkflow(h, RETURN);
		assert.equal(lastExit(first)?.reason, "time-limit");
		const second = await runWorkflow(h, RETURN);
		assert.equal(lastExit(second)?.reason, "time-limit", "the aborted run released the reservation");
	}));

	it("input suppression drops non-extension input and passes extension input", () => withWorkflowChild(async (h) => {
		await sendOk(h, "hold-exec");
		h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");
		h.write("input hello");
		await h.waitForText('OK:{"action":"handled"}');
		h.write("input-ext hello");
		await h.waitForText('OK:{"action":"continue"}');
		await finishHeldRun(h);
		h.write("input hello");
		await h.waitForText('OK:{"action":"continue"}');
	}));

	it("a throwing progress seam releases input suppression and still records one error exit", () => withWorkflowChild(async (h) => {
		// Workflow chrome paints only in TUI mode; a progress fault needs that path to arm.
		h.write("tui");
		await h.waitForText("OK");
		await sendOk(h, "sandbox ok");
		await sendOk(h, "fault progress-throws 1");
		const entries = await runWorkflow(h, RETURN);
		assert.equal(await readSandboxOptions(h), null, "the run fails before the sandbox starts");
		const list = exits(entries);
		assert.equal(list.length, 1, "the failed setup still records exactly one exit");
		assert.equal(list[0].reason, "error");
		assert.match(String(list[0].error), /e2e progress fault/);
		const summary = lastSummary(entries);
		assert.match(String(summary.error), /e2e progress fault/);
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.level === "error" && n.message.includes("e2e progress fault")));
		h.write("input hello");
		await h.waitForText('OK:{"action":"continue"}');
	}));
});

describe("workflow command E2E — cancellation", () => {
	it("Escape registers a cancellation abort reason", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		await cancelWith(h, "escape");
		await finishHeldRun(h);
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "cancelled");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => /cancel/i.test(entry.message)), "cancelled notified");
	}));

	it("Ctrl+C cancels the run like Escape", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		await cancelWith(h, "ctrl+c");
		await finishHeldRun(h);
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "cancelled");
	}));

	it("a single Escape arms the cancel guard without aborting", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		h.write("key escape");
		await h.waitForText('OK:{"consume":true}');
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.level === "warning" && entry.message.includes("Escape again")), "the first press warns how to confirm");
		assert.equal(exits(await readAppended(h)).length, 0, "one press must not abort the run");
		h.write("key escape");
		await h.waitForText('OK:{"consume":true}');
		await finishHeldRun(h);
	}));

	it("a Kitty key release does not confirm an armed cancel", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		await sendOk(h, 'key-raw "\\u001b[27u"');
		await sendOk(h, 'key-raw "\\u001b[27;1:3u"');
		assert.equal(exits(await readAppended(h)).length, 0, "a key release is not a second press");
		await cancelWith(h, "escape");
		await finishHeldRun(h);
	}));

	it("a Kitty auto-repeat does not confirm an armed cancel", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		await sendOk(h, 'key-raw "\\u001b[27u"');
		await sendOk(h, 'key-raw "\\u001b[27;1:2u"');
		assert.equal(exits(await readAppended(h)).length, 0, "an auto-repeat is not a second press");
		await cancelWith(h, "escape");
		await finishHeldRun(h);
	}));

	it("two Kitty presses confirm the cancel", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		h.write('key-raw "\\u001b[27u"\nkey-raw "\\u001b[27u"');
		await h.waitForText('OK:{"consume":true}');
		await finishHeldRun(h);
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "cancelled", "two discrete presses confirm");
	}));

	it("a Kitty Ctrl+C release does not confirm an armed cancel", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		await sendOk(h, 'key-raw "\\u001b[99;5u"');
		await sendOk(h, 'key-raw "\\u001b[99;5:3u"');
		assert.equal(exits(await readAppended(h)).length, 0, "a Ctrl+C release is not a second press");
		await cancelWith(h, "ctrl+c");
		await finishHeldRun(h);
	}));

	it("a cancel press after the confirm window re-arms instead of aborting", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		await sendOk(h, "key escape"); // arm
		// Production window is 500ms; wait past it so the next press re-arms.
		await new Promise((resolve) => setTimeout(resolve, 650));
		await sendOk(h, "key escape"); // re-arm only
		assert.equal(exits(await readAppended(h)).length, 0, "a press after the window only re-arms");
		await sendOk(h, "key escape"); // confirm inside the fresh window
		await finishHeldRun(h);
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "cancelled");
	}));

	it("Escape then Ctrl+C do not cross-confirm", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, SHELLS, '{"count":1}');
		await sendOk(h, "key escape");
		await sendOk(h, "key ctrl+c");
		assert.equal(exits(await readAppended(h)).length, 0, "a different key never confirms an armed press");
		await cancelWith(h, "ctrl+c");
		await finishHeldRun(h);
	}));

	it("cancellation binds to TUI mode, not hasUI alone", () => withWorkflowChild(async (h) => {
		await sendOk(h, "mode rpc");
		await sendOk(h, "hold-exec");
		h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");
		assert.equal((await readTerminal(h)).registered, false, "rpc mode registers no terminal input");
		h.write("key escape");
		await h.waitForText("ERR:no terminal input listener");
		await finishHeldRun(h);
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "ok", "rpc mode cannot cancel by terminal input");
	}));

	it("a cancel after the checkpoint still salvages the last checkpoint partial", () => withWorkflowChild(async (h) => {
		await startHeldRun(h, CHECKPOINT_SHELL, '{"metadata":{"round":1}}');
		await cancelWith(h, "escape");
		await finishHeldRun(h);
		const entries = await readAppended(h);
		const exit = lastExit(entries)!;
		assert.equal(exit.reason, "cancelled", "a late cancel records the cancel reason");
		assert.deepEqual(exit.partial, { round: 1 }, "checkpoint partial is salvaged past an ok result");
	}));

	it("a second /workflow while one is running is rejected before any await", () => withWorkflowChild(async (h) => {
		await sendOk(h, "hold-exec");
		h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");
		await runWorkflowArgs(h, SHELLS, '{"count":1}');
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.message.includes("already running")), "overlap is visible");
		await finishHeldRun(h);
		const entries = await readAppended(h);
		assert.equal(exits(entries).length, 1, "the overlapping invocation built no sandbox");
	}));

	it("a second headless /workflow persists its rejection as a visible record", () => withWorkflowChild(async (h) => {
		await sendOk(h, "headless");
		await sendOk(h, "hold-exec");
		h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");
		await runWorkflowArgs(h, SHELLS, '{"count":1}');
		const entries = await readAppended(h);
		const errors = entriesOf(entries, "workflow-error");
		assert.equal(errors.length, 1, "headless rejection persisted to the transcript");
		assert.equal(errors[0].phase, "reserve");
		assert.match(String(errors[0].error), /already running/);
		assert.equal((await readUiEvents(h)).notifications.length, 0, "headless runs write no notifications");
		await finishHeldRun(h);
	}));
});

describe("workflow command E2E — session replacement", () => {
	it("workflow.new rebinds to the replacement context and the workflow continues", () => withWorkflowChild(async (h) => {
		const entries = await runWorkflow(h, NEW_SESSION);
		assert.equal(lastExit(entries)?.reason, "ok");
	}));

	it("a replacement whose runtime published nothing fails the workflow explicitly", () => withWorkflowChild(async (h) => {
		await sendOk(h, "new-session-publish off");
		const entries = await runWorkflow(h, NEW_SESSION);
		const exit = lastExit(entries)!;
		assert.equal(exit.reason, "error", "the missing bindings abort the run");
		assert.match(String(exit.error), /no runtime was published/);
	}));

	it("a cancelled workflow.new fails the workflow explicitly", () => withWorkflowChild(async (h) => {
		await sendOk(h, "new-session cancel");
		const entries = await runWorkflow(h, NEW_SESSION);
		assert.equal(lastExit(entries)?.reason, "error", "cancelled replacement records an error exit");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.level === "error"), "cancelled replacement is an error");
	}));

	it("workflow.run resolves after workflow.new (registry re-subscribes)", () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"done"}');
		const entries = await runWorkflow(h, NEW_RUN);
		const exit = lastExit(entries)!;
		assert.equal(exit.reason, "ok");
		assert.equal(exit.text, "done", "the run resolved through the replacement runtime");
	}));

	it("progress ticks never touch the replaced ctx during the replacement window", () => withWorkflowChild(async (h) => {
		await sendOk(h, "stale-on-new-session on");
		await sendOk(h, "new-session-delay 1200"); // real 1s tick fires inside the window
		const entries = await runWorkflow(h, NEW_SESSION);
		assert.equal(lastExit(entries)?.reason, "ok", "the run survives the replacement window");
	}));
});

describe("workflow command E2E — handoff", () => {
	it("workflow.handoff surfaces a failed compaction as a workflow error", () => withWorkflowChild(async (h) => {
		await runHandoffToCompaction(h);
		await sendOk(h, "compact-fail boom");
		await sendOk(h, "cmd-wait");
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "error", "aborted handoff records the reserved error reason");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.level === "error"));
	}));

	it("cancelling a handoff before the compaction ends the wait as cancelled", () => withWorkflowChild(async (h) => {
		await sendOk(h, "tui");
		h.write(`cmd-bg workflow ${HANDOFF}`);
		await h.waitForText("OK:started");
		await waitForSent(h, "Handoff requested."); // the compaction wait stays pending
		await cancelWith(h, "escape");
		await sendOk(h, "cmd-wait");
		const entries = await readAppended(h);
		const list = exits(entries);
		assert.equal(list.length, 1, "exactly one exit record");
		assert.equal(list[0].reason, "cancelled", "cancellation ends the pending handoff");
	}));

	it("the preparing turn's post-compaction tail does not pass for the successor", () => withWorkflowChild(async (h) => {
		await runHandoffToCompaction(h);
		await sendOk(h, "compact-success");
		await h.waitForText("queuedFollowUp");
		await sendOk(h, "successor-assistant prep done");
		await sendOk(h, "agent-settled-all");
		assert.equal(exits(await readAppended(h)).length, 0, "the preparing turn's tail never resolved the wait");
		await sendOk(h, "successor-turn");
		await h.waitForText("## Next instruction");
		await sendOk(h, "successor-assistant successor done");
		await sendOk(h, "agent-settled-all");
		await sendOk(h, "cmd-wait");
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "ok", "the actual successor settle unblocks the handoff");
	}));

	it("a delivered successor prompt without a successor settle does not unblock the handoff", () => withWorkflowChild(async (h) => {
		await runHandoffToCompaction(h);
		await sendOk(h, "compact-success");
		await h.waitForText("queuedFollowUp");
		await sendOk(h, "successor-turn");
		await h.waitForText("## Next instruction");
		await sendOk(h, "agent-settled-all"); // only the user turn landed
		assert.equal(exits(await readAppended(h)).length, 0, "the handoff waits for the successor's own settle");
		await sendOk(h, "successor-assistant successor done");
		await sendOk(h, "agent-settled-all");
		await sendOk(h, "cmd-wait");
		const entries = await readAppended(h);
		assert.equal(lastExit(entries)?.reason, "ok");
	}));
});
