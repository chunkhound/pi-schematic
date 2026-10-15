/**
 * Runs the handoff boundary inside a real pi agent session, so pi's own runner
 * decides what a turn_end boundary commits, when the continuation turn runs and
 * what the provider receives. Handler-level behaviour is covered by
 * handoff.test.ts; this file pins the pi semantics that design relies on.
 *
 * Isolation as in prompt-sections-session.test.ts: one mkdtemp directory holds
 * HOME and every pi path, PI_OFFLINE=1 keeps ModelRuntime off the network, and
 * the faux provider needs no credentials. The faux provider reports usage as
 * chars / 4 of the request, so a large first prompt makes the handoff eligible.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import {
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionUIContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	type FauxResponseFactory,
	type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import registerSchematic from "../../index.js";
import { MIN_HANDOFF_TOKENS } from "../../handoff/eligibility.js";
import {
	HANDOFF_FAILED_CUSTOM_TYPE,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SUCCESSOR_CUSTOM_TYPE,
	buildContinuationFrame,
	buildHandoffSystemPromptNote,
	buildNextUserMessage,
	formatHandoffComplete,
	formatHandoffFailure,
} from "../../handoff/format.js";
import {
	HANDOFF_FAILED_IN_RUN_REFUSAL,
	HANDOFF_NOT_ALONE_REFUSAL,
	HANDOFF_REQUIRED_STATUS,
	HANDOFF_STAGED_RESULT,
	HANDOFF_SUCCESSOR_NOT_RUN,
	REASON_ABORTED,
	REASON_NOT_PERSISTED,
} from "../../handoff/copy.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS, buildNudge } from "../../watchdog.js";
import { createDeferred, setTempHome } from "./helpers.js";

type ExtensionFactory = (pi: ExtensionAPI) => void;
type ContextUsage = ReturnType<AgentSession["getContextUsage"]>;

/** What an observer extension, loaded after schematic, saw during the session. */
interface Observed {
	/** Provider requests in order, as the messages the model received. */
	requests: Message[][];
	/** Lifecycle event names in order. */
	events: string[];
	/** Entry types (`custom_message` as `custom_message:<customType>`) on the branch at each turn_start. */
	branchAtTurnStart: string[][];
	/** `getContextUsage()` at each context event, i.e. right before each provider request. */
	usageAtContext: ContextUsage[];
	/** `getContextUsage()` when the handoff tool call was dispatched. */
	usageAtHandoffCall: ContextUsage[];
	/** Errors pi caught from extension handlers (otherwise dropped silently). */
	extensionErrors: string[];
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	observed: Observed;
}

const LARGE_PROMPT = `first ${"x".repeat(MIN_HANDOFF_TOKENS * 4)}`;
const NEXT_INSTRUCTION = "Write the migration guide for the boundary cut.";
const HANDOFF_CONTEXT = "The design lives in docs/design.md; section 2 is settled.";

let sandboxDir: string;
let restoreHome: () => void;
const previousPiOffline = process.env.PI_OFFLINE;

before(async () => {
	sandboxDir = await mkdtemp(join(os.tmpdir(), "pi-schematic-handoff-boundary-"));
	restoreHome = setTempHome(sandboxDir);
	process.env.PI_OFFLINE = "1";
});

after(async () => {
	restoreHome();
	if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousPiOffline;
	await rm(sandboxDir, { recursive: true, force: true });
});

function entryLabel(entry: SessionEntry): string {
	return entry.type === "custom_message" || entry.type === "custom" ? `${entry.type}:${entry.customType}` : entry.type;
}

function observer(observed: Observed): ExtensionFactory {
	return (pi) => {
		const record = (name: string) => async () => {
			observed.events.push(name);
		};
		pi.on("before_agent_start", record("before_agent_start"));
		pi.on("agent_start", record("agent_start"));
		pi.on("agent_settled", record("agent_settled"));
		pi.on("session_before_compact", record("session_before_compact"));
		pi.on("session_compact", record("session_compact"));
		pi.on("turn_start", async (_event, ctx) => {
			observed.branchAtTurnStart.push(ctx.sessionManager.getBranch().map(entryLabel));
		});
		pi.on("context", async (_event, ctx) => {
			observed.usageAtContext.push(ctx.getContextUsage());
		});
		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName === "handoff") observed.usageAtHandoffCall.push(ctx.getContextUsage());
		});
	};
}

