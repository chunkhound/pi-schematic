/**
 * E2E: the `/workflow` command's user-facing contract, exercised through the real
 * extension in a process-isolated host. Graders read only protocol output: transcript
 * entries (exit/summary/error/shell/log), notifications, statuses, the footer, sandbox
 * options, and terminal-input verdicts. Scripted turns are the settle seam; no real
 * AgentSession runs.
 */
import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessHarness } from "./pty-harness.js";
import { tmpDir } from "../unit/helpers.js";
import { isRecord } from "../assertions.js";
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
const NEW_RUN = "tests/e2e/fixtures/command-new-run.js";
const ECHO = "tests/e2e/fixtures/host-echo.js";
const SHELLS = "tests/e2e/fixtures/host-shell-loop.js";
const BROKEN = "tests/e2e/fixtures/broken-workflow.js";
const HANDOFF = "examples/workflows/handoff.js";
const NEW_SESSION = "examples/workflows/new-session.js";

/** Narrow an entry payload (unknown) to a record; throws when it is not an object. */
function recordData(entry: AppendedEntry): Record<string, unknown> {
	const data = entry.data;
	if (!isRecord(data)) {
		throw new Error("the entry payload must be an object");
	}
	return data;
}

function exits(entries: AppendedEntry[]): Record<string, unknown>[] {
	return entries.filter((entry) => entry.customType === "workflow-exit").map(recordData);
}

function lastExit(entries: AppendedEntry[]): Record<string, unknown> | undefined {
	return exits(entries).at(-1);
}

function summaries(entries: AppendedEntry[]): Record<string, unknown>[] {
	return entries.filter((entry) => entry.customType === "workflow-summary").map(recordData);
}

function lastSummary(entries: AppendedEntry[]): Record<string, unknown> {
	const list = summaries(entries);
	if (list.length === 0) {
		throw new Error("the run must persist its overview");
	}
	return list.at(-1) ?? {};
}

