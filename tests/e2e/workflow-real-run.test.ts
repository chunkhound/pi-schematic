// WHY: the only probe that fakes nothing where the run actually executes. The command builds
// the real CodemodeSandbox (no `sandboxFactory` seam) and the workflow's `workflow.run` turn
// runs in a real AgentSession against the offline deterministic provider. Together they pin the
// shipped chain: file -> compile -> driver -> run dispatch -> settle correlation -> exit record,
// with the child's own usage attributed into the run ledger.
import { beforeAll, describe, expect, it, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createState } from "../../state.js";
import { registerWorkflowCommand, type WorkflowCommandDeps } from "../../workflow/command.js";
import { releaseWorkflow, reserveWorkflow } from "../../workflow/coordinator.js";
import { createCommandContext, createModelRegistry, createTheme, createUIContext, EMPTY_CHILD_USAGE, runRealChildInvocation, tmpDir } from "../unit/helpers.js";
import { createTestHost, getCommand } from "../unit/test-host.js";
import { isRecord } from "../assertions.js";

const CHILD_COST_USD = 0.25;

// The author's file: one template step, a checkpoint as the safe exit point, then its own exit.
const WORKFLOW = `return defineWorkflow((workflow) => {
  const review = workflow.run("review the diff");
  workflow.checkpoint({ text: review.text });
  return workflow.exit({ reason: "done", text: review.text });
});
`;

function entry(id: string, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-07T00:00:00.000Z", message } satisfies SessionEntry;
}

// The parent branch carries no usage, so every cent in the run's ledger is child-attributed.
function assistantEntry(id: string, text: string, model: string): SessionEntry {
	return entry(id, {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "agentic-e2e-api",
		provider: "agentic-e2e",
		model,
		stopReason: "stop",
		timestamp: 0,
		usage: EMPTY_CHILD_USAGE,
	});
}

/** Headless context: the run records everything and paints nothing. */
function headlessCtx(cwd: string, branch: SessionEntry[]): ExtensionCommandContext {
	const noop = () => undefined;
	const manager = Object.assign(SessionManager.inMemory(cwd), {
		getSessionId: () => "e2e-workflow",
		getLeafId: () => branch.at(-1)?.id ?? null,
		getBranch: () => branch,
		getEntries: () => branch,
		getSessionName: () => undefined,
	});
	return createCommandContext({
		mode: "rpc",
		cwd,
		ui: createUIContext({
			notify: noop,
			setStatus: noop,
			setWidget: noop,
			setFooter: noop,
			setWorkingMessage: noop,
			theme: createTheme({ fg: (_name: string, text: string) => text }),
		}),
		sessionManager: manager,
		modelRegistry: createModelRegistry({ getModelsOfType: () => [], getModelOfType: () => undefined }),
		getContextUsage: () => undefined,
		isIdle: () => true,
		abort: noop,
		newSession: () => Promise.resolve({ cancelled: false }),
	});
}

/** Poll `cond` until true or the deadline passes; the sandbox and child session are async. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
	const stepMs = 10;
	for (let elapsed = 0; elapsed < timeoutMs; elapsed += stepMs) {
		if (cond()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The narrowed `workflow-summary` payload the run persists. */
interface RunSummary {
	workflow: string;
	reason: string;
	steps: number;
	turns: number;
	checkpoints: number;
	spend: { model: string; costUsd: number }[];
	costUsd: number;
}

function runSummaryOf(value: unknown): RunSummary {
	if (!isRecord(value)) {
		throw new Error("expected a workflow-summary payload");
	}
	const spend = Array.isArray(value.spend) ? value.spend.filter(isRecord) : [];
	return {
		workflow: typeof value.workflow === "string" ? value.workflow : "",
		reason: typeof value.reason === "string" ? value.reason : "",
		steps: typeof value.steps === "number" ? value.steps : -1,
		turns: typeof value.turns === "number" ? value.turns : -1,
		checkpoints: typeof value.checkpoints === "number" ? value.checkpoints : -1,
		spend: spend.map((row) => ({
			model: typeof row.model === "string" ? row.model : "",
			costUsd: typeof row.costUsd === "number" ? row.costUsd : 0,
		})),
		costUsd: typeof value.costUsd === "number" ? value.costUsd : -1,
	};
}

