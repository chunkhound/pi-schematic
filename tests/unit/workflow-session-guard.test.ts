// WHY: pi dispatches `/new`, `/resume`, `/fork`, `/tree` and `/compact` before the `input`
// hook, so input suppression cannot exclude them and a lifecycle command interleaves with a
// running workflow (PR #72 review 4288158717: `new_session` over RPC replaced the session under
// a live run and left it with no exit record). These tests pin the session-boundary guard
// through the real extension API: every boundary cancels while a run owns the session, only the
// run's own `workflow.new` passes on its admission grant, `workflow.handoff` crosses no
// boundary at all, pi's own capacity compactions stay allowed, and a finished run releases
// the guard.
// Rule: docs/workflows.md (Constraints: session boundaries; Host gaps: residual windows).
import { expect, test } from "vitest";
import { CodemodeSandbox, type CodemodeResult, type CodemodeTool } from "@earendil-works/pi-codemode";
import { SessionManager, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createState, type SchematicState } from "../../state.js";
import { registerWorkflowCommand, type WorkflowCommandDeps } from "../../workflow/command.js";
import { publishWorkflowRuntime } from "../../workflow/coordinator.js";
import { createCommandContext, createExtensionContext, createModelRegistry, createTheme, createUIContext } from "./helpers.js";
import { createTestHost, type TestPI } from "./test-host.js";

/** One-shot promise with an external resolve, so the harness can park and release one effect. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

/** Checkpoint-less fixture: no budget dialog, so the command reaches the sandbox at once. */
const UNBOUNDED = "tests/e2e/fixtures/command-no-checkpoint.js";
const OK_RESULT: CodemodeResult = { ok: true, value: undefined, output: [], calls: [], storeWrites: { set: {}, delete: [] } };

/** Verdict of one boundary dispatch: `{ cancel: true }` when the guard stopped it. */
type Verdict = { cancel: true } | undefined;

/** Every boundary the guard owns, with the phrase its notice must show and a title fragment. */
const BOUNDARIES: { type: string; event: Record<string, unknown>; label: RegExp; name: string }[] = [
	{ type: "session_before_switch", event: { reason: "new" }, label: /start a new session/, name: "new session" },
	{ type: "session_before_switch", event: { reason: "resume" }, label: /switch session/, name: "resume" },
	{ type: "session_before_fork", event: {}, label: /fork this session/, name: "fork" },
	{ type: "session_before_tree", event: {}, label: /move in the session tree/, name: "session tree" },
	{ type: "session_before_compact", event: { reason: "manual" }, label: /compact this session/, name: "manual compact" },
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
	requirePresent(handlers, `no handler is registered for ${type}`);
	for (const handler of handlers) {
		const verdict = toVerdict(await handler({ type, ...event }, boundaryCtx(record.notices, notifyThrows)));
		if (verdict?.cancel) {
			return verdict;
		}
	}
	return undefined;
}

/** `value` as its non-null type; throws `message` when it is null or undefined. */
function requirePresent<T>(value: T | null | undefined, message: string): asserts value is T {
	if (value === null || value === undefined) {
		throw new Error(message);
	}
}

/** Narrow an untyped handler result to a `Verdict`; only a truthy `{ cancel: true }` is one. */
function toVerdict(value: unknown): Verdict {
	if (value !== null && typeof value === "object" && "cancel" in value && value.cancel === true) {
		return { cancel: true };
	}
	return undefined;
}

/** Boundary handler context: pi builds it from the live session, never from the command context
 * that started the run, so the operator's notice lands here. */
function boundaryCtx(notices: string[], notifyThrows = false): ExtensionContext {
	return createExtensionContext({
		hasUI: true,
		ui: createUIContext({
			notify: (message: string) => {
				if (notifyThrows) {
					throw new Error("the UI is gone");
				}
				notices.push(message);
			},
		}),
	});
}

// The methods `SessionManager` declares.
const SESSION_MANAGER_METHODS = new Set(Object.getOwnPropertyNames(SessionManager.prototype).filter((name) => name !== "constructor"));