function entriesOf(entries: AppendedEntry[], type: string): Record<string, unknown>[] {
	return entries.filter((entry) => entry.customType === type).map(recordData);
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

async function stageHandoff(h: ProcessHarness): Promise<void> {
	h.write(`cmd-bg workflow ${HANDOFF}`);
	await h.waitForText("OK:started");
	await waitForSent(h, "Handoff requested.");
	await sendOk(h, 'usage {"tokens":50000,"percent":25,"contextWindow":200000}');
	await sendOk(h, 'tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
	await h.waitForText("OK:Handoff staged.");
}

describe("workflow command E2E — budget dialog and flags", () => {
	it("dialog cancel notifies and never builds a sandbox", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await sendOk(h, "mock-select"); // queue one undefined -> the cost picker cancels
			await runWorkflow(h, RETURN);
			expect(await readSandboxOptions(h), "a cancelled dialog never builds a sandbox").toBeNull();
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((entry) => /cancel/i.test(entry.message)),
				"cancel is visible",
			).toBe(true);
		}));

	it("flags bypass the budget dialog and reach the sandbox", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await sendOk(h, "flag workflow-cost 2");
			await sendOk(h, "flag workflow-time 1500");
			const entries = await runWorkflow(h, RETURN);
			expect((await readSandboxOptions(h))?.timeoutMs, "sanity deadline is twice the 1500ms budget").toBe(3000);
			expect(lastExit(entries)?.reason).toBe("returned");
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((entry) => entry.message.includes("returned")),
				"returned exit notified",
			).toBe(true);
		}));

	it("an absent --workflow-cost falls back to an unlimited budget", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await runWorkflow(h, RETURN);
			expect((await readSandboxOptions(h))?.timeoutMs).toBe("Infinity");
		}));

	it("an empty --workflow-cost falls back to an unlimited budget", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await sendOk(h, "flag-empty workflow-cost");
			await runWorkflow(h, RETURN);
			expect((await readSandboxOptions(h))?.timeoutMs).toBe("Infinity");
		}));

	for (const value of ["abc", "0", "-5"]) {
		it(`an invalid --workflow-cost "${value}" visibly rejects and cancels the run`, () =>
			withWorkflowChild(async (h) => {
				await sendOk(h, "sandbox ok");
				await sendOk(h, `flag workflow-cost ${value}`);
				await runWorkflow(h, RETURN);
				expect(await readSandboxOptions(h), "an invalid flag builds no sandbox").toBeNull();
				const events = await readUiEvents(h);
				expect(
					events.notifications.some((entry) => entry.level === "error" && entry.message.includes("--workflow-cost")),
					"invalid flag notified as error",
				).toBe(true);
			}));
	}

	it("an invalid --workflow-cost flag shows exactly one notice", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await sendOk(h, "flag workflow-cost abc");
			await runWorkflow(h, RETURN);
			const events = await readUiEvents(h);
			expect(events.notifications, "exactly one notice is shown").toHaveLength(1);
			expect(events.notifications[0].level).toBe("error");
			expect(events.notifications[0].message).toContain("--workflow-cost");
			expect(
				events.notifications.some((entry) => entry.message.includes("Workflow cancelled.")),
				"no double-notice regression",
			).toBe(false);
		}));

	it("a zero --workflow-time visibly rejects and cancels the run", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await sendOk(h, "flag workflow-time 0");
			await runWorkflow(h, RETURN);
			expect(await readSandboxOptions(h)).toBeNull();
			const events = await readUiEvents(h);
			expect(events.notifications.some((entry) => entry.level === "error" && entry.message.includes("--workflow-time"))).toBe(true);
		}));

	it("compile errors notify and never build a sandbox", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			const entries = await runWorkflow(h, BROKEN);
			expect(await readSandboxOptions(h), "a compile error never builds a sandbox").toBeNull();
			expect(exits(entries), "a broken workflow never records an exit").toHaveLength(0);
			const events = await readUiEvents(h);
			expect(events.notifications.some((entry) => entry.level === "error")).toBe(true);
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
				expect(notice, "the not-found notice is shown").toBeDefined();
				expect(notice?.level).toBe("error");
				expect(notice?.message).toMatch(/Available:/);
				expect(notice?.message).toMatch(/wf/);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("workflow command E2E — run outcome and salvage", () => {
	it("a workflow that returns without workflow.exit records {reason:returned} with no partial", () =>
		withWorkflowChild(async (h) => {
			const entries = await runWorkflow(h, RETURN);
			expect(lastExit(entries)).toMatchObject({ reason: "returned" });
			expect(lastExit(entries)).not.toHaveProperty("partial");
			expect(lastSummary(entries).partial, "the overview carries no partial for a normal return").toBeUndefined();
		}));

	it("workflow.exit without a string reason is reported by its metadata, not returned", () =>
		withWorkflowChild(async (h) => {
			const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"foo":1}}');
			expect(lastSummary(entries).reason, "the summary names the exit metadata").toBe('{"foo":1}');
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((entry) => entry.message === '{"foo":1}'),
				"the notice carries the same reason",
			).toBe(true);
		}));

	it("a finished run appends exactly one overview with its reason and spend", () =>
		withWorkflowChild(async (h) => {
			const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"reason":"approved"}}');
			const data = summaries(entries)[0];
			expect(summaries(entries), "exactly one overview per run").toHaveLength(1);
			expect([
				String(data.workflow).includes("host-echo"),
				data.reason === "approved",
				typeof data.elapsedMs === "number",
				typeof data.costUsd === "number",
				Array.isArray(data.spend),
				typeof data.startedAt === "string",
				typeof data.endedAt === "string",
			]).toEqual([true, true, true, true, true, true, true]);
		}));

	it("an aborted run still appends the overview with the reserved reason", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox aborted");
			const entries = await runWorkflow(h, RETURN);
			expect(summaries(entries), "the overview is written on the failure path too").toHaveLength(1);
			expect(lastSummary(entries).reason).toBe("cancelled");
		}));

	it("a throwing first exit append still records exactly one exit via the infra path", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "fault append-throws 1");
			const entries = await runWorkflow(h, RETURN);
			expect(exits(entries)).toMatchObject([{ reason: "error" }]);
		}));

	it("a throwing workflow.exit append still records exactly one exit via the infra path", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "fault append-throws 1");
			const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"reason":"approved"}}');
			expect(exits(entries)).toMatchObject([{ reason: "error", error: /e2e append fault/ }]);
			expect(summaries(entries), "exactly one summary per run").toHaveLength(1);
		}));

	it("a throwing checkpoint exit append persists one exit with the stop reason and partial", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-cost 0.1");
			await sendOk(h, 'turn {"cost":1}');
			await sendOk(h, "fault append-throws 1");
			const entries = await runWorkflowArgs(h, ECHO, '{"handle":"checkpoint","metadata":{"round":1},"spend":true}');
			expect(exits(entries)).toMatchObject([{ reason: "cost-limit", partial: { round: 1 } }]);
		}));
});

