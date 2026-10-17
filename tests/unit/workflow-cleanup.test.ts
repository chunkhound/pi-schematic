import assert from "node:assert/strict";
import test from "node:test";
import { CodemodeSandbox, type CodemodeResult, type CodemodeTool } from "@earendil-works/pi-codemode";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { READONLY_ENABLED_STATUS } from "../../notifications.js";
import { releaseWorkflow, reserveWorkflow } from "../../workflow/coordinator.js";
import { WORKFLOW_SHELL_ENTRY_TYPE } from "../../workflow/activity.js";
import { registerWorkflowCommand, type WorkflowCommandDeps } from "../../workflow/command.js";
import { WORKFLOW_SUMMARY_ENTRY_TYPE } from "../../workflow/summary.js";
import { WORKFLOW_ERROR_ENTRY_TYPE, WORKFLOW_EXIT_ENTRY_TYPE } from "../../workflow/types.js";
import { createTestHost } from "./test-host.js";

// ── Run lifecycle: guarded cleanup paths under fault injection ──────────
// WHY: every end-of-run step is advisory and independent, so a throwing paint, binding,
// record, or notice must still release the run: input usable, cancel unarmed, host disposed
// (child-usage sink gone; the registry disposal it also owns is pinned in
// workflow-run-registry.test.ts), chrome restored. These drive the real `/workflow` command through
// its own test seams and force one real throw per test, then assert the observable release
// rather than the implementation.

/** Progress tick short enough that a held sandbox window reaches several timer paints. */
const TICK_MS = 5;
/** Committed workflow fixture: the command reads and compiles it; the sandbox seam never runs it. */
const CLEANUP_WORKFLOW = "tests/e2e/fixtures/command-return.js";
const OK_RESULT = { ok: true, value: undefined, output: [], calls: [], storeWrites: { set: {}, delete: [] } } as unknown as CodemodeResult;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Each predicate names the exact UI write that must throw; nothing is mocked beyond it. */
interface CleanupFaults {
	/** Indicator paint (`setStatus`/`setWidget`) for this key throws. */
	paint?: (key: string) => boolean;
	/** Footer write throws; `factory === undefined` is pi's built-in footer restore. */
	footer?: (factory: unknown) => boolean;
	/** Notice for this message throws. */
	notify?: (message: string) => boolean;
	/** Transcript append for this custom type throws. */
	append?: (customType: string) => boolean;
	/** Session-branch read throws: host construction (`createHostState`) fails in openRun. */
	branch?: () => boolean;
}

/** The live run as the sandbox seam sees it: its handles, its signal, and its fault switches. */
interface RunWindow {
	tools: Map<string, CodemodeTool>;
	readonly signal: AbortSignal;
	faults: CleanupFaults;
}

interface CleanupHarness {
	state: ReturnType<typeof createState>;
	faults: CleanupFaults;
	notes: string[];
	/** Every UI write and append in call order, faults included: teardown order is observable. */
	log: string[];
	/** Real throws per seam, so each test proves its fault actually fired. */
	thrown: { paint: number; footer: number; notify: number; append: number };
	run: () => Promise<void>;
	entries: (customType: string) => Array<Record<string, any>>;
	/** The run-owned resources every completed run must hand back. */
	assertReleased: () => void;
}

