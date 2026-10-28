// WHY: a workflow owns serial agent turns. pi runs an extension command even while the
// session streams, so a mid-turn `/workflow` must be rejected BEFORE it reserves the run or
// opens a budget dialog. Otherwise its first `workflow.run` dispatches into a busy session,
// where `sendUserMessage` throws and the fire-and-forget wrapper swallows it, hanging the run.
// These tests pin the rejection and prove it leaks neither the reservation nor the next start.
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodemodeResult, CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { registerWorkflowCommand, type WorkflowCommandDeps } from "../../workflow/command.js";
import { releaseWorkflow, reserveWorkflow } from "../../workflow/coordinator.js";
import { WORKFLOW_ERROR_ENTRY_TYPE, WORKFLOW_EXIT_ENTRY_TYPE } from "../../workflow/types.js";
import { createTestHost } from "./test-host.js";

/** Committed fixture: the command reads and compiles it; the sandbox seam never runs its source. */
const RETURN_WORKFLOW = "tests/e2e/fixtures/command-return.js";
const OK_RESULT = { ok: true, value: undefined, output: [], calls: [], storeWrites: { set: {}, delete: [] } } as unknown as CodemodeResult;

/** Headless command context; `busy` is the only knob the busy guard reads. */
function headlessCtx(getIdle: () => boolean, cwd = process.cwd()): ExtensionCommandContext {
	const branch: SessionEntry[] = [];
	const noop = (): void => {};
	return {
		hasUI: false,
		mode: "rpc",
		cwd,
		ui: { notify: noop, setStatus: noop, setWidget: noop, setFooter: noop, setWorkingMessage: noop, theme: { fg: (_name: string, text: string) => text } },
		sessionManager: {
			getSessionId: () => "busy-test",
			getLeafId: () => null,
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionName: () => undefined,
		},
		modelRegistry: { getModelsOfType: () => [], getModelOfType: () => undefined },
		getContextUsage: () => null,
		isIdle: getIdle,
		abort: noop,
		newSession: async () => ({ cancelled: false }),
	} as unknown as ExtensionCommandContext;
}

/** A deps set whose sandbox seam counts builds; every other effect is a silent no-op. */
function countingDeps(onBuild: () => void): WorkflowCommandDeps {
	return {
		setReadonly: () => false,
		requestHandoff: async () => {},
		watchHandoffSettlement: () => ({ done: new Promise<never>(() => {}), dispose: () => {} }),
		prepareRunFrontmatter: async () => {},
		sandboxFactory: () => {
			onBuild();
			return { execute: async () => OK_RESULT, close: async () => {} } as unknown as CodemodeSandbox;
		},
	};
}

test("/workflow on a busy session is rejected before it reserves or builds a sandbox", async () => {
	const state = createState();
	let sandboxes = 0;
	const pi = await createTestHost((api) => registerWorkflowCommand(api, state, countingDeps(() => { sandboxes += 1; })));

	await pi.commands.get("workflow")!.handler(RETURN_WORKFLOW, headlessCtx(() => false));

	assert.equal(sandboxes, 0, "a busy start builds no sandbox");
	assert.equal(pi.sentUserMessages.length, 0, "a busy start dispatches no run turn");
	const errors = pi.appendedEntries.filter((entry) => entry.customType === WORKFLOW_ERROR_ENTRY_TYPE).map((entry) => entry.data as { phase: string; error: string });
	assert.equal(errors.length, 1, "the rejection is recorded in the transcript");
	assert.equal(errors[0].phase, "start");
	assert.match(errors[0].error, /busy/i);
	// A leaked reservation would make the next start fail as a second-run rejection.
	assert.equal(reserveWorkflow(), true, "a rejected busy start leaves no reservation");
	releaseWorkflow();
});

test("a discovery error is reported through the start-failure path", { skip: process.platform === "win32" }, async () => {
	const state = createState();
	const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-discovery-"));
	const agentDir = await mkdtemp(join(tmpdir(), "pi-workflow-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
		await chmod(join(cwd, ".pi", "workflows"), 0o000);
		const pi = await createTestHost((api) => registerWorkflowCommand(api, state, countingDeps(() => {})));
		await pi.commands.get("workflow")!.handler("missing", headlessCtx(() => true, cwd));
		const errors = pi.appendedEntries
			.filter((entry) => entry.customType === WORKFLOW_ERROR_ENTRY_TYPE)
			.map((entry) => entry.data as { phase: string; error: string });
		assert.equal(errors.length, 1, "the failure is recorded instead of a rejected command");
		assert.equal(errors[0]!.phase, "start");
		assert.match(errors[0]!.error, /Cannot (list|resolve) workflow/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await chmod(join(cwd, ".pi", "workflows"), 0o700).catch(() => {});
		await Promise.all([rm(cwd, { recursive: true, force: true }), rm(agentDir, { recursive: true, force: true })]);
	}
});

test("a rejected busy start does not block the next idle start", async () => {
	const state = createState();
	let sandboxes = 0;
	const pi = await createTestHost((api) => registerWorkflowCommand(api, state, countingDeps(() => { sandboxes += 1; })));

	await pi.commands.get("workflow")!.handler(RETURN_WORKFLOW, headlessCtx(() => false));
	await pi.commands.get("workflow")!.handler(RETURN_WORKFLOW, headlessCtx(() => true));

	assert.equal(sandboxes, 1, "only the idle start builds a sandbox");
	const exits = pi.appendedEntries.filter((entry) => entry.customType === WORKFLOW_EXIT_ENTRY_TYPE).map((entry) => entry.data as { reason: string });
	assert.equal(exits.length, 1, "the idle start runs to its exit record");
	assert.equal(exits[0].reason, "returned");
	assert.equal(reserveWorkflow(), true, "the run released the process-wide reservation");
	releaseWorkflow();
});