describe("workflow command E2E — sandbox failures and cleanup", () => {
	it("a sandbox timeout records and notifies a time-limit exit", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox timeout");
			const entries = await runWorkflow(h, RETURN);
			expect(exits(entries)).toMatchObject([{ reason: "time-limit", error: "e2e sandbox timeout" }]);
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((n) => n.level === "error" && n.message === "time target reached"),
				"soft time stop notified",
			).toBe(true);
		}));

	it("a sandbox memory-limit OOM records an error exit with its message", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox oom");
			const entries = await runWorkflow(h, RETURN);
			expect(exits(entries)).toMatchObject([{ reason: "error", error: "e2e sandbox OOM" }]);
			const events = await readUiEvents(h);
			expect(events.notifications.some((n) => n.level === "error")).toBe(true);
		}));

	it("a sandbox script error surfaces as an error exit", () =>
		withWorkflowChild(async (h) => {
			const entries = await runWorkflow(h, THROW);
			expect(exits(entries)).toMatchObject([{ reason: "error", error: /boom/ }]);
			const events = await readUiEvents(h);
			expect(events.notifications.some((n) => n.level === "error")).toBe(true);
		}));

	it("an infrastructure failure inside the sandbox records exactly one error exit", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox execute-throws");
			const entries = await runWorkflow(h, RETURN);
			expect(exits(entries)).toMatchObject([{ reason: "error", error: "vm blew up" }]);
			const events = await readUiEvents(h);
			expect(events.notifications.some((n) => n.message === "vm blew up" && n.level === "error")).toBe(true);
		}));

	it("a sandbox constructor failure records exactly one error exit without closing", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox factory-error");
			const entries = await runWorkflow(h, RETURN);
			expect(exits(entries)).toMatchObject([{ reason: "error", error: "e2e sandbox factory fault" }]);
			expect(entriesOf(entries, "workflow-error"), "no sandbox exists to close").toHaveLength(0);
			const events = await readUiEvents(h);
			expect(events.notifications.some((n) => n.message === "e2e sandbox factory fault" && n.level === "error")).toBe(true);
		}));

	it("a headless sandbox close failure persists cleanup and keeps one exit", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "headless");
			await sendOk(h, "sandbox close-throws");
			const entries = await runWorkflow(h, RETURN);
			expect(entriesOf(entries, "workflow-error")).toMatchObject([{ phase: "cleanup", error: /workflow sandbox close failed: e2e sandbox close fault/ }]);
			expect(exits(entries)).toMatchObject([{ reason: "returned" }]);
			const events = await readUiEvents(h);
			expect(events.notifications, "headless runs write no notifications").toHaveLength(0);
			expect(Object.keys(events.statuses), "headless runs write no status").toHaveLength(0);
		}));

	it("a close failure whose record cannot persist is noticed on the UI", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox close-throws");
			// The exit record lands first (skip 1); the close record is the faulted append.
			await sendOk(h, "fault append-throws 1 1");
			const entries = await runWorkflow(h, RETURN);
			expect(entriesOf(entries, "workflow-error"), "the faulted record is not persisted").toHaveLength(0);
			expect(exits(entries), "the exit record stands").toHaveLength(1);
			const events = await readUiEvents(h);
			expect(
				events.notifications.some(
					(n) => n.level === "warning" && n.message === "workflow sandbox close failed: e2e sandbox close fault (transcript record not persisted)",
				),
				JSON.stringify(events.notifications),
			).toBe(true);
		}));

	it("a console-output record that cannot persist is noticed on the UI without masking the exit", () =>
		withWorkflowChild(async (h) => {
			// workflow.exit's record lands first (skip 1); the log record is the faulted append.
			await sendOk(h, "fault append-throws 1 1");
			const entries = await runWorkflow(h, LOG);
			expect(entriesOf(entries, "workflow-log"), "the log record is not persisted").toHaveLength(0);
			expect(exits(entries), "the run outcome stands").toMatchObject([{ reason: "ok" }]);
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((n) => n.level === "warning" && n.message === "workflow output could not be persisted"),
				JSON.stringify(events.notifications),
			).toBe(true);
		}));

	it("a 16-deferred-effects hard abort reaches the overview error field", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-cost 0.1");
			await sendOk(h, 'turn {"cost":1}');
			const entries = await runWorkflowArgs(h, SHELLS, '{"count":18,"spend":true}');
			expect(lastSummary(entries)).toMatchObject({ reason: "cost-limit", error: /hard-aborted after 16 deferred effects past the cost-limit stop/ });
			expect(exits(entries), "exactly one exit record").toHaveLength(1);
		}));
});