async function createCleanupHarness(spec: {
	headless?: boolean;
	/** Vary the reported context percent per call: the ticker then has a real change to repaint. */
	varyingContext?: boolean;
	/** Runs inside the sandbox call, so a test controls exactly when its fault is live. */
	body?: (window: RunWindow) => Promise<CodemodeResult | undefined>;
} = {}): Promise<CleanupHarness> {
	const state = createState();
	let usageCalls = 0;
	const faults: CleanupFaults = {};
	const log: string[] = [];
	const notes: string[] = [];
	const thrown = { paint: 0, footer: 0, notify: 0, append: 0 };
	const tools = new Map<string, CodemodeTool>();
	let currentSignal = new AbortController().signal;
	let closed = false;

	/** One chrome write: fault first (counted and logged), then log the write it stands for. */
	function paint(key: string): void {
		if (faults.paint?.(key)) {
			thrown.paint += 1;
			log.push(`paint:throw:${key}`);
			throw new Error("paint down");
		}
		log.push(`paint:${key}`);
	}

	const ctx = {
		hasUI: !spec.headless,
		mode: spec.headless ? "rpc" : "tui",
		cwd: process.cwd(),
		abort: () => {},
		newSession: async () => ({ cancelled: false }),
		isIdle: () => true,
		modelRegistry: { getModelsOfType: () => [], getModelOfType: () => undefined },
		getContextUsage: () => ({ percent: spec.varyingContext ? 40 + (usageCalls++ % 25) : 40, tokens: 40_000, contextWindow: 100_000 }),
		sessionManager: {
			getSessionId: () => "cleanup-test",
			getLeafId: () => null,
			getBranch: () => {
				if (faults.branch?.()) throw new Error("branch read down");
				return [];
			},
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		ui: {
			theme: { fg: (name: string, text: string) => `[${name}:${text}]` },
			setStatus: (key: string) => paint(key),
			setWidget: (key: string) => paint(key),
			setWorkingMessage: () => {},
			setFooter: (factory: unknown) => {
				if (faults.footer?.(factory)) {
					thrown.footer += 1;
					log.push("footer:throw");
					throw new Error("footer down");
				}
				log.push(factory === undefined ? "footer:restore" : "footer:install");
			},
			notify: (message: string) => {
				if (faults.notify?.(message)) {
					thrown.notify += 1;
					log.push("notify:throw");
					throw new Error("notice down");
				}
				notes.push(message);
			},
			onTerminalInput: () => () => {},
		},
	} as unknown as ExtensionCommandContext;

	const deps: WorkflowCommandDeps = {
		// Mirrors index.ts `setReadonly`: the posture is state, then the return value.
		setReadonly: (enabled) => {
			state.readonlyEnabled = enabled;
			return enabled;
		},
		requestHandoff: async () => {},
		prepareRunFrontmatter: async () => {},
		progressTickMs: TICK_MS,
		// A fake bash that holds the effect open, so a test can observe the ticker mid-run.
		shellRun: async () => {
			await sleep(TICK_MS * 20);
			return { content: [{ type: "text", text: "ok" }], isError: false, structuredContent: { output: "ok", truncated: false, exit_code: 0, wall_time_seconds: 0 } };
		},
		sandboxFactory: (options) => {
			for (const tool of options.globals ?? []) tools.set(tool.name, tool);
			return {
				execute: async (_source: string, runOptions: { signal: AbortSignal }) => {
					currentSignal = runOptions.signal;
					return (await spec.body?.({ tools, get signal() { return currentSignal; }, faults })) ?? OK_RESULT;
				},
				close: async () => {
					closed = true;
				},
			} as unknown as CodemodeSandbox;
		},
	};
	const pi = await createTestHost((api) => registerWorkflowCommand(api, state, deps));
	// Flags bypass the budget dialog: the run starts with a limit no empty branch can cross.
	pi.setFlag("workflow-cost", "10");
	const appendEntry = pi.appendEntry;
	pi.appendEntry = ((customType: string, data?: unknown) => {
		if (faults.append?.(customType)) {
			thrown.append += 1;
			log.push(`append:throw:${customType}`);
			throw new Error("append down");
		}
		log.push(`append:${customType}`);
		appendEntry(customType, data);
	}) as typeof pi.appendEntry;

	return {
		state,
		faults,
		notes,
		log,
		thrown,
		entries: (customType) => pi.appendedEntries.filter((record) => record.customType === customType).map((record) => record.data as Record<string, any>),
		run: async () => {
			// Precondition that is itself an invariant: a finished run always releases the
			// process-wide reservation, so one failing run cannot silently poison the next test.
			assert.equal(reserveWorkflow(), true, "the previous run released the process-wide workflow reservation");
			releaseWorkflow();
			await pi.commands.get("workflow")!.handler(CLEANUP_WORKFLOW, ctx);
		},
		assertReleased: () => {
			assert.equal(state.inputSuppressed, false, "input is usable again");
			// Secondary check only: the host clears the sink it installed, so a null sink proves the
			// sink step ran. Registry disposal is an independent step in `disposeHost` and is proved
			// directly in tests/unit/workflow-run-registry.test.ts, not here.
			assert.equal(state.childUsageSink, null, "the run's child-usage sink is uninstalled");
			assert.equal(pi.handlers.get("input")?.length ?? 0, 0, "the input subscription is removed");
			assert.equal(closed, true, "the sandbox closed");
		},
	};
}

// WHY: the ticker is the only paint that runs on pi's own event loop, so a throw there would
// escape into the process, not into the command. The guard keeps it advisory; without it the
// interval callback raises an uncaught exception mid-run.
test("a throwing ticker paint stays inside the timer and the run still releases", async () => {
	const h = await createCleanupHarness({
		varyingContext: true, // a changing indicator makes each tick repaint
		body: async (window) => {
			// An in-flight effect keeps the progress view non-idle, so the ticker really repaints.
			const running = Promise.resolve(window.tools.get("workflow.shell")!.execute(["sleep 1"], { signal: window.signal }));
			// Hold the fault until one timer paint throws (bounded by the held shell), so a stalled
			// CI runner cannot miss the window; then clear it to restore the tick.
			let threw = false;
			window.faults.paint = (key) => {
				if (!key.startsWith("pi-schematic")) return false;
				threw = true;
				return true;
			};
			running.finally(() => { threw = true; });
			while (!threw) await sleep(TICK_MS);
			delete window.faults.paint;
			await running;
		},
	});
	const escaped: unknown[] = [];
	const capture = (error: unknown) => escaped.push(error);
	process.on("uncaughtException", capture);
	try {
		await h.run();
	} finally {
		process.off("uncaughtException", capture);
	}
	assert.ok(h.thrown.paint > 0, "the ticker paint really threw");
	assert.deepEqual(escaped, [], "a throwing paint must never escape the interval callback");
	h.assertReleased();
	assert.deepEqual(h.entries(WORKFLOW_EXIT_ENTRY_TYPE), [{ v: 1, reason: "returned" }], "the run records its own outcome");
	assert.equal(h.entries(WORKFLOW_SUMMARY_ENTRY_TYPE).length, 1, "the overview still lands");
	assert.ok(h.log.includes("footer:restore"), "chrome is restored after the paint fault");
});

// WHY: `openRun` binds the run inside the try so a throwing seam there cannot bypass the
// finally. The fault is a throwing session-branch read during host construction, which fails
// the first binding step before the run owns anything. A failed start must be reported, never
// thrown at pi, and the backstop must clear the poisoned prior-run state so the next run works.
test("a throwing openRun binding reports a failed start and never poisons the next run", async () => {
	const h = await createCleanupHarness({ headless: true });
	h.state.inputSuppressed = true;
	h.state.childUsageSink = () => {};
	h.faults.branch = () => true;
	await h.run();

	assert.deepEqual(h.entries(WORKFLOW_ERROR_ENTRY_TYPE), [{ phase: "start", error: "workflow failed to start: branch read down" }], "the failed start is visible in the transcript");
	assert.deepEqual(h.entries(WORKFLOW_EXIT_ENTRY_TYPE), [], "a run that never started records no exit");
	assert.equal(h.log.filter((entry) => entry.startsWith("footer")).length, 0, "a failed start paints no chrome");
	assert.equal(h.state.inputSuppressed, false, "the poisoned suppression flag is cleared");
	assert.equal(h.state.childUsageSink, null, "the poisoned sink is cleared");
	assert.equal(reserveWorkflow(), true, "the failed start released the process reservation");
	releaseWorkflow();

	delete h.faults.branch;
	await h.run();
	assert.deepEqual(h.entries(WORKFLOW_EXIT_ENTRY_TYPE), [{ v: 1, reason: "returned" }], "the next run completes");
	h.assertReleased();
});

// WHY: teardown order is a contract: the host (and with it the child-usage sink and the run
// registry it owns) goes before chrome, and each step stands alone. The footer restore is the
// first chrome step after disposal, so snapshotting there proves the order, and failing it
// proves the indicator refresh after it is not skipped.
test("release disposes the host before chrome and keeps going when a chrome restore throws", async () => {
	// Varying context forces the post-restore indicator refresh to paint, so the paint log
	// proves that refresh still ran after the throwing footer restore.
	const h = await createCleanupHarness({ varyingContext: true });
	const releasedAtChrome: Array<{ sink: boolean; input: boolean }> = [];
	h.faults.footer = (factory) => {
		if (factory !== undefined) return false;
		releasedAtChrome.push({
			sink: h.state.childUsageSink === null,
			input: h.state.inputSuppressed === false,
		});
		// Only a paint attempted after the throw can follow it in the log.
		return true;
	};
	await h.run();
	assert.deepEqual(releasedAtChrome, [{ sink: true, input: true }], "host-owned resources and input are released before chrome is restored");
	assert.ok(h.log.slice(h.log.indexOf("footer:throw")).some((entry) => entry.startsWith("paint:")), "the indicator refresh still ran after the throwing footer restore");
	h.assertReleased();
	assert.deepEqual(h.entries(WORKFLOW_EXIT_ENTRY_TYPE), [{ v: 1, reason: "returned" }]);
	assert.equal(h.entries(WORKFLOW_SUMMARY_ENTRY_TYPE).length, 1);
});

// WHY: `workflow.readonly` is a posture switch whose repaint is advisory. Without the guard
// the throw rejects the handle, the sandbox reports a failed script, and the whole run aborts
// as an error over a cosmetic notice.
test("a throwing readonly notice leaves the posture applied and the run alive", async () => {
	const h = await createCleanupHarness({
		body: async (window) => {
			window.faults.notify = (message) => message === READONLY_ENABLED_STATUS;
			try {
				await window.tools.get("workflow.readonly")!.execute(true, { signal: window.signal });
				return undefined;
			} catch (error) {
				// A real sandbox surfaces a rejected handle as a failed script run.
				return { ok: false, error: { kind: "error", message: String(error) }, output: [], calls: [] } as unknown as CodemodeResult;
			} finally {
				delete window.faults.notify;
			}
		},
	});
	await h.run();
	assert.equal(h.thrown.notify, 1, "the readonly notice really threw");
	assert.equal(h.state.readonlyEnabled, true, "the posture is applied even when the notice fails");
	assert.deepEqual(h.entries(WORKFLOW_EXIT_ENTRY_TYPE), [{ v: 1, reason: "returned" }], "an advisory paint failure never aborts the run");
	assert.equal(h.entries(WORKFLOW_SUMMARY_ENTRY_TYPE)[0]?.reason, "returned");
	assert.ok(h.notes.includes("returned"), "the run outcome is still noticed");
	h.assertReleased();
});

// WHY: the overview append and its error-record fallback both fail, so the warning notice is
// the only surface left. It runs inside the cleanup path: a throw there would escape the
// finally and skip every release step after it.
test("a throwing summary-fallback notice still releases every run resource", async () => {
	const h = await createCleanupHarness();
	h.faults.append = (customType) => customType === WORKFLOW_SUMMARY_ENTRY_TYPE || customType === WORKFLOW_ERROR_ENTRY_TYPE;
	h.faults.notify = (message) => message.startsWith("workflow overview could not be persisted");
	await h.run();
	assert.equal(h.thrown.notify, 1, "the fallback notice really threw");
	assert.deepEqual(h.entries(WORKFLOW_EXIT_ENTRY_TYPE), [{ v: 1, reason: "returned" }], "the exit record stands on its own");
	assert.equal(h.entries(WORKFLOW_SUMMARY_ENTRY_TYPE).length, 0, "the failed overview is not recorded");
	h.assertReleased();
	assert.ok(h.log.includes("footer:restore"), "chrome is restored even when every record path fails");
});

// WHY: an effect can outlive `releaseRun` (its promise resolves after the sandbox stops
// awaiting it). A late end must not persist a shell row after the overview nor repaint
// chrome: `ctl.ctx` is nulled before the chrome restore and the activity channel is disposed.
test("an effect that outlives the run leaves no late audit row and reinstalls no chrome", async () => {
	const h = await createCleanupHarness({
		body: async (window) => {
			// Fire-and-forget: the sandbox returns before this shell resolves.
			void window.tools.get("workflow.shell")!.execute(["sleep 1"], { signal: window.signal });
			return OK_RESULT;
		},
	});
	await h.run();
	assert.ok(h.log.includes("footer:restore"), "chrome is restored on release");
	const rowsAtRelease = h.entries(WORKFLOW_SHELL_ENTRY_TYPE).length;
	const logAtRelease = h.log.length;
	await sleep(TICK_MS * 40);
	assert.equal(h.entries(WORKFLOW_SHELL_ENTRY_TYPE).length, rowsAtRelease, "no late audit row after dispose");
	assert.deepEqual(h.log.slice(logAtRelease), [], "no chrome write after release");
	h.assertReleased();
});