interface ScenarioFacts {
	dispatched: string;
	frontmatterPrepared: string[];
	sinkBefore: boolean;
	probeCalls: number;
	observedHasDispatched: boolean;
	expectedText: string;
	failure: unknown;
	exitsData: unknown[];
	hasLimits: boolean;
	summaryCount: number;
	summary: RunSummary;
	childCost: number | undefined;
	totalCost: number | undefined;
	sinkAfter: unknown;
	reserved: boolean;
}

/** Run the full real-sandbox scenario once and return the facts its assertions read. */
async function runScenario(): Promise<ScenarioFacts> {
	const dir = await tmpDir();
	const state = createState();
	const frontmatterPrepared: string[] = [];
	const deps: WorkflowCommandDeps = {
		setReadonly: () => false,
		requestHandoff: (_direction: string, _ctx: ExtensionCommandContext) => Promise.resolve(),
		watchHandoffSettlement: () => ({ done: new Promise<never>(() => undefined), dispose: () => undefined }),
		prepareRunFrontmatter: (text: string) => {
			frontmatterPrepared.push(text);
			return Promise.resolve();
		},
	};
	const pi = await createTestHost((api) => {
		registerWorkflowCommand(api, state, deps);
	});
	// A project prompt template named `review` exists, but a slashless prompt with arguments is
	// prose (never a command), so the run must send it verbatim.
	pi.setCommands([
		{
			name: "review",
			source: "prompt",
			sourceInfo: { path: join(dir, ".pi", "prompts", "review.md"), source: "prompt", scope: "project", origin: "top-level" },
		},
	]);
	const branch: SessionEntry[] = [];
	const ctx = headlessCtx(dir, branch);
	let failure: unknown;
	let reserved = false;
	try {
		await mkdir(join(dir, ".pi", "workflows"), { recursive: true });
		await writeFile(join(dir, ".pi", "workflows", "review-step.js"), WORKFLOW);

		const running = getCommand(pi, "workflow")
			.handler("review-step", ctx)
			.catch((error: unknown) => {
				failure = error;
			});
		await waitFor(() => pi.sentUserMessages.length > 0, "the workflow's run turn to dispatch");
		const sent = pi.sentUserMessages[0]?.content;
		if (typeof sent !== "string") {
			throw new Error("the workflow's run turn must dispatch prose text");
		}
		const dispatched = sent;
		// The live run installed its child-usage sink before the spawn; capture it before the
		// child flushes, so the facts reflect the active run, not the post-run teardown.
		const sinkBefore = state.childUsageSink !== null;

		// A real child session answers the turn. It shares this `state`, so its usage flushes into
		// the sink the live run installed - the same path the spawn tool uses in production.
		const child = await runRealChildInvocation({ prompt: dispatched, state, childCostUsd: CHILD_COST_USD });

		branch.push(entry("e-user", { role: "user", content: dispatched, timestamp: 0 }), assistantEntry("e-turn", child.expectedText, child.modelId));
		for (const handler of pi.handlers.get("agent_settled") ?? []) {
			await handler({}, ctx);
		}
		await running;

		const exits = pi.appendedEntries.filter((record) => record.customType === "workflow-exit");
		const summaries = pi.appendedEntries.filter((record) => record.customType === "workflow-summary");
		const summary = runSummaryOf(summaries[0]?.data);
		const childRow = summary.spend.find((row) => row.model === child.modelId);
		// After the run settled, its release path already freed the reservation; reserving again
		// succeeds and returns true, proving there is no leak, and re-arms it for the next run.
		reserved = reserveWorkflow();
		return {
			dispatched,
			frontmatterPrepared,
			sinkBefore,
			probeCalls: child.probeCalls,
			observedHasDispatched: child.observedMessages.some((text) => text.includes(dispatched)),
			expectedText: child.expectedText,
			failure,
			exitsData: exits.map((record) => record.data),
			hasLimits: pi.appendedEntries.some((record) => record.customType === "workflow-limits"),
			summaryCount: summaries.length,
			summary,
			childCost: childRow?.costUsd,
			totalCost: summary.costUsd,
			sinkAfter: state.childUsageSink,
			reserved,
		};
	} finally {
		if (reserved) {
			releaseWorkflow();
		}
		await rm(dir, { recursive: true, force: true });
	}
}

