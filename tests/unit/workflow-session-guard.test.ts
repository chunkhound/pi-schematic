// WHY: pi dispatches `/new`, `/resume`, `/fork`, `/tree` and `/compact` before the `input`
// hook, so input suppression cannot exclude them and a lifecycle command interleaves with a
// running workflow (PR #72 review 4288158717: `new_session` over RPC replaced the session under
// a live run and left it with no exit record). These tests pin the session-boundary guard
// through the real extension API: every boundary cancels while a run owns the session, only the
// run's own `workflow.new` and `workflow.handoff` pass on their admission grant, pi's own
// capacity compactions stay allowed, and a finished run releases the guard.
// Rule: docs/workflows.md (Constraints: session boundaries; Host gaps: residual windows).
import assert from "node:assert/strict";
import test from "node:test";
import type { CodemodeResult, CodemodeSandbox, CodemodeTool } from "@earendil-works/pi-codemode";
import type { ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createState, type SchematicState } from "../../state.js";
import { registerWorkflowCommand, type WorkflowCommandDeps } from "../../workflow/command.js";
import { publishWorkflowRuntime } from "../../workflow/coordinator.js";
import { emitAll } from "./helpers.js";
import { createTestHost, type TestPI } from "./test-host.js";

/** One-shot promise with an external resolve, so the harness can park and release one effect. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => { resolve = finish; });
	return { promise, resolve };
}

/** Checkpoint-less fixture: no budget dialog, so the command reaches the sandbox at once. */
const UNBOUNDED = "tests/e2e/fixtures/command-no-checkpoint.js";
const OK_RESULT = { ok: true, value: undefined, output: [], calls: [], storeWrites: { set: {}, delete: [] } } as unknown as CodemodeResult;

/** Verdict of one boundary dispatch: `{ cancel: true }` when the guard stopped it. */
type Verdict = { cancel: true } | undefined;

/** Every boundary the guard owns, with the phrase its notice must show. */
const BOUNDARIES: Array<{ type: string; event: Record<string, unknown>; label: RegExp }> = [
	{ type: "session_before_switch", event: { reason: "new" }, label: /start a new session/ },
	{ type: "session_before_switch", event: { reason: "resume" }, label: /switch session/ },
	{ type: "session_before_fork", event: {}, label: /fork this session/ },
	{ type: "session_before_tree", event: {}, label: /move in the session tree/ },
	{ type: "session_before_compact", event: { reason: "manual" }, label: /compact this session/ },
];

/** Recorders the session seams of one parked run write into. */
interface RunRecord {
	notices: string[];
	/** What the guard answered each session change the workflow itself asked for, in order. */
	grants: Verdict[];
}

/** The context pi hands to `withSession`; the package root does not re-export its type. */
type ReplacedCtx = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>>[0];

/** Replacement runtime a `workflow.new` rebinds to; `competingResume` scripts a `/resume`
 * boundary on the old runtime before the workflow's own `new` switch. */
interface Replacement {
	pi: TestPI;
	state: SchematicState;
	ctx: ReplacedCtx;
	competingResume: boolean;
}

interface ParkedRun extends RunRecord {
	pi: TestPI;
	state: SchematicState;
	replacement?: Replacement;
	/** Invoke one handle the way the sandbox does: the real guarded `execute`. */
	handle(name: string, args?: unknown): Promise<unknown>;
	/** Finish the parked sandbox call, so the run ends and releases the guard. */
	release(): void;
	finished: Promise<void>;
}

/**
 * Dispatch one session-boundary event the way pi's `ExtensionRunner` does: run the registered
 * `session_before_*` handlers in order and short-circuit on the first `cancel`.
 */
async function boundary(pi: TestPI, type: string, event: Record<string, unknown>, record: RunRecord, notifyThrows = false): Promise<Verdict> {
	const handlers = pi.handlers.get(type);
	assert.ok(handlers?.length, `no handler is registered for ${type}`);
	for (const handler of handlers) {
		const verdict = (await handler({ type, ...event }, boundaryCtx(record.notices, notifyThrows))) as Verdict;
		if (verdict?.cancel) return verdict;
	}
	return undefined;
}

/** Boundary handler context: pi builds it from the live session, never from the command context
 * that started the run, so the operator's notice lands here. */
function boundaryCtx(notices: string[], notifyThrows = false): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			notify: (message: string) => {
				if (notifyThrows) throw new Error("the UI is gone");
				notices.push(message);
			},
		},
	} as unknown as ExtensionContext;
}

/** Headless command context for the parked run, plus the `workflow.new` seam: mirror pi's order
 * (ask the guard, then honour its verdict) and report the switch as cancelled when the guard
 * blocked it. A cancellation is reported either way, so the test reads the verdict instead of
 * rebuilding a whole session; an admitted switch rebinds to the published replacement runtime. */