/**
 * A UI context that records each notify as `notify:<level>:<message>` and each
 * setStatus as `status:<key>:<text>` in `log`, in call order. Attaching it makes
 * `ctx.hasUI` true. The theme returns text unstyled.
 */
function recordingUI(log: string[]): ExtensionUIContext {
	const ui = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string, type?: string) => { log.push(`notify:${type ?? "info"}:${message}`); },
		onTerminalInput: () => () => {},
		setStatus: (key: string, text: string | undefined) => { log.push(`status:${key}:${String(text)}`); },
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	return ui as unknown as ExtensionUIContext;
}

/**
 * Start a real session with schematic. `before` factories load ahead of
 * schematic, `after` factories behind it (and ahead of the observer). Every
 * response factory records the request it answers. `ui` attaches a UI context.
 */
async function startSession(
	responses: FauxResponseFactory[],
	extensions: { before?: ExtensionFactory[]; after?: ExtensionFactory[]; ui?: ExtensionUIContext } = {},
): Promise<Harness> {
	const observed: Observed = {
		requests: [],
		events: [],
		branchAtTurnStart: [],
		usageAtContext: [],
		usageAtHandoffCall: [],
		extensionErrors: [],
	};
	const faux = fauxProvider();
	faux.setResponses(responses.map((respond): FauxResponseFactory => (context, ...rest) => {
		observed.requests.push(context.messages);
		return respond(context, ...rest);
	}));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(sandboxDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd: sandboxDir,
		agentDir: sandboxDir,
		extensionFactories: [...(extensions.before ?? []), registerSchematic, ...(extensions.after ?? []), observer(observed)],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(sandboxDir);
	const { session } = await createAgentSession({
		cwd: sandboxDir,
		agentDir: sandboxDir,
		model: faux.getModel(),
		modelRuntime,
		sessionManager,
		resourceLoader,
	});
	await session.bindExtensions({
		...(extensions.ui === undefined ? {} : { uiContext: extensions.ui }),
		onError: (error) => observed.extensionErrors.push(`${error.event}: ${error.error}`),
	});
	return { session, sessionManager, observed };
}

const reply = (text: string): FauxResponseFactory => () => fauxAssistantMessage(text);
const call = (...calls: ReturnType<typeof fauxToolCall>[]): FauxResponseFactory => () => fauxAssistantMessage(calls);
const handoffCall = (args: Record<string, unknown> = {}) =>
	fauxToolCall("handoff", { nextInstruction: NEXT_INSTRUCTION, context: HANDOFF_CONTEXT, ...args }, { id: "call-handoff" });

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => ("text" in block ? block.text : "")).join("");
}

function nonSystem(request: Message[]): Message[] {
	return request.filter((message) => message.role !== "system");
}

function entriesOf(sessionManager: SessionManager, type: string, customType?: string): SessionEntry[] {
	return sessionManager.getBranch().filter((entry) =>
		entry.type === type && (customType === undefined || ("customType" in entry && entry.customType === customType)));
}

function toolResultFor(sessionManager: SessionManager, toolCallId: string) {
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId) {
			return entry.message;
		}
	}
	return undefined;
}

/** First line of the eligible required-handoff nudge the context hook appends. */
const REQUIRED_NUDGE_LINE = buildNudge({
	activeNotebookTopic: null,
	pendingTopicBoundaryHint: null,
	readonlyEnabled: false,
	pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: "x" },
}, null, true).split("\n")[0];

function carriesRequiredNudge(request: Message[]): boolean {
	const last = request.at(-1);
	return last !== undefined && messageText(last).includes(REQUIRED_NUDGE_LINE);
}

/** Wait until `done` resolves (runs a follow-up may start after prompt() returns), then for idle. */
async function settle(session: AgentSession, done: Promise<void>, what: string): Promise<void> {
	await Promise.race([
		done,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000).unref()),
	]);
	await session.waitForIdle();
}