/** A session manager whose session seams read `branch` and `sessionId`; any other method throws naming it. */
function parkedSessionManager(branch: SessionEntry[], sessionId = "guard-test"): SessionManager {
	return new Proxy(SessionManager.inMemory(), {
		get(_manager, property, receiver) {
			if (property === "getSessionId") {
				return () => sessionId;
			}
			if (property === "getLeafId") {
				return () => branch.at(-1)?.id ?? null;
			}
			if (property === "getBranch") {
				return () => branch;
			}
			if (property === "getEntries") {
				return () => branch;
			}
			if (property === "getSessionName") {
				return () => undefined;
			}
			if (typeof property === "string" && SESSION_MANAGER_METHODS.has(property)) {
				return () => {
					throw new Error(`ctx.sessionManager.${property} is not stubbed in this test context; only the parked-run seams are.`);
				};
			}
			const value: unknown = Reflect.get(SessionManager.inMemory(), property, receiver);
			return value;
		},
	});
}

/** A `CodemodeSandbox` whose `members` are its own; any other member throws naming it. */
function stubSandbox(members: Partial<CodemodeSandbox>): CodemodeSandbox {
	const candidate: unknown = Object.create(CodemodeSandbox.prototype);
	if (!(candidate instanceof CodemodeSandbox)) {
		throw new Error("could not build a sandbox stub");
	}
	return Object.assign(candidate, members);
}

/** Headless command context for the parked run, plus the `workflow.new` seam: mirror pi's order
 * (ask the guard, then honour its verdict) and report the switch as cancelled when the guard
 * blocked it. A cancellation is reported either way, so the test reads the verdict instead of
 * rebuilding a whole session; an admitted switch rebinds to the published replacement runtime. */
function runCtx(pi: TestPI, record: RunRecord, deps: WorkflowCommandDeps, replacement?: Replacement): ExtensionCommandContext {
	const branch: SessionEntry[] = [];
	const noop = (): void => undefined;
	return createCommandContext({
		hasUI: false,
		mode: "rpc",
		cwd: process.cwd(),
		ui: createUIContext({
			notify: noop,
			setStatus: noop,
			setWidget: noop,
			setFooter: noop,
			setWorkingMessage: noop,
			theme: createTheme({ fg: (_name: string, text: string) => text }),
		}),
		sessionManager: parkedSessionManager(branch),
		modelRegistry: createModelRegistry({ getModelsOfType: () => [], getModelOfType: () => undefined }),
		getContextUsage: () => undefined,
		isIdle: () => true,
		abort: noop,
		newSession: async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
			// A competing `/resume` has no grant, so it must cancel without spending the `new` one.
			if (replacement?.competingResume === true) {
				record.grants.push(await boundary(pi, "session_before_switch", { reason: "resume" }, record));
			}
			const verdict = await boundary(pi, "session_before_switch", { reason: "new" }, record);
			record.grants.push(verdict);
			if (verdict?.cancel || !replacement) {
				return { cancelled: true };
			}
			publishWorkflowRuntime(replacement.ctx.sessionManager.getSessionId(), {
				pi: replacement.pi,
				state: replacement.state,
				rebindDeps: (current) => ({
					...current,
					setReadonly: (enabled) => deps.setReadonly(enabled),
					requestHandoff: (direction, ctx) => deps.requestHandoff(direction, ctx),
					watchHandoffSettlement: () => ({ done: new Promise<never>(() => undefined), dispose: () => undefined }),
					prepareRunFrontmatter: (text, ctx) => deps.prepareRunFrontmatter(text, ctx),
				}),
			});
			await options?.withSession?.(replacement.ctx);
			return { cancelled: false };
		},
	});
}

/**
 * Start a real run and park it inside its sandbox call, so the run owns the session while the
 * test drives boundaries.
 */