describe("workflow command E2E — target crossing and salvage", () => {
	it("a run crossing --workflow-cost runs the crossing shell, then stops at the checkpoint", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-cost 0.1");
			await sendOk(h, 'turn {"cost":1}');
			const entries = await runWorkflowArgs(h, SHELLS, '{"count":1,"checkpoint":{"round":1},"spend":true}');
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((n) => n.message === "cost target reached" && n.level === "info"),
				"soft cost stop notified with its human label",
			).toBe(true);
			expect(exits(entries)).toMatchObject([{ reason: "cost-limit", partial: { round: 1 } }]);
			expect(exits(entries)[0]?.error, "a controlled checkpoint stop carries no error").toBeUndefined();
			expect(entriesOf(entries, "workflow-shell").length, "the cost-crossing guarded handle still ran").toBeGreaterThanOrEqual(1);
			expect(lastSummary(entries)).toMatchObject({ reason: "cost-limit", partial: { round: 1 } });
		}));

	it("a branch already over --workflow-time defers the stop to the checkpoint and salvages its partial", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-time 200");
			await sendOk(h, "sandbox no-deadline"); // isolate the soft stop from the sandbox's 2x safeguard
			await sendOk(h, "shell-delay 260"); // cross the 200ms budget
			const entries = await runWorkflowArgs(h, SHELLS, '{"count":1,"checkpoint":{"round":7}}');
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((n) => n.message === "time target reached"),
				"soft time stop notified with its human label",
			).toBe(true);
			expect(exits(entries)).toMatchObject([{ reason: "time-limit", partial: { round: 7 } }]);
			expect(exits(entries)[0]?.error, "a controlled checkpoint stop carries no error").toBeUndefined();
		}));

	it("an unlimited time budget passes Infinity so the sandbox default deadline never fires", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox ok");
			await runWorkflow(h, RETURN);
			expect((await readSandboxOptions(h))?.timeoutMs).toBe("Infinity");
		}));
});

describe("workflow command E2E — headless and rendering", () => {
	it("a headless run persists its record but renders nothing and keeps pi's defaults", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "headless");
			const entries = await runWorkflow(h, RETURN);
			expect({ exitsSome: exits(entries).some((entry) => entry.reason === "returned"), summaryCount: summaries(entries).length }).toEqual({
				exitsSome: true,
				summaryCount: 1,
			});
			expect(await readFooter(h), "headless runs never install the unified footer").toBeNull();
			expect(Object.keys((await readUiEvents(h)).statuses), "headless runs write no footer statuses").toHaveLength(0);
			expect(await readWidgets(h), "headless runs write no widgets").toEqual([]);
			expect((await readTerminal(h)).registered, "headless runs register no cancellation funnel").toBe(false);
		}));

	it("status and working message track workflow progress while running", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, CHECKPOINT_SHELL, '{"metadata":{}}');
			const line = await readFooter(h);
			expect([/🛠️/, /🚩 1/, /\$/, /⏱/].every((re) => re.test(String(line)))).toBe(true);
			await finishHeldRun(h);
			expect(await readFooter(h), "workflow line cleared after the run").toBeNull();
		}));

	it("status clears after the run", () =>
		withWorkflowChild(async (h) => {
			await runWorkflow(h, RETURN);
			expect(await readFooter(h)).toBeNull();
		}));
});