/** Wait until `runs` runs have settled; a /handoff command's run starts after prompt() returns, so waitForIdle alone can return before it. */
async function settleRuns(session: AgentSession, observed: Observed, runs: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (observed.events.filter((name) => name === "agent_settled").length < runs) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${runs} settled runs`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	await session.waitForIdle();
}

describe("handoff boundary in a real agent session", () => {
	it("cuts and runs the successor in the same run when the model calls handoff", async () => {
		const { session, sessionManager, observed } = await startSession([
			call(handoffCall()),
			reply("successor answer"),
		]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		const labels = sessionManager.getBranch().map(entryLabel);
		assert.deepEqual(labels.slice(-4), [
			"compaction",
			`custom_message:${HANDOFF_SUCCESSOR_CUSTOM_TYPE}`,
			`custom_message:${HANDOFF_NOTE_CUSTOM_TYPE}`,
			"message",
		]);
		const [cut] = entriesOf(sessionManager, "compaction");
		assert.ok(cut.type === "compaction");
		assert.equal(cut.firstKeptEntryId, cut.id, "a retain-none cut keeps nothing before itself");
		assert.equal(cut.summary, buildContinuationFrame());
		const handoffId = (cut.details as { handoffId?: unknown }).handoffId;
		assert.equal(typeof handoffId, "string");
		const [successor] = entriesOf(sessionManager, "custom_message", HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		const [note] = entriesOf(sessionManager, "custom_message", HANDOFF_NOTE_CUSTOM_TYPE);
		assert.ok(successor.type === "custom_message" && note.type === "custom_message");
		assert.equal(successor.parentId, cut.id);
		assert.equal(successor.content, buildNextUserMessage({ nextInstruction: NEXT_INSTRUCTION, context: HANDOFF_CONTEXT }));
		assert.equal(successor.display, true);
		assert.deepEqual(successor.details, { handoffId });
		assert.equal(note.content, buildHandoffSystemPromptNote());
		assert.equal(note.display, false);
		assert.deepEqual(observed.extensionErrors, []);
	});

	it("continues the calling run for the successor turn without a new agent start or compaction events", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		assert.deepEqual(observed.events, ["before_agent_start", "agent_start", "agent_settled"]);
		assert.equal(observed.requests.length, 2);
	});

	it("shows the successor turn only the frame, the successor and the note", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		const successorRequest = nonSystem(observed.requests[1]).map(messageText);
		assert.equal(successorRequest.length, 3, `successor request: ${JSON.stringify(successorRequest.map((text) => text.slice(0, 60)))}`);
		// pi wraps the summary in its own fixed prefix and suffix; convertToLlm applies that wrapping.
		const [frameMessage] = convertToLlm([{ role: "compactionSummary", summary: buildContinuationFrame(), tokensBefore: 0, timestamp: 0 }]);
		assert.equal(successorRequest[0], messageText(frameMessage));
		assert.equal(successorRequest[1], buildNextUserMessage({ nextInstruction: NEXT_INSTRUCTION, context: HANDOFF_CONTEXT }));
		assert.equal(successorRequest[2], buildHandoffSystemPromptNote());
		assert.ok(!successorRequest.some((text) => text.includes(LARGE_PROMPT)), "the pre-cut prompt is gone");
		assert.ok(!successorRequest.some((text) => text.includes(HANDOFF_STAGED_RESULT)), "the pre-cut handoff result is gone");
	});

	it("lets turn_start read the committed boundary from the branch", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		assert.equal(observed.branchAtTurnStart.length, 2);
		assert.deepEqual(observed.branchAtTurnStart[1].slice(-3), [
			"compaction",
			`custom_message:${HANDOFF_SUCCESSOR_CUSTOM_TYPE}`,
			`custom_message:${HANDOFF_NOTE_CUSTOM_TYPE}`,
		]);
	});

	it("reports the faux usage of a large prompt as eligible and no usage percent right after the cut", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		assert.equal(observed.usageAtHandoffCall.length, 1);
		const tokens = observed.usageAtHandoffCall[0]?.tokens;
		assert.ok(typeof tokens === "number" && tokens >= MIN_HANDOFF_TOKENS, `usage at the handoff call: ${String(tokens)}`);
		assert.equal(observed.usageAtContext.length, 2);
		assert.equal(observed.usageAtContext[1]?.percent, null, "usage at the successor request");
	});

	it("settles a /handoff request before the successor's first request", async () => {
		const successorRequested = createDeferred();
		const { session, observed } = await startSession([
			reply("ready"),
			call(handoffCall()),
			() => {
				successorRequested.resolve();
				return fauxAssistantMessage("successor answer");
			},
		]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settle(session, successorRequested.promise, "the successor request");
		} finally {
			session.dispose();
		}

		assert.equal(observed.requests.length, 3);
		assert.ok(carriesRequiredNudge(observed.requests[1]), "the handoff request was enforced before the cut");
		const successorRequest = nonSystem(observed.requests[2]).map(messageText);
		assert.equal(successorRequest[1], buildNextUserMessage({ nextInstruction: "finish the report", context: HANDOFF_CONTEXT }));
		assert.equal(successorRequest.length, 3, "no watchdog message follows the note");
	});

	for (const order of ["handoff first", "handoff second"] as const) {
		it(`refuses a handoff that shares its message with notebook_write, which still runs (${order})`, async () => {
			const sibling = fauxToolCall("notebook_write", { name: "sibling-page", content: "findings saved before the handoff" }, { id: "call-sibling" });
			const calls = order === "handoff first" ? [handoffCall(), sibling] : [sibling, handoffCall()];
			const { session, sessionManager, observed } = await startSession([call(...calls), reply("continued after the refusal")]);
			try {
				await session.prompt(LARGE_PROMPT);
				await session.waitForIdle();
			} finally {
				session.dispose();
			}

			const handoffResult = toolResultFor(sessionManager, "call-handoff");
			assert.ok(handoffResult, "the handoff has a tool result");
			assert.equal(handoffResult.isError, true);
			assert.equal(messageText(handoffResult as Message), HANDOFF_NOT_ALONE_REFUSAL);
			assert.equal(toolResultFor(sessionManager, "call-sibling")?.isError, false, "the notebook_write ran");
			assert.equal(entriesOf(sessionManager, "custom", "notebook-entry").length, 1, "the notebook entry is persisted");
			assert.deepEqual(entriesOf(sessionManager, "compaction"), [], "no cut is written");
			assert.deepEqual(entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE), [], "nothing was staged, so nothing fails");
			assert.equal(observed.requests.length, 2, "the batch did not end the run; the model was asked again");
			assert.equal(nonSystem(observed.requests[1]).some((message) =>
				message.role === "toolResult" && messageText(message) === HANDOFF_NOT_ALONE_REFUSAL), true,
				"the next request carries the refusal");
			assert.deepEqual(observed.extensionErrors, []);
		});
	}

	it("writes the notebook discard in the boundary and shows the successor only the kept pages", async () => {
		const { session, sessionManager, observed } = await startSession([
			call(
				fauxToolCall("notebook_write", { name: "keep-page", content: "kept" }, { id: "call-write-keep" }),
				fauxToolCall("notebook_write", { name: "drop-page", content: "dropped" }, { id: "call-write-drop" }),
			),
			reply("pages written"),
			call(handoffCall({ discardPages: ["drop-page"] })),
			call(fauxToolCall("notebook_index", {}, { id: "call-index" })),
			reply("successor answer"),
		]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("hand off now");
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		const labels = sessionManager.getBranch().map(entryLabel);
		const cutIndex = labels.indexOf("compaction");
		assert.deepEqual(labels.slice(cutIndex - 3, cutIndex), [
			"custom:notebook-generation",
			"custom:notebook-entry",
			"custom:notebook-generation",
		]);
		const indexResult = toolResultFor(sessionManager, "call-index");
		assert.ok(indexResult, "the successor ran notebook_index");
		const indexText = messageText(indexResult as Message);
		assert.ok(indexText.includes("keep-page"), indexText);
		assert.ok(!indexText.includes("drop-page"), indexText);
		assert.deepEqual(observed.extensionErrors, []);
	});

	it("completes the cut when the run settles after a later extension stops the continuation", async () => {
		const stopContinuation: ExtensionFactory = (pi) => {
			pi.on("turn_end", async () => ({ continue: false }));
		};
		const handoffRequested = createDeferred();
		const nextRunRequested = createDeferred();
		const { session, sessionManager, observed } = await startSession(
			[reply("ready"), () => {
				handoffRequested.resolve();
				return fauxAssistantMessage([handoffCall()]);
			}, () => {
				nextRunRequested.resolve();
				return fauxAssistantMessage("next run answer");
			}],
			{ after: [stopContinuation] },
		);
		let requestsAfterHandoffRun: number;
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settle(session, handoffRequested.promise, "the handoff run");
			requestsAfterHandoffRun = observed.requests.length;
			// The command refuses while a handoff is still staged, so it reports whether the settle completed the cut.
			await session.prompt("/handoff write the release notes");
			await settle(session, nextRunRequested.promise, "the next /handoff run");
		} finally {
			session.dispose();
		}

		assert.equal(requestsAfterHandoffRun, 2, "the successor turn did not run");
		assert.equal(entriesOf(sessionManager, "compaction").length, 1, "the cut is persisted");
		assert.deepEqual(observed.extensionErrors, [], "the next /handoff was accepted");
		assert.ok(nonSystem(observed.requests[2]).some((message) => messageText(message) === buildNextUserMessage({ nextInstruction: "finish the report", context: HANDOFF_CONTEXT })),
			"the next run's request carries the persisted successor");
	});

	it("completes the handoff and keeps the successor for the next prompt when the run is aborted after the cut", async () => {
		// pi starts the continuation turn without checking the signal, so an abort
		// after the boundary commit still reaches turn_start; that turn's request ends aborted.
		let abortSent = false;
		const abortedAtTurnStart: boolean[] = [];
		const abortAfterCut: ExtensionFactory = (pi) => {
			pi.on("turn_end", async (event, ctx) => {
				if (!abortSent && event.entries.length > 0) {
					abortSent = true;
					ctx.abort();
				}
			});
			pi.on("turn_start", async (_event, ctx) => {
				abortedAtTurnStart.push(ctx.signal?.aborted === true);
			});
		};
		const ui: string[] = [];
		const { session, sessionManager, observed } = await startSession(
			[reply("ready"), call(handoffCall()), reply("next prompt answer")],
			{ after: [abortAfterCut], ui: recordingUI(ui) },
		);
		let requestsAfterHandoffRun: number;
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settleRuns(session, observed, 2);
			requestsAfterHandoffRun = observed.requests.length;
			await session.prompt("continue");
			await settleRuns(session, observed, 3);
		} finally {
			session.dispose();
		}

		assert.deepEqual(abortedAtTurnStart, [false, false, true, false], "the successor turn starts with the signal already aborted");
		assert.equal(requestsAfterHandoffRun, 2, "the aborted successor turn made no provider request");
		const cuts = entriesOf(sessionManager, "compaction");
		assert.equal(cuts.length, 1, "the cut is persisted");
		const [cut] = cuts;
		assert.ok(cut.type === "compaction");
		const handoffId = (cut.details as { handoffId?: unknown }).handoffId;
		assert.equal(typeof handoffId, "string");
		const successors = entriesOf(sessionManager, "custom_message", HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		assert.equal(successors.length, 1, "the successor is persisted");
		assert.ok(successors[0].type === "custom_message");
		assert.deepEqual(successors[0].details, { handoffId });
		assert.deepEqual(entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE), []);
		assert.ok(ui.includes(`notify:info:${formatHandoffComplete(false, 0, 0)}`), JSON.stringify(ui));
		assert.ok(!ui.includes(`notify:warning:${HANDOFF_SUCCESSOR_NOT_RUN}`), JSON.stringify(ui));
		assert.ok(!carriesRequiredNudge(observed.requests[2]), "the request was finalized, so the next prompt is not enforced");
		assert.ok(nonSystem(observed.requests[2]).some((message) =>
			messageText(message) === buildNextUserMessage({ nextInstruction: "finish the report", context: HANDOFF_CONTEXT })),
			"the next prompt's request carries the successor");
		assert.deepEqual(observed.extensionErrors, []);
	});

	it("renders the next prompt's system prompt without the topic or the discarded page after an in-run handoff", async () => {
		const { session, observed } = await startSession([
			call(
				fauxToolCall("notebook_topic_set", { topic: "oauth" }, { id: "call-topic" }),
				fauxToolCall("notebook_write", { name: "keep", content: "durable decision" }, { id: "call-write-keep" }),
				fauxToolCall("notebook_write", { name: "stale", content: "obsolete finding" }, { id: "call-write-stale" }),
			),
			reply("pages written"),
			call(handoffCall({ discardPages: ["stale"] })),
			reply("successor answer"),
			reply("next prompt answer"),
		]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("hand off now");
			await session.prompt("next task");
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		assert.equal(observed.requests.length, 5);
		const beforeHandoff = getCurrentSystemPrompt(observed.requests[2]);
		assert.ok(beforeHandoff.includes("Current topic: `oauth`"), beforeHandoff);
		assert.ok(beforeHandoff.includes("  stale: obsolete finding"), beforeHandoff);
		const afterHandoff = getCurrentSystemPrompt(observed.requests[4]);
		assert.ok(afterHandoff.includes("No active notebook topic is set."), afterHandoff);
		assert.ok(!afterHandoff.includes("Current topic:"), afterHandoff);
		assert.ok(afterHandoff.includes("  keep: durable decision"), afterHandoff);
		assert.ok(!afterHandoff.includes("stale: obsolete finding"), afterHandoff);
		assert.deepEqual(observed.extensionErrors, []);
	});

	it("returns an error to a handoff called through ctx.executeTool and stages nothing", async () => {
		const outcomes: { isError: boolean; text: string }[] = [];
		const nestedCaller: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "nested_handoff",
				label: "Nested handoff",
				description: "Calls handoff through ctx.executeTool.",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					const outcome = await ctx.executeTool("handoff", { nextInstruction: NEXT_INSTRUCTION, context: HANDOFF_CONTEXT });
					outcomes.push({
						isError: outcome.isError,
						text: outcome.result.content.map((block: { type: string; text?: string }) => block.text ?? "").join(""),
					});
					return { content: [{ type: "text", text: "nested call made" }], details: undefined };
				},
			});
		};
		const { session, sessionManager, observed } = await startSession(
			[call(fauxToolCall("nested_handoff", {}, { id: "call-nested" })), reply("after the nested call")],
			{ after: [nestedCaller] },
		);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].isError, true, outcomes[0].text);
		assert.equal(toolResultFor(sessionManager, "call-nested")?.isError, false);
		assert.deepEqual(entriesOf(sessionManager, "compaction"), [], "no cut is written");
		assert.deepEqual(entriesOf(sessionManager, "custom_message", HANDOFF_SUCCESSOR_CUSTOM_TYPE), []);
		assert.deepEqual(entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE), [], "nothing was staged, so nothing fails at settle");
		assert.equal(observed.requests.length, 2);
		assert.deepEqual(observed.extensionErrors, []);
	});
});

describe("failed handoff cut in a real agent session", () => {
	// A dropped cut never starts a run: the guidance is a displayed message that
	// waits on the branch. `requests` is the provider requests the handoff run made
	// after "ready": the handoff call itself, plus the follow-on turn only when the
	// dropper left the continuation alone.
	const dropVariants: { name: string; result: { entries: []; continue?: false }; requests: number }[] = [
		{ name: "the dropper keeps the continuation", result: { entries: [] }, requests: 2 },
		{ name: "the dropper stops the continuation", result: { entries: [], continue: false }, requests: 1 },
	];
	for (const variant of dropVariants) {
		it(`persists the failure guidance without starting a run and keeps the request pending when a later extension drops the boundary (${variant.name})`, async () => {
			const dropBoundary: ExtensionFactory = (pi) => {
				pi.on("turn_end", async (event) => (event.entries.length > 0 ? variant.result : undefined));
			};
			const guidance = formatHandoffFailure(REASON_NOT_PERSISTED, true);
			const { session, sessionManager, observed } = await startSession(
				[reply("ready"), call(handoffCall()), reply("plain answer"), reply("next prompt answer")],
				{ after: [dropBoundary] },
			);
			let runsAfterHandoffRun: number;
			let requestsAfterHandoffRun: number;
			try {
				await session.prompt(LARGE_PROMPT);
				await session.prompt("/handoff finish the report");
				await settleRuns(session, observed, 2);
				runsAfterHandoffRun = observed.events.filter((name) => name === "agent_start").length;
				requestsAfterHandoffRun = observed.requests.length;
				await session.prompt("continue");
				await settleRuns(session, observed, 3);
			} finally {
				session.dispose();
			}

			assert.equal(runsAfterHandoffRun, 2, "the first prompt's run and the /handoff run; the failure starts no run");
			assert.equal(requestsAfterHandoffRun, 1 + variant.requests);
			assert.deepEqual(entriesOf(sessionManager, "compaction"), [], "no cut on the branch");
			const failures = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE);
			assert.equal(failures.length, 1);
			const [failure] = failures;
			assert.ok(failure.type === "custom_message");
			assert.equal(failure.content, guidance);
			assert.equal(failure.display, true);
			const userTexts = sessionManager.getBranch().flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message as Message)] : []);
			assert.deepEqual(userTexts.filter((text) => text.includes("Handoff failed")), [], "no user message announces the failure");
			assert.ok(carriesRequiredNudge(observed.requests.at(-1) ?? []), "the request stays pending and is enforced on the next prompt");
			assert.deepEqual(observed.extensionErrors, []);
		});
	}

	it("writes no cut, persists the abort failure and starts no new run when the run is aborted", async () => {
		const abortOnHandoffResult: ExtensionFactory = (pi) => {
			pi.on("turn_end", async (event, ctx) => {
				if (event.toolResults.some((result) => result.toolName === "handoff")) ctx.abort();
			});
		};
		const handoffRequested = createDeferred();
		const { session, sessionManager, observed } = await startSession(
			[reply("ready"), () => {
				handoffRequested.resolve();
				return fauxAssistantMessage([handoffCall()]);
			}, reply("next prompt answer")],
			{ before: [abortOnHandoffResult] },
		);
		let runsAfterAbort: number;
		let requestsAfterAbort: number;
		let failuresAfterAbort: SessionEntry[];
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settle(session, handoffRequested.promise, "the handoff run");
			runsAfterAbort = observed.events.filter((name) => name === "agent_start").length;
			requestsAfterAbort = observed.requests.length;
			failuresAfterAbort = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE);
			await session.prompt("continue");
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		assert.equal(runsAfterAbort, 2, "the first prompt's run and the aborted /handoff run; no failure run");
		assert.equal(requestsAfterAbort, 2);
		assert.deepEqual(entriesOf(sessionManager, "compaction"), [], "no cut on the branch");
		assert.equal(failuresAfterAbort.length, 1, "the failure is persisted when the aborted run settles");
		const [failure] = failuresAfterAbort;
		assert.ok(failure.type === "custom_message");
		assert.equal(failure.content, formatHandoffFailure(REASON_ABORTED, true));
		assert.equal(failure.display, true);
		assert.ok(carriesRequiredNudge(observed.requests[2]), "the request stays pending and is enforced on the next prompt");
		assert.deepEqual(observed.extensionErrors, []);
	});

	it("counts each failed cut against the enforcement budget until the request is cancelled", async () => {
		const dropBoundary: ExtensionFactory = (pi) => {
			pi.on("turn_end", async (event) => (event.entries.length > 0 ? { entries: [], continue: false } : undefined));
		};
		let nudgedRuns = 0;
		const handoffWhenNudged: FauxResponseFactory = (context) => {
			if (carriesRequiredNudge(context.messages)) {
				nudgedRuns += 1;
				return fauxAssistantMessage([fauxToolCall("handoff", { nextInstruction: "x", context: HANDOFF_CONTEXT }, { id: `call-handoff-${nudgedRuns}` })]);
			}
			return fauxAssistantMessage("plain answer");
		};
		const { session, observed } = await startSession(
			Array.from({ length: MAX_HANDOFF_ATTEMPTS + 4 }, () => handoffWhenNudged),
			{ after: [dropBoundary] },
		);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settleRuns(session, observed, 2);
			// Nothing starts a run on its own, so each retry is a user prompt.
			for (let attempt = 1; attempt < MAX_HANDOFF_ATTEMPTS; attempt++) {
				await session.prompt("retry");
				await settleRuns(session, observed, 2 + attempt);
			}
			await session.prompt("after the budget");
			await settleRuns(session, observed, 2 + MAX_HANDOFF_ATTEMPTS);
		} finally {
			session.dispose();
		}

		assert.equal(nudgedRuns, MAX_HANDOFF_ATTEMPTS);
		assert.equal(observed.requests.length, MAX_HANDOFF_ATTEMPTS + 2, "first prompt, one request per failed attempt, then the unenforced prompt");
		assert.ok(!carriesRequiredNudge(observed.requests.at(-1) ?? []), "the cancelled request is no longer enforced");
		assert.deepEqual(observed.extensionErrors, []);
	});

	it("refuses a second handoff in the run that already lost a cut and accepts one in the next run", async () => {
		const dropKeepingContinuation: ExtensionFactory = (pi) => {
			pi.on("turn_end", async (event) => (event.entries.length > 0 ? { entries: [] } : undefined));
		};
		const handoffAs = (id: string) => call(fauxToolCall("handoff", { nextInstruction: NEXT_INSTRUCTION, context: HANDOFF_CONTEXT }, { id }));
		const { session, sessionManager, observed } = await startSession(
			[reply("ready"), handoffAs("call-first"), handoffAs("call-second"), handoffAs("call-third"), reply("settled")],
			{ after: [dropKeepingContinuation] },
		);
		let requestsAfterHandoffRun: number;
		let failuresAfterHandoffRun: number;
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settleRuns(session, observed, 2);
			requestsAfterHandoffRun = observed.requests.length;
			failuresAfterHandoffRun = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE).length;
			await session.prompt("try again");
			await settleRuns(session, observed, 3);
		} finally {
			session.dispose();
		}

		const second = toolResultFor(sessionManager, "call-second");
		assert.ok(second, "the second handoff has a tool result");
		assert.equal(second.isError, true);
		assert.equal(messageText(second as Message), HANDOFF_FAILED_IN_RUN_REFUSAL);
		assert.equal(requestsAfterHandoffRun, 3, "ready, the first handoff, and the follow-on turn whose handoff was refused; the batch terminated");
		assert.equal(failuresAfterHandoffRun, 1, "one failed cut in the run");
		const third = toolResultFor(sessionManager, "call-third");
		assert.ok(third, "the next run's handoff has a tool result");
		assert.equal(third.isError, false);
		assert.equal(messageText(third as Message), HANDOFF_STAGED_RESULT);
		assert.deepEqual(observed.extensionErrors, []);
	});

	it("tells the user no request remains pending when a failed cut exhausts the budget, and cancels it at settle", async () => {
		const dropKeepingContinuation: ExtensionFactory = (pi) => {
			pi.on("turn_end", async (event) => (event.entries.length > 0 ? { entries: [] } : undefined));
		};
		let nudgedCalls = 0;
		const handoffWhenNudged: FauxResponseFactory = (context) => {
			if (carriesRequiredNudge(context.messages)) {
				nudgedCalls += 1;
				return fauxAssistantMessage([fauxToolCall("handoff", { nextInstruction: "x", context: HANDOFF_CONTEXT }, { id: `call-handoff-${nudgedCalls}` })]);
			}
			return fauxAssistantMessage("plain answer");
		};
		const ui: string[] = [];
		const { session, sessionManager, observed } = await startSession(
			Array.from({ length: 2 * MAX_HANDOFF_ATTEMPTS + 4 }, () => handoffWhenNudged),
			{ after: [dropKeepingContinuation], ui: recordingUI(ui) },
		);
		let uiAtExhaustingSettle: number;
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settleRuns(session, observed, 2);
			// Each nudged run counts one attempt; the last retry runs at
			// enforcementAttempts = MAX_HANDOFF_ATTEMPTS - 1 and exhausts the budget.
			for (let attempt = 1; attempt < MAX_HANDOFF_ATTEMPTS; attempt++) {
				await session.prompt("retry");
				await settleRuns(session, observed, 2 + attempt);
			}
			uiAtExhaustingSettle = ui.length;
			await session.prompt("after the budget");
			await settleRuns(session, observed, 2 + MAX_HANDOFF_ATTEMPTS);
		} finally {
			session.dispose();
		}

		const failures = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE)
			.map((entry) => (entry.type === "custom_message" ? entry.content : undefined));
		assert.deepEqual(failures, [
			...Array.from({ length: MAX_HANDOFF_ATTEMPTS - 1 }, () => formatHandoffFailure(REASON_NOT_PERSISTED, true)),
			formatHandoffFailure(REASON_NOT_PERSISTED, false),
		]);
		const failureNotify = `notify:error:Handoff failed: ${REASON_NOT_PERSISTED}. The handoff can be retried.`;
		const failureAt = ui.flatMap((line, index) => (line === failureNotify ? [index] : []));
		assert.equal(failureAt.length, MAX_HANDOFF_ATTEMPTS, JSON.stringify(ui));
		// The failure sets the handoff status right before its notify.
		assert.deepEqual(failureAt.map((index) => ui[index - 1]), [
			...Array.from({ length: MAX_HANDOFF_ATTEMPTS - 1 }, () => `status:${STATUS_KEY_HANDOFF}:${HANDOFF_REQUIRED_STATUS}`),
			`status:${STATUS_KEY_HANDOFF}:undefined`,
		]);
		const cancelledAt = ui.flatMap((line, index) =>
			(line.startsWith(`notify:warning:Required handoff cancelled after ${MAX_HANDOFF_ATTEMPTS} attempts`) ? [index] : []));
		assert.equal(cancelledAt.length, 1, JSON.stringify(ui));
		assert.ok(cancelledAt[0] > failureAt.at(-1)! && cancelledAt[0] < uiAtExhaustingSettle,
			"the watchdog cancels the request at the settle of the run whose cut failed last");
		assert.ok(!carriesRequiredNudge(observed.requests.at(-1) ?? []), "the cancelled request is no longer enforced");
		assert.deepEqual(observed.extensionErrors, []);
	});
});