function runCtx(pi: TestPI, record: RunRecord, deps: WorkflowCommandDeps, replacement?: Replacement): ExtensionCommandContext {
	const branch: SessionEntry[] = [];
	const noop = (): void => {};
	return {
		hasUI: false,
		mode: "rpc",
		cwd: process.cwd(),
		ui: { notify: noop, setStatus: noop, setWidget: noop, setFooter: noop, setWorkingMessage: noop, theme: { fg: (_name: string, text: string) => text } },
		sessionManager: {
			getSessionId: () => "guard-test",
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionName: () => undefined,
		},
		modelRegistry: { getModelsOfType: () => [], getModelOfType: () => undefined },
		getContextUsage: () => null,
		isIdle: () => true,
		abort: noop,
		newSession: async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
			// A competing `/resume` has no grant, so it must cancel without spending the `new` one.
			if (replacement?.competingResume) record.grants.push(await boundary(pi, "session_before_switch", { reason: "resume" }, record));
			const verdict = await boundary(pi, "session_before_switch", { reason: "new" }, record);
			record.grants.push(verdict);
			if (verdict?.cancel || !replacement) return { cancelled: true };
			publishWorkflowRuntime(replacement.ctx.sessionManager.getSessionId(), {
				pi: replacement.pi,
				state: replacement.state,
				setReadonly: deps.setReadonly,
				requestHandoff: deps.requestHandoff,
				prepareRunFrontmatter: deps.prepareRunFrontmatter,
			});
			await options?.withSession?.(replacement.ctx);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
}

/**
 * Start a real run and park it inside its sandbox call, so the run owns the session while the
 * test drives boundaries. `handoffCompactions` repeats the requested compaction inside one
 * handoff grant window, which stays open until the handle ends.
 */
async function parkRun(handoffCompactions = 1, replacementSpec?: { competingResume?: boolean }): Promise<ParkedRun> {
	const state = createState();
	const record: RunRecord = { notices: [], grants: [] };
	const parked = deferred<CodemodeResult>();
	const armed = deferred<CodemodeTool[]>();
	let pi!: TestPI;
	const deps: WorkflowCommandDeps = {
		setReadonly: () => false,
		prepareRunFrontmatter: async () => {},
		handoffTimeoutMs: 5_000,
		// `workflow.handoff` seam: dispatch the requested compaction(s) through the guard, then
		// report the compaction failed, so the handle ends and its grant window closes.
		requestHandoff: async () => {
			for (let index = 0; index < handoffCompactions; index += 1) {
				record.grants.push(await boundary(pi, "session_before_compact", { reason: "manual" }, record));
			}
			await emitAll(pi, "session_compact_failed", { reason: "manual", aborted: false, errorMessage: "scripted compaction failure" }, boundaryCtx(record.notices));
		},
		sandboxFactory: (sandboxOptions) => {
			armed.resolve(sandboxOptions.globals ?? []);
			return { execute: () => parked.promise, close: async () => {} } as unknown as CodemodeSandbox;
		},
	};
	let replacement: Replacement | undefined;
	if (replacementSpec) {
		const replacementState = createState();
		const replacementPi = await createTestHost((api) => registerWorkflowCommand(api, replacementState, deps));
		const replacementCtx = {
			hasUI: false,
			mode: "rpc",
			cwd: process.cwd(),
			ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setFooter: () => {}, setWorkingMessage: () => {}, theme: { fg: (_name: string, text: string) => text } },
			sessionManager: { getSessionId: () => "guard-rebound", getLeafId: () => null, getBranch: () => [], getEntries: () => [], getSessionName: () => undefined },
			getContextUsage: () => null,
			sendMessage: () => {},
			sendUserMessage: () => {},
		} as unknown as ReplacedCtx;
		replacement = { pi: replacementPi, state: replacementState, ctx: replacementCtx, competingResume: replacementSpec.competingResume ?? false };
	}
	pi = await createTestHost((api) => registerWorkflowCommand(api, state, deps));
	const finished = pi.commands.get("workflow")!.handler(UNBOUNDED, runCtx(pi, record, deps, replacement)) as Promise<void>;
	// The sandbox factory runs after the armed suppression, so this await proves the run owns the session.
	const globals = await armed.promise;
	assert.equal(state.inputSuppressed, true, "the parked run owns the session");
	return {
		pi, ...record, state, replacement, finished,
		handle: async (name, args = []) => {
			const tool = globals.find((candidate) => candidate.name === name);
			assert.ok(tool, `no handle ${name}`);
			return tool.execute(args, { signal: new AbortController().signal });
		},
		release: () => parked.resolve(OK_RESULT),
	};
}

/** Run one guard test with a parked run. `t.after` finishes the run even when an assertion fails,
 * so a guard regression cannot leak the run ticker and hang the test process. */
function parkedRunTest(name: string, body: (run: ParkedRun) => Promise<void>, handoffCompactions = 1, replacementSpec?: { competingResume?: boolean }): void {
	test(name, async (t) => {
		const run = await parkRun(handoffCompactions, replacementSpec);
		t.after(async () => {
			run.release();
			await run.finished;
		});
		await body(run);
	});
}