describe("workflow command E2E — audit entries", () => {
	it("each shell effect persists exactly one workflow-shell audit entry", () =>
		withWorkflowChild(async (h) => {
			const entries = await runWorkflowArgs(h, SHELLS, '{"count":2}');
			const audits = entriesOf(entries, "workflow-shell");
			expect(audits, "one audit entry per shell call, not per run").toHaveLength(2);
			expect(audits.map((audit) => audit.detail)).toEqual(["echo 0", "echo 1"]);
			for (const audit of audits) {
				expect([audit.name, audit.ok, audit.exitCode, typeof audit.durationMs, typeof audit.output]).toEqual(["shell", true, 0, "number", "string"]);
			}
		}));

	it("a failing shell effect still persists its workflow-shell audit entry", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "fault shell error");
			const entries = await runWorkflowArgs(h, SHELLS, '{"count":1}');
			expect(entriesOf(entries, "workflow-shell")).toMatchObject([{ detail: "echo 0", ok: false, exitCode: 3, output: /fault-output/ }]);
			expect(lastExit(entries)?.reason, "the run continues past a failed shell").toBe("ok");
		}));

	it("a workflow script's console.log persists as exactly one workflow-log entry", () =>
		withWorkflowChild(async (h) => {
			const entries = await runWorkflow(h, LOG);
			expect(entriesOf(entries, "workflow-log")).toMatchObject([{ text: /hello workflow log/ }]);
		}));
});

describe("workflow command E2E — reservation and input", () => {
	it("the workflow reservation is released when the run ends", () =>
		withWorkflowChild(async (h) => {
			await runWorkflow(h, RETURN);
			const second = await runWorkflow(h, RETURN);
			expect(exits(second), "a finished workflow admits the next one").toHaveLength(2);
		}));

	it("an aborted run releases the reservation so the next /workflow starts", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "sandbox timeout");
			const first = await runWorkflow(h, RETURN);
			expect(lastExit(first)?.reason).toBe("time-limit");
			const second = await runWorkflow(h, RETURN);
			expect(lastExit(second)?.reason, "the aborted run released the reservation").toBe("time-limit");
		}));

	it("input suppression drops non-extension input and passes extension input", () =>
		withWorkflowChild(async (h) => {
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
			expect(h.snapshot()).toContain('OK:{"action":"continue"}');
		}));

	it("a throwing progress seam releases input suppression and still records one error exit", () =>
		withWorkflowChild(async (h) => {
			// Workflow chrome paints only in TUI mode; a progress fault needs that path to arm.
			h.write("tui");
			await h.waitForText("OK");
			await sendOk(h, "sandbox ok");
			await sendOk(h, "fault progress-throws 1");
			const entries = await runWorkflow(h, RETURN);
			expect(await readSandboxOptions(h), "the run fails before the sandbox starts").toBeNull();
			expect(exits(entries)).toMatchObject([{ reason: "error", error: /e2e progress fault/ }]);
			expect(lastSummary(entries)).toMatchObject({ error: /e2e progress fault/ });
			const events = await readUiEvents(h);
			expect(events.notifications.some((n) => n.level === "error" && n.message.includes("e2e progress fault"))).toBe(true);
			h.write("input hello");
			await h.waitForText('OK:{"action":"continue"}');
		}));
});