async function parkRun(replacementSpec?: { competingResume?: boolean }): Promise<ParkedRun> {
	const state = createState();
	const record: RunRecord = { notices: [], grants: [] };
	const parked = deferred<CodemodeResult>();
	const armed = deferred<CodemodeTool[]>();
	const deps: WorkflowCommandDeps = {
		setReadonly: () => false,
		prepareRunFrontmatter: () => Promise.resolve(),
		handoffTimeoutMs: 5_000,
		// `workflow.handoff` seam: the boundary crosses no session boundary, so it records no
		// grant and the settlement resolves complete.
		requestHandoff: () => Promise.resolve(),
		watchHandoffSettlement: () => ({ done: Promise.resolve({ status: "complete" as const, handoffId: "handoff-1", reason: null }), dispose: () => undefined }),
		sandboxFactory: (sandboxOptions) => {
			armed.resolve(sandboxOptions.globals ?? []);
			return stubSandbox({ execute: () => parked.promise, close: () => Promise.resolve() });
		},
	};
	let replacement: Replacement | undefined;
	if (replacementSpec) {
		const replacementState = createState();
		const replacementPi = await createTestHost((api) => {
			registerWorkflowCommand(api, replacementState, deps);
		});
		const replacementCtx: ReplacedCtx = Object.assign(
			createCommandContext({
				hasUI: false,
				mode: "rpc",
				cwd: process.cwd(),
				ui: createUIContext({
					notify: () => undefined,
					setStatus: () => undefined,
					setWidget: () => undefined,
					setFooter: () => undefined,
					setWorkingMessage: () => undefined,
					theme: createTheme({ fg: (_name: string, text: string) => text }),
				}),
				sessionManager: parkedSessionManager([], "guard-rebound"),
				getContextUsage: () => undefined,
			}),
			{ sendMessage: () => Promise.resolve(), sendUserMessage: () => Promise.resolve() },
		);
		replacement = { pi: replacementPi, state: replacementState, ctx: replacementCtx, competingResume: replacementSpec.competingResume ?? false };
	}
	const pi = await createTestHost((api) => {
		registerWorkflowCommand(api, state, deps);
	});
	const workflowCommand = pi.commands.get("workflow");
	requirePresent(workflowCommand, "the workflow command is registered");
	const finished = workflowCommand.handler(UNBOUNDED, runCtx(pi, record, deps, replacement));
	// The sandbox factory runs after the armed suppression, so this await proves the run owns the session.
	const globals = await armed.promise;
	expect(state.inputSuppressed, "the parked run owns the session").toBe(true);
	return {
		pi,
		...record,
		state,
		replacement,
		finished,
		handle: (name, args = []) => {
			const tool = globals.find((candidate) => candidate.name === name);
			requirePresent(tool, `no handle ${name}`);
			return Promise.resolve(tool.execute(args, { signal: new AbortController().signal }));
		},
		release: () => {
			parked.resolve(OK_RESULT);
		},
	};
}

/** End a parked run after the test, even when an assertion fails, so a guard regression cannot
 * leak the run ticker and hang the test process. */
function releaseAfter(t: { onTestFinished(fn: () => void | Promise<void>): void }, run: ParkedRun): void {
	t.onTestFinished(async () => {
		run.release();
		await run.finished;
	});
}

for (const { type, event, label, name } of BOUNDARIES) {
	test(`while a run owns the session, the ${name} boundary cancels`, async (t) => {
		const run = await parkRun();
		releaseAfter(t, run);
		expect(await boundary(run.pi, type, event, run)).toStrictEqual({ cancel: true });
		expect(run.notices.at(-1) ?? "").toMatch(label);
		expect(run.notices.at(-1) ?? "").toMatch(/Escape or Ctrl\+C twice/);
	});
}

test("nothing the workflow asked for is admitted while a run owns the session", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	expect(run.grants.length, "nothing the workflow asked for was admitted here").toBe(0);
});

test("pi's own threshold and overflow compactions stay allowed during a run", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	for (const reason of ["threshold", "overflow"]) {
		expect(await boundary(run.pi, "session_before_compact", { reason }, run)).toBeUndefined();
	}
	expect(run.notices.length, "an admitted compaction notifies nothing").toBe(0);
});

test("an unrecognised compaction reason fails closed during a run", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	expect(await boundary(run.pi, "session_before_compact", {}, run)).toStrictEqual({ cancel: true });
});

test("a failing notice cannot let the boundary through", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	expect(await boundary(run.pi, "session_before_switch", { reason: "new" }, run, true)).toStrictEqual({ cancel: true });
});

test("workflow.new is admitted by the guard and spends its grant", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	await expect(run.handle("workflow.new")).rejects.toThrow(/new session was cancelled/);
	expect(run.grants, "the run's own switch passed the guard").toStrictEqual([undefined]);
	expect(await boundary(run.pi, "session_before_compact", { reason: "manual" }, run), "the spent grant cannot be reused").toStrictEqual({ cancel: true });
});