parkedRunTest("every session boundary cancels while a run owns the session", async (run) => {
	for (const { type, event, label } of BOUNDARIES) {
		assert.deepEqual(await boundary(run.pi, type, event, run), { cancel: true }, type);
		assert.match(run.notices.at(-1) ?? "", label, type);
		assert.match(run.notices.at(-1) ?? "", /Escape or Ctrl\+C twice/, type);
	}
	assert.equal(run.grants.length, 0, "nothing the workflow asked for was admitted here");
});

parkedRunTest("pi's own threshold and overflow compactions stay allowed during a run", async (run) => {
	for (const reason of ["threshold", "overflow"]) {
		assert.equal(await boundary(run.pi, "session_before_compact", { reason }, run), undefined, reason);
	}
	assert.equal(run.notices.length, 0, "an admitted compaction notifies nothing");
});

parkedRunTest("an unrecognised compaction reason fails closed during a run", async (run) => {
	assert.deepEqual(await boundary(run.pi, "session_before_compact", {}, run), { cancel: true });
});

parkedRunTest("a failing notice cannot let the boundary through", async (run) => {
	assert.deepEqual(await boundary(run.pi, "session_before_switch", { reason: "new" }, run, true), { cancel: true });
});

parkedRunTest("workflow.new is admitted by the guard and spends its grant", async (run) => {
	await assert.rejects(run.handle("workflow.new"), /new session was cancelled/);
	assert.deepEqual(run.grants, [undefined], "the run's own switch passed the guard");
	assert.deepEqual(await boundary(run.pi, "session_before_compact", { reason: "manual" }, run), { cancel: true }, "the spent grant cannot be reused");
});

parkedRunTest("workflow.handoff is admitted by the guard for exactly one compaction", async (run) => {
	await assert.rejects(run.handle("workflow.handoff", "next"), /scripted compaction failure/);
	assert.deepEqual(run.grants, [undefined], "the run's own compaction passed the guard");
	assert.deepEqual(await boundary(run.pi, "session_before_switch", { reason: "new" }, run), { cancel: true }, "a closed grant blocks again");
});

parkedRunTest("a second compaction inside one handoff grant is a boundary, not the workflow's own", async (run) => {
	await assert.rejects(run.handle("workflow.handoff", "next"), /scripted compaction failure/);
	assert.deepEqual(run.grants, [undefined, { cancel: true }], "one grant admits one change");
}, 2);

parkedRunTest("a successful workflow.new re-arms the guard and a competing /resume cannot spend its grant", async (run) => {
	assert.ok(run.replacement);
	await run.handle("workflow.new");
	assert.deepEqual(run.grants, [{ cancel: true }, undefined], "the competing resume cancels; the workflow's own new passes");
	assert.equal(run.replacement.state.inputSuppressed, true, "the replacement state owns the session");
	assert.equal(run.state.inputSuppressed, false, "the old state was released");
	assert.deepEqual(await boundary(run.replacement.pi, "session_before_fork", {}, run), { cancel: true }, "the replacement guard cancels");
	assert.match(run.notices.at(-1) ?? "", /fork this session/);
}, 1, { competingResume: true });

parkedRunTest("a finished run releases the guard", async (run) => {
	run.release();
	await run.finished;
	assert.equal(run.state.inputSuppressed, false, "the run released the session");
	for (const { type, event } of BOUNDARIES) {
		assert.equal(await boundary(run.pi, type, event, run), undefined, type);
	}
});

parkedRunTest("a cancelled boundary leaves the session state unchanged", async (run) => {
	// Record session state before the boundary
	const stateBefore = {
		inputSuppressed: run.state.inputSuppressed,
		readonlyEnabled: run.state.readonlyEnabled,
		activeNotebookTopic: run.state.activeNotebookTopic,
	};
	// Dispatch a boundary that should be cancelled
	await boundary(run.pi, "session_before_fork", {}, run);
	// Verify session state is unchanged
	assert.equal(run.state.inputSuppressed, stateBefore.inputSuppressed, "inputSuppressed unchanged");
	assert.equal(run.state.readonlyEnabled, stateBefore.readonlyEnabled, "readonlyEnabled unchanged");
	assert.equal(run.state.activeNotebookTopic, stateBefore.activeNotebookTopic, "activeNotebookTopic unchanged");
});

test("boundaries stay open while no workflow runs", async () => {
	const record: RunRecord = { notices: [], grants: [] };
	const pi = await createTestHost((api) => {
		registerWorkflowCommand(api, createState(), {
			setReadonly: () => false,
			requestHandoff: async () => {},
			prepareRunFrontmatter: async () => {},
		} satisfies WorkflowCommandDeps);
	});
	for (const { type, event } of BOUNDARIES) {
		assert.equal(await boundary(pi, type, event, record), undefined, type);
	}
	assert.equal(record.notices.length, 0, "an idle session is never interrupted by the guard");
});