describe("workflow command E2E — cancellation", () => {
	it("Escape registers a cancellation abort reason", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			await cancelWith(h, "escape");
			await finishHeldRun(h);
			const entries = await readAppended(h);
			expect(lastExit(entries)?.reason).toBe("cancelled");
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((entry) => /cancel/i.test(entry.message)),
				"cancelled notified",
			).toBe(true);
		}));

	it("Ctrl+C cancels the run like Escape", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			await cancelWith(h, "ctrl+c");
			await finishHeldRun(h);
			const entries = await readAppended(h);
			expect(lastExit(entries)?.reason).toBe("cancelled");
		}));

	it("a single Escape arms the cancel guard without aborting", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			h.write("key escape");
			await h.waitForText('OK:{"consume":true}');
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((entry) => entry.level === "warning" && entry.message.includes("Escape again")),
				"the first press warns how to confirm",
			).toBe(true);
			expect(exits(await readAppended(h)), "one press must not abort the run").toHaveLength(0);
			h.write("key escape");
			await h.waitForText('OK:{"consume":true}');
			await finishHeldRun(h);
		}));

	it("a Kitty key release does not confirm an armed cancel", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			// Both reads in one write: a >500ms round-trip gap would let the arm expire, so a
			// released key misread as a press would re-arm instead of confirming — assertion blind.
			h.write('key-raw "\\u001b[27u"\nkey-raw "\\u001b[27;1:3u"');
			await h.waitForText('OK:{"consume":true}'); // the press arms
			await h.waitForText("OK:null"); // the release is ignored
			expect(exits(await readAppended(h)), "a key release is not a second press").toHaveLength(0);
			await cancelWith(h, "escape");
			await finishHeldRun(h);
		}));

	it("a Kitty auto-repeat does not confirm an armed cancel", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			// Both reads in one write: a >500ms round-trip gap would let the arm expire, so an
			// auto-repeat misread as a press would re-arm instead of confirming — assertion blind.
			h.write('key-raw "\\u001b[27u"\nkey-raw "\\u001b[27;1:2u"');
			await h.waitForText('OK:{"consume":true}'); // the press arms
			await h.waitForText("OK:null"); // the auto-repeat is ignored
			expect(exits(await readAppended(h)), "an auto-repeat is not a second press").toHaveLength(0);
			await cancelWith(h, "escape");
			await finishHeldRun(h);
		}));

	it("two Kitty presses confirm the cancel", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			h.write('key-raw "\\u001b[27u"\nkey-raw "\\u001b[27u"');
			await h.waitForText('OK:{"consume":true}');
			await finishHeldRun(h);
			const entries = await readAppended(h);
			expect(lastExit(entries)?.reason, "two discrete presses confirm").toBe("cancelled");
		}));

	it("a Kitty Ctrl+C release does not confirm an armed cancel", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			// Both reads in one write: a >500ms round-trip gap would let the arm expire, so a
			// Ctrl+C release misread as a press would re-arm instead of confirming — assertion blind.
			h.write('key-raw "\\u001b[99;5u"\nkey-raw "\\u001b[99;5:3u"');
			await h.waitForText('OK:{"consume":true}'); // the press arms
			await h.waitForText("OK:null"); // the release is ignored
			expect(exits(await readAppended(h)), "a Ctrl+C release is not a second press").toHaveLength(0);
			await cancelWith(h, "ctrl+c");
			await finishHeldRun(h);
		}));

	it("a cancel press after the confirm window re-arms instead of aborting", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			await sendOk(h, "key escape"); // arm
			// Production window is 500ms; wait past it so the next press re-arms.
			await new Promise((resolve) => setTimeout(resolve, 650));
			await sendOk(h, "key escape"); // re-arm only
			expect(exits(await readAppended(h)), "a press after the window only re-arms").toHaveLength(0);
			await sendOk(h, "key escape"); // confirm inside the fresh window
			await finishHeldRun(h);
			const entries = await readAppended(h);
			expect(lastExit(entries)?.reason).toBe("cancelled");
		}));

	it("Escape then Ctrl+C do not cross-confirm", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, SHELLS, '{"count":1}');
			// Both presses in one write: a >500ms round-trip gap between them would let the first
			// arm expire, making the cross-confirm assertion blind.
			h.write("key escape\nkey ctrl+c");
			await h.waitForText('OK:{"consume":true}'); // escape
			await h.waitForText('OK:{"consume":true}'); // ctrl+c
			expect(exits(await readAppended(h)), "a different key never confirms an armed press").toHaveLength(0);
			await cancelWith(h, "ctrl+c");
			await finishHeldRun(h);
		}));

	it("cancellation binds to TUI mode, not hasUI alone", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "mode rpc");
			await sendOk(h, "hold-exec");
			h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
			await h.waitForText("OK:started");
			await h.waitForText("EXEC-HELD");
			expect((await readTerminal(h)).registered, "rpc mode registers no terminal input").toBe(false);
			h.write("key escape");
			await h.waitForText("ERR:no terminal input listener");
			await finishHeldRun(h);
			const entries = await readAppended(h);
			expect(lastExit(entries)?.reason, "rpc mode cannot cancel by terminal input").toBe("ok");
		}));

	it("a cancel after the checkpoint still salvages the last checkpoint partial", () =>
		withWorkflowChild(async (h) => {
			await startHeldRun(h, CHECKPOINT_SHELL, '{"metadata":{"round":1}}');
			await cancelWith(h, "escape");
			await finishHeldRun(h);
			const entries = await readAppended(h);
			expect(lastExit(entries)).toMatchObject({ reason: "cancelled", partial: { round: 1 } });
		}));

	it("a second /workflow while one is running is rejected before any await", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "hold-exec");
			h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
			await h.waitForText("OK:started");
			await h.waitForText("EXEC-HELD");
			await runWorkflowArgs(h, SHELLS, '{"count":1}');
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((entry) => entry.message.includes("already running")),
				"overlap is visible",
			).toBe(true);
			await finishHeldRun(h);
			const entries = await readAppended(h);
			expect(exits(entries), "the overlapping invocation built no sandbox").toHaveLength(1);
		}));

	it("a second headless /workflow persists its rejection as a visible record", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "headless");
			await sendOk(h, "hold-exec");
			h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
			await h.waitForText("OK:started");
			await h.waitForText("EXEC-HELD");
			await runWorkflowArgs(h, SHELLS, '{"count":1}');
			const entries = await readAppended(h);
			expect(entriesOf(entries, "workflow-error")).toMatchObject([{ phase: "reserve", error: /already running/ }]);
			expect((await readUiEvents(h)).notifications, "headless runs write no notifications").toHaveLength(0);
			await finishHeldRun(h);
		}));
});