test("workflow.handoff crosses no session boundary and spends no grant", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	await run.handle("workflow.handoff", "next");
	expect(run.grants, "the turn_end boundary writes its entries without a session change").toStrictEqual([]);
	expect(await boundary(run.pi, "session_before_compact", { reason: "manual" }, run), "a manual compaction during the run still cancels").toStrictEqual({
		cancel: true,
	});
});

test("a successful workflow.new re-arms the guard and admits the replacement state", async (t) => {
	const run = await parkRun({ competingResume: true });
	releaseAfter(t, run);
	requirePresent(run.replacement, "expected a replacement run");
	await run.handle("workflow.new");
	expect(run.grants, "the competing resume cancels; the workflow's own new passes").toStrictEqual([{ cancel: true }, undefined]);
	expect(run.replacement.state.inputSuppressed, "the replacement state owns the session").toBe(true);
	expect(run.state.inputSuppressed, "the old state was released").toBe(false);
});

test("a successful workflow.new re-arms the guard against later boundaries", async (t) => {
	const run = await parkRun({ competingResume: true });
	releaseAfter(t, run);
	requirePresent(run.replacement, "expected a replacement run");
	await run.handle("workflow.new");
	expect(await boundary(run.replacement.pi, "session_before_fork", {}, run), "the replacement guard cancels").toStrictEqual({ cancel: true });
	expect(run.notices.at(-1) ?? "").toMatch(/fork this session/);
});

test("a finished run releases the guard", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	run.release();
	await run.finished;
	expect(run.state.inputSuppressed, "the run released the session").toBe(false);
	for (const { type, event } of BOUNDARIES.slice(0, 3)) {
		expect(await boundary(run.pi, type, event, run)).toBeUndefined();
	}
});

test("a finished run leaves every boundary open", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	run.release();
	await run.finished;
	for (const { type, event } of BOUNDARIES.slice(3)) {
		expect(await boundary(run.pi, type, event, run)).toBeUndefined();
	}
});

test("a cancelled boundary leaves the session state unchanged", async (t) => {
	const run = await parkRun();
	releaseAfter(t, run);
	// Record session state before the boundary
	const stateBefore = {
		inputSuppressed: run.state.inputSuppressed,
		readonlyEnabled: run.state.readonlyEnabled,
		activeNotebookTopic: run.state.activeNotebookTopic,
	};
	// Dispatch a boundary that should be cancelled
	await boundary(run.pi, "session_before_fork", {}, run);
	// Verify session state is unchanged
	expect(run.state.inputSuppressed, "inputSuppressed unchanged").toBe(stateBefore.inputSuppressed);
	expect(run.state.readonlyEnabled, "readonlyEnabled unchanged").toBe(stateBefore.readonlyEnabled);
	expect(run.state.activeNotebookTopic, "activeNotebookTopic unchanged").toBe(stateBefore.activeNotebookTopic);
});

test("boundaries stay open while no workflow runs", async () => {
	const record: RunRecord = { notices: [], grants: [] };
	const pi = await createTestHost((api) => {
		registerWorkflowCommand(api, createState(), {
			setReadonly: () => false,
			requestHandoff: () => Promise.resolve(),
			watchHandoffSettlement: () => ({ done: new Promise<never>(() => undefined), dispose: () => undefined }),
			prepareRunFrontmatter: () => Promise.resolve(),
		} satisfies WorkflowCommandDeps);
	});
	for (const { type, event } of BOUNDARIES.slice(0, 3)) {
		expect(await boundary(pi, type, event, record)).toBeUndefined();
	}
	expect(record.notices.length, "an idle session is never interrupted by the guard").toBe(0);
});

test("the remaining boundaries stay open while no workflow runs", async () => {
	const record: RunRecord = { notices: [], grants: [] };
	const pi = await createTestHost((api) => {
		registerWorkflowCommand(api, createState(), {
			setReadonly: () => false,
			requestHandoff: () => Promise.resolve(),
			watchHandoffSettlement: () => ({ done: new Promise<never>(() => undefined), dispose: () => undefined }),
			prepareRunFrontmatter: () => Promise.resolve(),
		} satisfies WorkflowCommandDeps);
	});
	for (const { type, event } of BOUNDARIES.slice(3)) {
		expect(await boundary(pi, type, event, record)).toBeUndefined();
	}
	expect(record.notices.length, "an idle session is never interrupted by the guard").toBe(0);
});
