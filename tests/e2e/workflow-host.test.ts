/**
 * E2E: the workflow host contract, exercised through the real `/workflow` command in a
 * process-isolated codemode sandbox. Graders read only protocol output: the exit record,
 * the end-of-run summary, notifications, and captured host-callback sequences.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_EFFECTS } from "../../workflow/host.js";
import { READONLY_DISABLED_NOTIFICATION, READONLY_ENABLED_STATUS } from "../../notifications.js";
import {
	latestSummary,
	readActiveTools,
	readAppended,
	readModelCalls,
	readSandboxOptions,
	readSentMessages,
	readTools,
	readUiEvents,
	runWorkflowArgs,
	sendOk,
	waitForSent,
	withWorkflowChild,
	type AppendedEntry,
} from "./workflow-harness.js";

const ECHO = "tests/e2e/fixtures/host-echo.js";
const PREVIEW = "tests/e2e/fixtures/host-preview.js";
const NEW = "tests/e2e/fixtures/host-new.js";
const SHELLS = "tests/e2e/fixtures/host-shell-loop.js";
const RUNS = "tests/e2e/fixtures/host-runs.js";
const CROSS = "tests/e2e/fixtures/host-cross.js";
const READONLY = "tests/e2e/fixtures/host-readonly.js";
const TURNS = "tests/e2e/fixtures/host-handoff-turns.js";

function summaryOf(entries: AppendedEntry[]): Record<string, any> {
	const summary = latestSummary(entries);
	assert.ok(summary, "the run must persist its overview");
	return summary;
}

function exitOf(entries: AppendedEntry[]): Record<string, any> {
	const exit = entries.filter((entry) => entry.customType === "workflow-exit").at(-1);
	assert.ok(exit, "the run must record one exit");
	return exit.data as Record<string, any>;
}

function errorsOf(entries: AppendedEntry[]): Array<Record<string, any>> {
	return entries.filter((entry) => entry.customType === "workflow-error").map((entry) => entry.data as Record<string, any>);
}

describe("workflow host E2E — run correlation", () => {
	it("resolves only after a settled assistant lands past the marker", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"final answer","cost":0.5,"prematureSettles":3}');
		const entries = await runWorkflowArgs(h, RUNS, '{"count":1,"prompt":"hello"}');
		const results = exitOf(entries).metadata.results as any[];
		assert.equal(results[0].ok, true, "a premature settle never resolves the run");
		assert.equal(results[0].text, "final answer");
		assert.ok(results[0].from, "the run is bounded by its sent entry");
		assert.ok(results[0].to, "the run is bounded by its settled assistant");
		assert.equal(results[0].cost, 0.5);
	}));

	it("rejects extension commands and never sends", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-commands [{"name":"danger","source":"extension","sourceInfo":{}}]');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"/danger"}');
		assert.match(String(summaryOf(entries).error), /extension command/);
		assert.equal((await readSentMessages(h)).length, 0, "an extension command never dispatches");
	}));

	it("aggregates full usage across a multi-assistant tool loop", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"assistants":[{"text":"thinking","cost":0.2},{"text":"using tool","cost":0.3},{"text":"final answer","cost":0.5}]}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"hello"}');
		const result = exitOf(entries).metadata.result;
		assert.equal(result.text, "final answer", "the last assistant is the run text");
		assert.equal(result.usage.cost.total, 1.0, "usage sums every assistant past the marker");
		assert.equal(summaryOf(entries).turns, 3, "each assistant is one model turn");
	}));

	// `turns >= steps`, and a handoff step contributes no preparation turn. The session
	// holds four assistant messages (run, prep tail, successor, run); only the two runs count.
	it("counts run assistant messages and excludes the handoff preparation turn", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"before handoff"}');
		await sendOk(h, 'turn {"text":"after handoff"}');
		h.write(`cmd-bg workflow ${TURNS}`);
		await h.waitForText("OK:started");
		await waitForSent(h, "Handoff requested.");
		await sendOk(h, 'usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await sendOk(h, 'tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
		await h.waitForText("OK:Handoff started.");
		await sendOk(h, "compact-success");
		await h.waitForText("queuedFollowUp");
		// The prep tail settles unblocked: it is neither a run nor a counted turn.
		await sendOk(h, "successor-assistant prep done");
		await sendOk(h, "agent-settled-all");
		await sendOk(h, "successor-turn");
		await h.waitForText("## Next instruction");
		await sendOk(h, "successor-assistant successor done");
		await sendOk(h, "agent-settled-all");
		await sendOk(h, "cmd-wait");
		const summary = summaryOf(await readAppended(h));
		assert.equal(summary.reason, "ok");
		assert.equal(summary.steps, 2, "two workflow.run calls");
		assert.equal(summary.turns, 2, "the handoff prep and successor assistants never count");
	}));

	it("rejects a terminal error then accepts a retry", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"stopReason":"error"}');
		await sendOk(h, 'turn {"text":"success"}');
		const entries = await runWorkflowArgs(h, RUNS, '{"count":2,"prompt":"hello"}');
		const results = exitOf(entries).metadata.results as any[];
		assert.equal(results[0].ok, false);
		assert.match(results[0].error, /run failed: error/);
		assert.equal(results[1].ok, true);
		assert.equal(results[1].text, "success");
		assert.equal(summaryOf(entries).turns, 1, "a failed run is not counted as a completed turn");
	}));

	it("scopes the run to the sent entry even when overrides append branch entries", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, 'turn {"text":"final answer"}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"hello","options":{"model":{"provider":"p","id":"m"}}}');
		const result = exitOf(entries).metadata.result;
		assert.ok(result.fromEntryId, "fromEntryId is the first run entry, not an override append");
		assert.equal(result.text, "final answer");
	}));
	it("reports the model that answered the run, so a routed run is attributable", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"final answer","provider":"deepseek","model":"deepseek-flash"}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"hello"}');
		assert.deepEqual(exitOf(entries).metadata.result.model, { provider: "deepseek", model: "deepseek-flash" });
	}));
	it("reports a null model when the settled branch names none", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"final answer"}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"hello"}');
		assert.equal(exitOf(entries).metadata.result.model, null);
	}));
	it("records an explicit exit reason and metadata", async () => withWorkflowChild(async (h) => {
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"reason":"approved","note":1}}');
		assert.deepEqual(exitOf(entries), { v: 1, reason: "approved", metadata: { reason: "approved", note: 1 } });
		assert.equal(summaryOf(entries).reason, "approved");
	}));

	it("rejects a reserved abort reason instead of recording it", async () => withWorkflowChild(async (h) => {
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"exit","metadata":{"reason":"cost-limit"}}');
		assert.match(String(summaryOf(entries).error), /is a reserved abort reason/);
		assert.notEqual(exitOf(entries).reason, "cost-limit", "a reserved reason is never recorded as a controlled exit");
	}));
});

describe("workflow host E2E — model/thinking overrides", () => {
	const OVERRIDES = '{"model":{"provider":"p","id":"m"},"thinking":"high"}';

	it("applies both overrides for the turn and restores them after settle", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, 'turn {"text":"done"}');
		await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${OVERRIDES}}`);
		const calls = await readModelCalls(h);
		assert.deepEqual(calls?.model, [{ provider: "p", id: "m" }, { provider: "base", id: "base" }]);
		assert.deepEqual(calls?.thinking, ["high", "medium"]);
		assert.deepEqual(calls?.current, { provider: "base", id: "base" }, "the previous model is live again");
	}));

	it("rejects a model override when the session has no current model and leaves the model unchanged", async () => withWorkflowChild(async (h) => {
		// Only the resolve result exists; the session has no current model to restore to.
		await sendOk(h, 'mock-model {"resolve":{"provider":"p","id":"m"}}');
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${OVERRIDES}}`);
		assert.match(String(summaryOf(entries).error), /cannot override the model: the session has no current model to restore/);
		const calls = await readModelCalls(h);
		assert.deepEqual(calls?.model, [], "setModel is never reached");
		assert.equal(calls?.current, null, "the session model is unchanged");
	}));

	it("rejects with the restore error when setModel restore fails", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, "fault model-restore");
		await sendOk(h, 'turn {"text":"done"}');
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${OVERRIDES}}`);
		assert.match(String(summaryOf(entries).error), /override restore failed: e2e model restore failed/);
		assert.deepEqual((await readModelCalls(h))?.model, [{ provider: "p", id: "m" }, { provider: "base", id: "base" }]);
	}));

	it("joins the override and restore errors when both fail", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, "fault thinking-throws 1");
		await sendOk(h, "fault thinking-restore");
		await sendOk(h, 'turn {"text":"done"}');
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${OVERRIDES}}`);
		assert.match(String(summaryOf(entries).error), /e2e thinking failed; workflow\.run override restore failed: e2e thinking restore failed/);
	}));

	it("rejects with the restore error when setThinkingLevel restore fails", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, "fault thinking-restore");
		await sendOk(h, 'turn {"text":"done"}');
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${OVERRIDES}}`);
		assert.match(String(summaryOf(entries).error), /override restore failed: e2e thinking restore failed/);
		assert.deepEqual((await readModelCalls(h))?.thinking, ["high", "medium"]);
	}));

	it("restores the previous model when a later override throws", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, "fault thinking-throws 1");
		await sendOk(h, 'turn {"text":"done"}');
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${OVERRIDES}}`);
		assert.match(String(summaryOf(entries).error), /e2e thinking failed/);
		assert.deepEqual((await readModelCalls(h))?.model, [{ provider: "p", id: "m" }, { provider: "base", id: "base" }], "the changed model is restored after a partial failure");
	}));

	it("keeps a buffered notebook preview when an override fails before dispatch", async () => withWorkflowChild(async (h) => {
		// A live model exists, so the failure is the resolve step, not the no-current-model guard.
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"}}');
		await sendOk(h, 'turn {"text":"ok"}');
		const options = '{"model":{"provider":"none","id":"missing"}}';
		const entries = await runWorkflowArgs(h, PREVIEW, `{"first":"hello","firstOptions":${options},"second":"hello"}`);
		const exit = exitOf(entries);
		assert.match(String(exit.metadata.firstError), /model not found/);
		const sent = await readSentMessages(h);
		assert.equal(sent.length, 1, "only the retry dispatches");
		assert.match(sent[0].content, /Notebook page "findings" written/, "the failed run kept the preview buffered");
	}));
});

describe("workflow host E2E — prompt composition", () => {
	it("rides exactly one preview on the next run, in one fence ahead of options.input", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"ok"}');
		await runWorkflowArgs(h, PREVIEW, '{"first":"hello","firstOptions":{"input":{"intent":"auth"}},"second":"hello"}');
		const sent = await readSentMessages(h);
		assert.equal(sent.length, 2);
		assert.match(sent[0].content, /^hello\n\n```/);
		assert.equal((sent[0].content.match(/```/g) ?? []).length, 2, "exactly one fenced block");
		assert.match(sent[0].content, /Notebook page "findings" written: first line/);
		assert.match(sent[0].content, /"intent":"auth"/);
		assert.equal(sent[1].content, "hello", "the preview is consumed exactly once");
	}));

	it("appends options.args to the prompt line ahead of the fenced input", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"ok"}');
		await runWorkflowArgs(h, PREVIEW, '{"first":"hello","firstOptions":{"args":"intent auth","input":{"finding":"x"}}}');
		const sent = await readSentMessages(h);
		assert.match(sent[0].content, /^hello intent auth\n\n```/);
		assert.match(sent[0].content, /"finding":"x"/);
	}));
});

describe("workflow host E2E — budget and limits", () => {
	it("reports null remainders without targets and the live cost", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"cost":0.5}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"budget","spend":true}');
		const budget = exitOf(entries).metadata.result;
		assert.equal(budget.cost, 0.5);
		assert.equal(budget.costRemaining, null);
		assert.equal(budget.timeRemainingMs, null);
	}));

	it("reports numeric remainders when targets are set", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 1");
		await sendOk(h, "flag workflow-time 60000");
		await sendOk(h, 'turn {"cost":0.5}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"budget","spend":true}');
		const budget = exitOf(entries).metadata.result;
		assert.equal(budget.costRemaining, 0.5);
		assert.ok(typeof budget.timeRemainingMs === "number" && budget.timeRemainingMs > 0 && budget.timeRemainingMs <= 60000);
	}));

	it("counts spawned-agent usage carried by a tool result", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"toolResults":[{"toolName":"spawn","cost":0.5}]}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"budget","spend":true}');
		assert.equal(exitOf(entries).metadata.result.cost, 0.5);
	}));

	it("a cost limit crossed at workflow.run defers the stop to the checkpoint", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'turn {"text":"answer","cost":0.5}');
		const entries = await runWorkflowArgs(h, RUNS, '{"count":1,"prompt":"hello"}');
		const summary = summaryOf(entries);
		assert.equal(summary.reason, "cost-limit");
		assert.deepEqual(summary.partial, { phase: "done" }, "the checkpoint metadata is salvaged");
		assert.ok(summary.crossedAt && summary.crossedAt.costUsd >= 0.1, "the crossing is snapshotted for the overview");
		assert.equal(exitOf(entries).reason, "cost-limit");
	}));

	it("a shell past a crossed cost target runs, then the checkpoint stops the run", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'turn {"cost":0.5}');
		const entries = await runWorkflowArgs(h, SHELLS, '{"count":1,"spend":true}');
		assert.equal(exitOf(entries).reason, "cost-limit");
	}));

	it("a checkpoint whose exit append throws keeps the pending-stop reason", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'turn {"text":"answer","cost":0.5}');
		await sendOk(h, "fault append-throws 1");
		const entries = await runWorkflowArgs(h, RUNS, '{"count":1,"prompt":"hello"}');
		assert.equal(exitOf(entries).reason, "cost-limit");
	}));

	it("hard-aborts after the deferred-effect budget and salvages the last checkpoint", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'turn {"cost":0.5}');
		const entries = await runWorkflowArgs(h, CROSS, '{"checkpoint":{"round":3},"count":18}');
		const summary = summaryOf(entries);
		assert.equal(summary.reason, "cost-limit");
		assert.deepEqual(summary.partial, { round: 3 }, "the salvaged checkpoint survives the escalation");
		assert.match(String(summary.error), /16/);
		assert.match(String(summary.error), /cost-limit/);
		assert.equal(exitOf(entries).reason, "cost-limit");
		assert.equal(exitOf(entries).error, summary.error);
	}));

	it("hard-aborts without a checkpoint with a null partial and one exit", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 0.1");
		await sendOk(h, 'turn {"cost":0.5}');
		const entries = await runWorkflowArgs(h, SHELLS, '{"count":18,"spend":true}');
		assert.equal(exitOf(entries).reason, "cost-limit");
		assert.equal(exitOf(entries).partial, null, "no checkpoint means no salvage");
		assert.equal(entries.filter((entry) => entry.customType === "workflow-exit").length, 1, "exactly one exit record");
	}));

	it("classify returns the registry result and charges its usage", async () => withWorkflowChild(async (h) => {
		const usage = '{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.25}}';
		await sendOk(h, `mock-classify {"models":[{"provider":"typesafe","id":"jev"}],"result":{"api":"system-one","provider":"typesafe","model":"jev","answers":{"verdict":{"choice":"Approve"}},"usage":${usage},"stopReason":"stop","timestamp":0}}`);
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"classify","classify":{"model":{"provider":"typesafe","id":"jev"},"state":{},"questions":{}}}');
		assert.equal(exitOf(entries).metadata.result.stopReason, "stop");
		const summary = summaryOf(entries);
		assert.equal(summary.classifySteps, 1);
		assert.equal(summary.costUsd, 0.25, "classifier usage is charged to the run budget");
	}));

	it("state digest carries the live cost", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"cost":0.5}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"state","spend":true}');
		assert.equal(exitOf(entries).metadata.result.cost, 0.5);
	}));
});

describe("workflow host E2E — readonly, entries, session folding", () => {
	it("enabling readonly refreshes the indicator and notifies", async () => withWorkflowChild(async (h) => {
		// The indicator is TUI chrome; the default mock ctx is non-interactive.
		h.write("tui");
		await h.waitForText("OK");
		await runWorkflowArgs(h, READONLY, '{"value":true}');
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message === READONLY_ENABLED_STATUS), "enabling notifies");
		assert.match(String(events.statuses["pi-schematic-readonly"] ?? ""), /readonly/, "the indicator follows the posture");
	}));

	it("toggling readonly both ways emits both notices", async () => withWorkflowChild(async (h) => {
		await runWorkflowArgs(h, READONLY, '{"both":true}');
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message === READONLY_ENABLED_STATUS), "enabling notifies");
		assert.ok(events.notifications.some((n) => n.message === READONLY_DISABLED_NOTIFICATION), "disabling notifies");
	}));

	it("returns compact entry digests after a given id", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'seed-entry {"role":"user","id":"u0","text":"start"}');
		await sendOk(h, 'seed-entry {"role":"assistant","id":"a1","text":"found it"}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"entries","options":{"after":"u0"}}');
		const digests = exitOf(entries).metadata.result as any[];
		assert.equal(digests.length, 1);
		assert.equal(digests[0].role, "assistant");
		assert.equal(digests[0].text, "found it");
	}));

	it("a successful new folds settled branch spend exactly once", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"cost":0.5}');
		await sendOk(h, "new-session clear");
		const entries = await runWorkflowArgs(h, NEW, '{"spend":true}');
		const summary = summaryOf(entries);
		assert.equal(summary.costUsd, 0.5, "baseline committed once");
		assert.equal(summary.activity.new, 1);
	}));

	it("a failed new commits neither baseline cost nor spend", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"cost":0.5}');
		await sendOk(h, "new-session fail");
		const entries = await runWorkflowArgs(h, NEW, '{"spend":true}');
		const summary = summaryOf(entries);
		assert.match(String(summary.error), /e2e new session failed/);
		// The failed replacement nulls the live ctx (workflow/rebind.ts), so the run folds its
		// settled spend into the baseline on the way out: the in-run 0.5 is reported exactly once.
		assert.equal(summary.costUsd, 0.5, "a failed new still reports the run's spend once");
	}));

	it("a cancelled new does not double the branch cost", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"cost":0.5}');
		await sendOk(h, "new-session cancel");
		const entries = await runWorkflowArgs(h, NEW, '{"spend":true}');
		const summary = summaryOf(entries);
		assert.match(String(summary.error), /cancelled/);
		assert.equal(summary.costUsd, 0.5);
	}));

	it("accumulates cost across multiple new resets", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "new-session clear");
		await sendOk(h, 'turn {"cost":0.3}');
		await sendOk(h, 'turn {"cost":0.2}');
		const entries = await runWorkflowArgs(h, NEW, '{"double":true}');
		const summary = summaryOf(entries);
		assert.equal(summary.costUsd, 0.5, "baseline accumulates across resets");
		assert.equal(summary.turns, 2);
	}));
});

describe("workflow host E2E — structured output", () => {
	it("arms the output tool, captures the object, and disarms it", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"output":{"command":"npm test"}}');
		const options = '{"output":{"schema":{"type":"object","required":["command"],"properties":{"command":{"type":"string"}}}}}';
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${options}}`);
		assert.deepEqual(exitOf(entries).metadata.result.output, { command: "npm test" });
		assert.ok(!(await readActiveTools(h)).includes("workflow_output"), "the tool is disarmed after the run");
		assert.ok(
			!exitOf(entries).metadata.result.state.activeTools.includes("workflow_output"),
			"the returned digest is post-release and matches the next workflow.state()",
		);
	}));

	it("accepts any JSON object when no schema is given", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"output":{"anything":true}}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"hello","options":{"output":{}}}');
		assert.deepEqual(exitOf(entries).metadata.result.output, { anything: true });
	}));

	it("never registers the output tool without an output request", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"ok"}');
		await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"hello"}');
		assert.ok(!(await readTools(h)).includes("workflow_output"), "no output request means no tool");
	}));

	it("rejects when the model never calls the output tool and disarms it", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'turn {"text":"no structured call"}');
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"run","prompt":"hello","options":{"output":{"schema":{"type":"object"}}}}');
		assert.match(String(summaryOf(entries).error), /did not call workflow_output/);
		assert.ok(!(await readActiveTools(h)).includes("workflow_output"), "the tool is disarmed after the failed run");
	}));

	it("keeps the run error and the restore error when both fail", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, "fault thinking-restore");
		await sendOk(h, 'turn {"text":"no structured call"}');
		const options = '{"model":{"provider":"p","id":"m"},"thinking":"high","output":{"schema":{"type":"object"}}}';
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${options}}`);
		assert.match(String(summaryOf(entries).error), /did not call workflow_output; workflow\.run override restore failed: e2e thinking restore failed/);
	}));

	it("surfaces the restore error when the run succeeds but the restore fails", async () => withWorkflowChild(async (h) => {
		await sendOk(h, 'mock-model {"current":{"provider":"base","id":"base"},"resolve":{"provider":"p","id":"m"}}');
		await sendOk(h, "fault thinking-restore");
		await sendOk(h, 'turn {"output":{"command":"npm test"}}');
		const options = '{"model":{"provider":"p","id":"m"},"thinking":"high","output":{}}';
		const entries = await runWorkflowArgs(h, ECHO, `{"handle":"run","prompt":"hello","options":${options}}`);
		assert.match(String(summaryOf(entries).error), /override restore failed: e2e thinking restore failed/);
	}));
});

describe("workflow host E2E — shell effects", () => {
	it("logs a shell effect without ever sending an LLM turn", async () => withWorkflowChild(async (h) => {
		const entries = await runWorkflowArgs(h, ECHO, '{"handle":"shell","command":"echo hi"}');
		assert.ok(entries.some((entry) => entry.customType === "workflow-shell"), "one audit entry per shell");
		assert.equal((await readSentMessages(h)).length, 0, "a shell effect never enters LLM context");
		const effects = summaryOf(entries).effects as any[];
		assert.equal(effects.length, 1);
		assert.equal(effects[0].name, "shell");
		assert.equal(effects[0].detail, "echo hi");
		assert.equal(effects[0].ok, true);
	}));

	it("bounds the effect log at MAX_EFFECTS, keeping the newest records", async () => withWorkflowChild(async (h) => {
		const total = MAX_EFFECTS + 5;
		const entries = await runWorkflowArgs(h, SHELLS, `{"count":${total}}`);
		const effects = summaryOf(entries).effects as any[];
		assert.equal(effects.length, MAX_EFFECTS);
		assert.equal(effects[0].id, 6, "the oldest rows are trimmed");
		assert.equal(effects[effects.length - 1].detail, `echo ${total - 1}`, "the newest record survives");
	}));
});

describe("workflow host E2E — sandbox options and abort resilience", () => {
	it("passes an unlimited deadline when no time target is set", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "sandbox oom");
		await runWorkflowArgs(h, ECHO, '{"handle":"budget"}');
		const options = await readSandboxOptions(h);
		assert.equal(options?.timeoutMs, "Infinity", "an unlimited budget disables the sandbox deadline");
		assert.equal(options?.memoryLimitBytes, 256 * 1024 * 1024);
	}));

	it("passes twice the time target as the sandbox deadline", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-time 900000");
		await sendOk(h, "sandbox oom");
		await runWorkflowArgs(h, ECHO, '{"handle":"budget"}');
		assert.equal((await readSandboxOptions(h))?.timeoutMs, 1_800_000);
	}));

	it("persists an abort failure while the sandbox stays cancelled", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "fault abort-throws");
		await sendOk(h, "tui");
		await sendOk(h, "hold-exec");
		h.write(`cmd-bg workflow ${SHELLS} {"count":1}`);
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");
		// Arm then confirm in one stdin chunk so the pair lands inside the real cancel window.
		h.write("key escape\nkey escape");
		await h.waitForText('OK:{"consume":true}');
		await sendOk(h, "release-exec");
		await sendOk(h, "cmd-wait");
		const entries = await readAppended(h);
		assert.equal(exitOf(entries).reason, "cancelled");
		assert.ok(errorsOf(entries).some((error) => error.phase === "abort" && /e2e model abort failed/.test(error.error)), "the abort failure is visible on the transcript");
	}));
});