describe("workflow command E2E — session replacement", () => {
	it("workflow.new rebinds to the replacement context and the workflow continues", () =>
		withWorkflowChild(async (h) => {
			const entries = await runWorkflow(h, NEW_SESSION);
			expect(lastExit(entries)?.reason).toBe("ok");
		}));

	it("a replacement whose runtime published nothing fails the workflow explicitly", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "new-session-publish off");
			const entries = await runWorkflow(h, NEW_SESSION);
			expect(lastExit(entries)).toMatchObject({ reason: "error", error: /no runtime was published/ });
		}));

	it("a cancelled workflow.new fails the workflow explicitly", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "new-session cancel");
			const entries = await runWorkflow(h, NEW_SESSION);
			expect(lastExit(entries)?.reason, "cancelled replacement records an error exit").toBe("error");
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((entry) => entry.level === "error"),
				"cancelled replacement is an error",
			).toBe(true);
		}));

	it("workflow.run resolves after workflow.new (registry re-subscribes)", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, 'turn {"text":"done"}');
			const entries = await runWorkflow(h, NEW_RUN);
			expect(lastExit(entries)).toMatchObject({ reason: "ok", metadata: { text: "done" } });
		}));

	it("progress ticks never touch the replaced ctx during the replacement window", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "stale-on-new-session on");
			await sendOk(h, "new-session-delay 1200"); // real 1s tick fires inside the window
			const entries = await runWorkflow(h, NEW_SESSION);
			expect(lastExit(entries)?.reason, "the run survives the replacement window").toBe("ok");
		}));
});

describe("workflow command E2E — handoff", () => {
	it("workflow.handoff surfaces a failed boundary as a workflow error", () =>
		withWorkflowChild(async (h) => {
			await stageHandoff(h);
			await sendOk(h, "turn-end fail");
			await sendOk(h, "turn-start");
			await sendOk(h, "cmd-wait");
			const entries = await readAppended(h);
			expect(lastExit(entries)?.reason, "a failed handoff records the reserved error reason").toBe("error");
			const events = await readUiEvents(h);
			expect(events.notifications.some((entry) => entry.level === "error")).toBe(true);
		}));

	it("cancelling a handoff before the settlement ends the wait as cancelled", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "tui");
			h.write(`cmd-bg workflow ${HANDOFF}`);
			await h.waitForText("OK:started");
			await waitForSent(h, "Handoff requested."); // the settlement wait stays pending
			await cancelWith(h, "escape");
			await sendOk(h, "cmd-wait");
			const entries = await readAppended(h);
			expect(exits(entries)).toMatchObject([{ reason: "cancelled" }]);
		}));

	it("a completed boundary continues the run to its own exit", () =>
		withWorkflowChild(async (h) => {
			await stageHandoff(h);
			await sendOk(h, "turn-end");
			await h.waitForText('"continue":true');
			await sendOk(h, "turn-start");
			await sendOk(h, "agent-settled-all");
			await sendOk(h, "cmd-wait");
			const entries = await readAppended(h);
			expect(lastExit(entries)?.reason, "the boundary's continuation reaches the workflow's exit").toBe("ok");
			expect(exits(entries), "one exit record for the continued run").toHaveLength(1);
		}));
});