describe("/workflow runs the real sandbox against a real model turn and attributes its cost", () => {
	let facts: ScenarioFacts;
	beforeAll(async () => {
		facts = await runScenario();
	}, 120_000);

	it("dispatches prose verbatim and settles the turn", () => {
		expect({
			dispatched: facts.dispatched,
			frontmatter: facts.frontmatterPrepared,
			probeCalls: facts.probeCalls,
			observed: facts.observedHasDispatched,
		}).toEqual({
			dispatched: "review the diff",
			frontmatter: ["review the diff"],
			probeCalls: 1,
			observed: true,
		});
		expect(facts.sinkBefore, "the live run owns the child-usage sink the spawn tool writes to").toBe(true);
		expect(facts.failure, `the run must settle without rejecting: ${String(facts.failure)}`).toBeUndefined();
		expect(facts.exitsData).toEqual([{ v: 1, reason: "done", metadata: { reason: "done", text: facts.expectedText } }]);
	});

	it("records the limits decision, one overview, and the child-attributed ledger", () => {
		expect(facts.hasLimits, "the headless no-target start is recorded, never silently unbounded").toBe(true);
		expect(facts.summaryCount, "one overview per run").toBe(1);
		expect(facts.summary).toMatchObject({ workflow: "review-step", reason: "done", steps: 1, turns: 1, checkpoints: 1 });
		expect(facts.childCost ?? -1, `the child turn must cost at least ${CHILD_COST_USD}`).toBeGreaterThanOrEqual(CHILD_COST_USD);
		expect(facts.totalCost, "all of the run's cost is child-attributed spend").toBe(facts.childCost);
	});

	it("uninstalls the run's sink and releases the process-wide reservation", () => {
		expect(facts.sinkAfter, "the disposed run uninstalls its sink").toBeNull();
		expect(facts.reserved, "the run released the process-wide reservation").toBe(true);
	});
});

// A checkpoint-only workflow: no model turns, so the run is fast and fully deterministic.
const BACKSTOP_WORKFLOW = `return defineWorkflow((workflow) => {
  workflow.checkpoint({});
  workflow.exit({ reason: "done", text: "ok" });
});
`;

// WHY: a run that dies before its cleanup (a bypassed finally) must never poison the next
// run. This poisons the two run-state slots the way a crashed run would leave them and
// runs a checkpoint-only workflow through the real command and sandbox; the openRun
// backstop must clear them so the fresh run completes with clean state. The run registry is
// no longer a shared slot: the host owns and disposes it, so it cannot leak across runs.
test("a poisoned prior run never blocks the next run", { timeout: 60_000 }, async () => {
	const dir = await tmpDir();
	const state = createState();
	const deps: WorkflowCommandDeps = {
		setReadonly: () => false,
		requestHandoff: (_direction: string, _ctx: ExtensionCommandContext) => Promise.resolve(),
		watchHandoffSettlement: () => ({ done: new Promise<never>(() => undefined), dispose: () => undefined }),
		prepareRunFrontmatter: (_text: string, _ctx: ExtensionCommandContext) => Promise.resolve(),
	};
	state.inputSuppressed = true;
	state.childUsageSink = () => undefined;
	const pi = await createTestHost((api) => {
		registerWorkflowCommand(api, state, deps);
	});
	try {
		await mkdir(join(dir, ".pi", "workflows"), { recursive: true });
		await writeFile(join(dir, ".pi", "workflows", "backstop-step.js"), BACKSTOP_WORKFLOW);
		await getCommand(pi, "workflow").handler("backstop-step", headlessCtx(dir, []));

		expect(state.inputSuppressed, "input ends usable").toBe(false);
		expect(state.childUsageSink, "no sink survives the run").toBeNull();
		const exits = pi.appendedEntries.filter((record) => record.customType === "workflow-exit");
		expect(exits.map((record) => record.data)).toEqual([{ v: 1, reason: "done", metadata: { reason: "done", text: "ok" } }]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
