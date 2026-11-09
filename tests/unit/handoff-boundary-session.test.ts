/**
 * Runs the handoff boundary inside a real pi agent session, so pi's own runner
 * decides what a turn_end boundary commits, when the continuation turn runs and
 * what the provider receives. Handler-level behaviour is covered by
 * handoff.test.ts; this file pins the pi semantics that design relies on.
 *
 * Isolation as in prompt-sections-session.test.ts. The faux provider reports
 * usage as chars / 4 of the request, so a large first prompt makes the handoff
 * eligible.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
	type SessionBoundaryDraft,
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
} from "../../handoff/format.js";
import {
	HANDOFF_FAILED_IN_RUN_REFUSAL,
	HANDOFF_NOT_ALONE_REFUSAL,
	HANDOFF_REQUIRED_STATUS,
	HANDOFF_STAGED_RESULT,
	HANDOFF_SUCCESSOR_NOT_RUN,
	REASON_ABORTED,
	REASON_NOT_PERSISTED,
	REASON_SUCCESSOR_NOT_PERSISTED,
} from "../../handoff/copy.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS, buildNudge } from "../../watchdog.js";
import { createDeferred, setTempHome } from "./helpers.js";
import { assertPresent } from "../assertions.js";

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

beforeAll(async () => {
	sandboxDir = await mkdtemp(join(os.tmpdir(), "pi-schematic-handoff-boundary-"));
	restoreHome = setTempHome(sandboxDir);
	process.env.PI_OFFLINE = "1";
});

afterAll(async () => {
	restoreHome();
	if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousPiOffline;
	await rm(sandboxDir, { recursive: true, force: true });
});

/** Narrows `entry` to the session entry type `type`; the type check is the one counted assertion. */
function assertEntryType<T extends SessionEntry["type"]>(
	entry: SessionEntry,
	type: T,
): asserts entry is Extract<SessionEntry, { type: T }> {
	expect(entry.type).toBe(type);
}

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
		expect(labels.slice(-4)).toStrictEqual([
			"compaction",
			`custom_message:${HANDOFF_SUCCESSOR_CUSTOM_TYPE}`,
			`custom_message:${HANDOFF_NOTE_CUSTOM_TYPE}`,
			"message",
		]);
		const [cut] = entriesOf(sessionManager, "compaction");
		assertEntryType(cut, "compaction");
		expect(cut.firstKeptEntryId, "a retain-none cut keeps nothing before itself").toBe(cut.id);
		expect(cut.summary).toBe(buildContinuationFrame());
		const handoffId = (cut.details as { handoffId?: unknown }).handoffId;
		expect(typeof handoffId).toBe("string");
		const [successor] = entriesOf(sessionManager, "custom_message", HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		const [note] = entriesOf(sessionManager, "custom_message", HANDOFF_NOTE_CUSTOM_TYPE);
		assertEntryType(successor, "custom_message");
		assertEntryType(note, "custom_message");
		expect(successor.parentId).toBe(cut.id);
		expect(successor.content).toBe(buildNextUserMessage({ nextInstruction: NEXT_INSTRUCTION, context: HANDOFF_CONTEXT }));
		expect(successor.display).toBe(true);
		expect(successor.details).toStrictEqual({ handoffId });
		expect(note.content).toBe(buildHandoffSystemPromptNote());
		expect(note.display).toBe(false);
		expect(observed.extensionErrors).toStrictEqual([]);
	});

	it("continues the calling run for the successor turn without a new agent start or compaction events", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		expect(observed.events).toStrictEqual(["before_agent_start", "agent_start", "agent_settled"]);
		expect(observed.requests.length).toBe(2);
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
		expect(successorRequest.length, `successor request: ${JSON.stringify(successorRequest.map((text) => text.slice(0, 60)))}`).toBe(3);
		// pi wraps the summary in its own fixed prefix and suffix; convertToLlm applies that wrapping.
		const [frameMessage] = convertToLlm([{ role: "compactionSummary", summary: buildContinuationFrame(), tokensBefore: 0, timestamp: 0 }]);
		expect(successorRequest[0]).toBe(messageText(frameMessage));
		expect(successorRequest[1]).toBe(buildNextUserMessage({ nextInstruction: NEXT_INSTRUCTION, context: HANDOFF_CONTEXT }));
		expect(successorRequest[2]).toBe(buildHandoffSystemPromptNote());
		expect(successorRequest, "the pre-cut prompt is gone").not.toContainEqual(expect.stringContaining(LARGE_PROMPT));
		expect(successorRequest, "the pre-cut handoff result is gone").not.toContainEqual(expect.stringContaining(HANDOFF_STAGED_RESULT));
	});

	it("lets turn_start read the committed boundary from the branch", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		expect(observed.branchAtTurnStart.length).toBe(2);
		expect(observed.branchAtTurnStart[1].slice(-3)).toStrictEqual([
			"compaction",
			`custom_message:${HANDOFF_SUCCESSOR_CUSTOM_TYPE}`,
			`custom_message:${HANDOFF_NOTE_CUSTOM_TYPE}`,
		]);
	});

	it("reports the faux usage of a large prompt as eligible at the handoff call", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		expect(observed.usageAtHandoffCall.length).toBe(1);
		const tokens = observed.usageAtHandoffCall[0]?.tokens;
		expect(tokens, `usage at the handoff call: ${String(tokens)}`).toBeTypeOf("number");
		expect(tokens, `usage at the handoff call: ${String(tokens)}`).toBeGreaterThanOrEqual(MIN_HANDOFF_TOKENS);
	});

	// With no enforced request or pending topic hint, the context hook skips the watchdog
	// nudge when pi reports null usage, so the successor of a model-called handoff carries no nudge.
	it("reports no usage percent at the successor request right after the cut", async () => {
		const { session, observed } = await startSession([call(handoffCall()), reply("successor answer")]);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		expect(observed.usageAtContext.length, "the handoff request and the successor request").toBe(2);
		expect(observed.usageAtContext[1]?.percent, "usage at the successor request").toBe(null);
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

		expect(observed.requests.length).toBe(3);
		expect(observed.requests[1], "the handoff request was enforced before the cut").toSatisfy(carriesRequiredNudge);
		const successorRequest = nonSystem(observed.requests[2]).map(messageText);
		expect(successorRequest[1]).toBe(buildNextUserMessage({ nextInstruction: "finish the report", context: HANDOFF_CONTEXT }));
		expect(successorRequest.length, "no watchdog message follows the note").toBe(3);
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
			assertPresent(handoffResult, "the handoff has a tool result");
			expect(handoffResult.isError).toBe(true);
			expect(messageText(handoffResult as Message)).toBe(HANDOFF_NOT_ALONE_REFUSAL);
			expect(toolResultFor(sessionManager, "call-sibling")?.isError, "the notebook_write ran").toBe(false);
			expect(entriesOf(sessionManager, "custom", "notebook-entry").length, "the notebook entry is persisted").toBe(1);
			expect(entriesOf(sessionManager, "compaction"), "no cut is written").toStrictEqual([]);
			expect(entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE), "nothing was staged, so nothing fails").toStrictEqual([]);
			expect(observed.requests.length, "the batch did not end the run; the model was asked again").toBe(2);
			expect(nonSystem(observed.requests[1]).filter((message) => message.role === "toolResult").map(messageText),
				"the next request carries the refusal").toContain(HANDOFF_NOT_ALONE_REFUSAL);
			expect(observed.extensionErrors).toStrictEqual([]);
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
		expect(labels.slice(cutIndex - 3, cutIndex)).toStrictEqual([
			"custom:notebook-generation",
			"custom:notebook-entry",
			"custom:notebook-generation",
		]);
		const indexResult = toolResultFor(sessionManager, "call-index");
		assertPresent(indexResult, "the successor ran notebook_index");
		const indexText = messageText(indexResult as Message);
		expect(indexText, indexText).toContain("keep-page");
		expect(indexText, indexText).not.toContain("drop-page");
		expect(observed.extensionErrors).toStrictEqual([]);
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

		expect(requestsAfterHandoffRun, "the successor turn did not run").toBe(2);
		expect(entriesOf(sessionManager, "compaction").length, "the cut is persisted").toBe(1);
		expect(observed.extensionErrors, "the next /handoff was accepted").toStrictEqual([]);
		expect(nonSystem(observed.requests[2]).map(messageText),
			"the next run's request carries the persisted successor").toContain(buildNextUserMessage({ nextInstruction: "finish the report", context: HANDOFF_CONTEXT }));
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

		expect(abortedAtTurnStart, "the successor turn starts with the signal already aborted").toStrictEqual([false, false, true, false]);
		expect(requestsAfterHandoffRun, "the aborted successor turn made no provider request").toBe(2);
		const cuts = entriesOf(sessionManager, "compaction");
		expect(cuts.length, "the cut is persisted").toBe(1);
		const [cut] = cuts;
		assertEntryType(cut, "compaction");
		const handoffId = (cut.details as { handoffId?: unknown }).handoffId;
		expect(typeof handoffId).toBe("string");
		const successors = entriesOf(sessionManager, "custom_message", HANDOFF_SUCCESSOR_CUSTOM_TYPE);
		expect(successors.length, "the successor is persisted").toBe(1);
		assertEntryType(successors[0], "custom_message");
		expect(successors[0].details).toStrictEqual({ handoffId });
		expect(entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE)).toStrictEqual([]);
		expect(ui, JSON.stringify(ui)).toContain(`notify:info:${formatHandoffComplete(false, 0, 0)}`);
		expect(ui, JSON.stringify(ui)).not.toContain(`notify:warning:${HANDOFF_SUCCESSOR_NOT_RUN}`);
		expect(observed.requests[2], "the request was finalized, so the next prompt is not enforced").not.toSatisfy(carriesRequiredNudge);
		expect(nonSystem(observed.requests[2]).map(messageText),
			"the next prompt's request carries the successor").toContain(buildNextUserMessage({ nextInstruction: "finish the report", context: HANDOFF_CONTEXT }));
		expect(observed.extensionErrors).toStrictEqual([]);
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

		expect(observed.requests.length).toBe(5);
		const beforeHandoff = getCurrentSystemPrompt(observed.requests[2]);
		expect(beforeHandoff, beforeHandoff).toContain("Current topic: `oauth`");
		expect(beforeHandoff, beforeHandoff).toContain("  stale: obsolete finding");
		const afterHandoff = getCurrentSystemPrompt(observed.requests[4]);
		expect(afterHandoff, afterHandoff).toContain("No active notebook topic is set.");
		expect(afterHandoff, afterHandoff).not.toContain("Current topic:");
		expect(afterHandoff, afterHandoff).toContain("  keep: durable decision");
		expect(afterHandoff, afterHandoff).not.toContain("stale: obsolete finding");
		expect(observed.extensionErrors).toStrictEqual([]);
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
		const handoffTool = session.getToolDefinition("handoff");
		assertPresent(handoffTool, "schematic registers the handoff tool");
		let handoffExecutions = 0;
		const execute = handoffTool.execute;
		handoffTool.execute = (...args) => {
			handoffExecutions += 1;
			return execute(...args);
		};
		try {
			await session.prompt(LARGE_PROMPT);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		expect(outcomes.length).toBe(1);
		expect(handoffExecutions, "pi refuses the nested call before the handoff tool runs").toBe(0);
		expect(outcomes[0].isError, outcomes[0].text).toBe(true);
		expect(toolResultFor(sessionManager, "call-nested")?.isError).toBe(false);
		expect(entriesOf(sessionManager, "compaction"), "no cut is written").toStrictEqual([]);
		expect(entriesOf(sessionManager, "custom_message", HANDOFF_SUCCESSOR_CUSTOM_TYPE)).toStrictEqual([]);
		expect(entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE), "nothing was staged, so nothing fails at settle").toStrictEqual([]);
		expect(observed.requests.length).toBe(2);
		expect(observed.extensionErrors).toStrictEqual([]);
	});
});

describe("failed handoff cut in a real agent session", () => {
	// `requests` is the provider requests of the handoff run after "ready"; the
	// follow-on turn adds one only when the dropper keeps the continuation.
	const dropVariants: { name: string; result: { entries: []; continue?: false }; requests: number }[] = [
		{ name: "the dropper keeps the continuation", result: { entries: [] }, requests: 2 },
		{ name: "the dropper stops the continuation", result: { entries: [], continue: false }, requests: 1 },
	];
	for (const variant of dropVariants) {
		it(`persists the failure guidance without starting a run and keeps the request pending when a later extension drops the boundary (${variant.name})`, async () => {
			const dropBoundary: ExtensionFactory = (pi) => {
				pi.on("turn_end", async (event) => (event.entries.length > 0 ? variant.result : undefined));
			};
			// Hand-written, not the formatter's output: the persisted guidance is what
			// this test pins.
			const guidance = `Handoff failed — ${REASON_NOT_PERSISTED}. The required handoff remains pending; retry when context usage is eligible.`;
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

			expect(runsAfterHandoffRun, "the first prompt's run and the /handoff run; the failure starts no run").toBe(2);
			expect(requestsAfterHandoffRun).toBe(1 + variant.requests);
			expect(entriesOf(sessionManager, "compaction"), "no cut on the branch").toStrictEqual([]);
			const failures = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE);
			expect(failures.length).toBe(1);
			const [failure] = failures;
			assertEntryType(failure, "custom_message");
			expect(failure.content).toBe(guidance);
			expect(failure.display).toBe(true);
			const userTexts = sessionManager.getBranch().flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message as Message)] : []);
			expect(userTexts.filter((text) => text.includes("Handoff failed")), "no user message announces the failure").toStrictEqual([]);
			expect(observed.requests.at(-1) ?? [], "the request stays pending and is enforced on the next prompt").toSatisfy(carriesRequiredNudge);
			expect(observed.extensionErrors).toStrictEqual([]);
		});
	}

	// Each tamper keeps the cut but leaves no successor in context after it, once.
	const lostSuccessorVariants: { name: string; tamper: (entries: SessionBoundaryDraft[]) => SessionBoundaryDraft[] }[] = [
		{
			name: "a later extension drops the successor",
			tamper: (entries) => entries.filter((entry) => !(entry.type === "custom_message" && entry.customType === HANDOFF_SUCCESSOR_CUSTOM_TYPE)),
		},
		{
			name: "a later extension appends a compaction after the cut",
			tamper: (entries) => [...entries, { type: "compaction", summary: "another extension's summary", firstKeptEntryId: null }],
		},
	];
	for (const variant of lostSuccessorVariants) {
		it(`fails the handoff, aborts the continuation and clears the request when the cut lands without its successor (${variant.name})`, async () => {
			let tampered = false;
			const tamperBoundary: ExtensionFactory = (pi) => {
				pi.on("turn_end", async (event) => {
					if (tampered || event.entries.length === 0) return undefined;
					tampered = true;
					return { entries: variant.tamper(event.entries) };
				});
			};
			const ui: string[] = [];
			const { session, sessionManager, observed } = await startSession(
				[reply("ready"), call(handoffCall()), call(fauxToolCall("handoff", { nextInstruction: NEXT_INSTRUCTION }, { id: "call-later" })), reply("successor answer")],
				{ after: [tamperBoundary], ui: recordingUI(ui) },
			);
			let requestsAfterHandoffRun: number;
			let uiAfterHandoffRun: string[];
			try {
				await session.prompt(LARGE_PROMPT);
				await session.prompt("/handoff finish the report");
				await settleRuns(session, observed, 2);
				requestsAfterHandoffRun = observed.requests.length;
				uiAfterHandoffRun = [...ui];
				await session.prompt(LARGE_PROMPT);
				await settleRuns(session, observed, 3);
			} finally {
				session.dispose();
			}

			const lostSuccessor = buildNextUserMessage({ nextInstruction: "finish the report", context: HANDOFF_CONTEXT });
			expect(requestsAfterHandoffRun, "the continuation turn is aborted before it reaches the model").toBe(2);
			const failures = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE);
			expect(failures.length).toBe(1);
			const [failure] = failures;
			assertEntryType(failure, "custom_message");
			expect(typeof failure.content).toBe("string");
			expect((failure.content as string), "the failure carries the instruction").toContain("## Next instruction\n\nfinish the report");
			expect((failure.content as string), "the failure carries the context").toContain(HANDOFF_CONTEXT);
			expect(failure.display).toBe(true);
			expect(uiAfterHandoffRun, JSON.stringify(uiAfterHandoffRun)).toContain(`notify:error:Handoff failed: ${REASON_SUCCESSOR_NOT_PERSISTED}. The instruction is in the failure message.`);
			expect(uiAfterHandoffRun.filter((line) => line.startsWith("notify:info:Handoff complete")), "no completion notice").toStrictEqual([]);
			expect(uiAfterHandoffRun, "no successor-not-run warning").not.toContain(`notify:warning:${HANDOFF_SUCCESSOR_NOT_RUN}`);
			const nextRequest = nonSystem(observed.requests[2]).map(messageText);
			expect(nextRequest, "no successor reaches the next run").not.toContain(lostSuccessor);
			expect(observed.requests[2], "the request was cleared, so the next run is not enforced").not.toSatisfy(carriesRequiredNudge);
			const later = toolResultFor(sessionManager, "call-later");
			assertPresent(later, "the later handoff has a tool result");
			expect(messageText(later as Message), "a later handoff is accepted").toBe(HANDOFF_STAGED_RESULT);
			expect(sessionManager.getBranch().map(entryLabel).slice(-4), "the later handoff lands its cut and successor").toStrictEqual([
				"compaction",
				`custom_message:${HANDOFF_SUCCESSOR_CUSTOM_TYPE}`,
				`custom_message:${HANDOFF_NOTE_CUSTOM_TYPE}`,
				"message",
			]);
			expect(observed.extensionErrors).toStrictEqual([]);
		});
	}

	it("fails the handoff at settle without an abort and clears the request when a later extension drops the successor and stops the continuation", async () => {
		const dropSuccessorAndStop: ExtensionFactory = (pi) => {
			pi.on("turn_end", async (event) => (event.entries.length > 0
				? { entries: lostSuccessorVariants[0].tamper(event.entries), continue: false }
				: undefined));
		};
		const ui: string[] = [];
		const { session, sessionManager, observed } = await startSession(
			[reply("ready"), call(handoffCall()), reply("next prompt answer")],
			{ after: [dropSuccessorAndStop], ui: recordingUI(ui) },
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

		expect(requestsAfterHandoffRun, "the stopped continuation made no request").toBe(2);
		const abortedReplies = sessionManager.getBranch().filter((entry) =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted");
		expect(abortedReplies, "nothing was aborted").toStrictEqual([]);
		const failures = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE);
		expect(failures.length).toBe(1);
		const [failure] = failures;
		assertEntryType(failure, "custom_message");
		expect(typeof failure.content).toBe("string");
		expect((failure.content as string), "the failure carries the instruction").toContain("## Next instruction\n\nfinish the report");
		expect((failure.content as string), "the failure carries the context").toContain(HANDOFF_CONTEXT);
		expect(ui, JSON.stringify(ui)).toContain(`notify:error:Handoff failed: ${REASON_SUCCESSOR_NOT_PERSISTED}. The instruction is in the failure message.`);
		expect(ui.filter((line) => line.startsWith("notify:info:Handoff complete")), "no completion notice").toStrictEqual([]);
		expect(ui, "no successor-not-run warning").not.toContain(`notify:warning:${HANDOFF_SUCCESSOR_NOT_RUN}`);
		expect(observed.requests[2], "the request was cleared, so the next prompt is not enforced").not.toSatisfy(carriesRequiredNudge);
		expect(observed.extensionErrors).toStrictEqual([]);
	});

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

		expect(runsAfterAbort, "the first prompt's run and the aborted /handoff run; no failure run").toBe(2);
		expect(requestsAfterAbort).toBe(2);
		expect(entriesOf(sessionManager, "compaction"), "no cut on the branch").toStrictEqual([]);
		expect(failuresAfterAbort.length, "the failure is persisted when the aborted run settles").toBe(1);
		const [failure] = failuresAfterAbort;
		assertEntryType(failure, "custom_message");
		expect(failure.content).toBe(`Handoff failed — ${REASON_ABORTED}. The required handoff remains pending; retry when context usage is eligible.`);
		expect(failure.display).toBe(true);
		expect(observed.requests[2], "the request stays pending and is enforced on the next prompt").toSatisfy(carriesRequiredNudge);
		expect(observed.extensionErrors).toStrictEqual([]);
	});

	/**
	 * Exhausts the handoff budget while a later extension drops every boundary with
	 * `dropResult`; the model calls handoff whenever its request carries the required
	 * nudge, and `nudgedCalls` counts those calls. With `ui`, `uiBeforeLastPrompt` is
	 * the length of `ui` before the final prompt.
	 */
	async function exhaustHandoffBudget(dropResult: { entries: []; continue?: false }, ui?: string[]) {
		const dropBoundary: ExtensionFactory = (pi) => {
			pi.on("turn_end", async (event) => (event.entries.length > 0 ? dropResult : undefined));
		};
		let nudgedCalls = 0;
		const handoffWhenNudged: FauxResponseFactory = (context) => {
			if (carriesRequiredNudge(context.messages)) {
				nudgedCalls += 1;
				return fauxAssistantMessage([fauxToolCall("handoff", { nextInstruction: "x", context: HANDOFF_CONTEXT }, { id: `call-handoff-${nudgedCalls}` })]);
			}
			return fauxAssistantMessage("plain answer");
		};
		// A kept continuation spends a second request per attempt; size the script for that case.
		const { session, sessionManager, observed } = await startSession(
			Array.from({ length: 2 * MAX_HANDOFF_ATTEMPTS + 4 }, () => handoffWhenNudged),
			{ after: [dropBoundary], ...(ui === undefined ? {} : { ui: recordingUI(ui) }) },
		);
		let uiBeforeLastPrompt: number | undefined;
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settleRuns(session, observed, 2);
			// Nothing starts a run on its own, so each retry is a user prompt.
			for (let attempt = 1; attempt < MAX_HANDOFF_ATTEMPTS; attempt++) {
				await session.prompt("retry");
				await settleRuns(session, observed, 2 + attempt);
			}
			uiBeforeLastPrompt = ui?.length;
			await session.prompt("after the budget");
			await settleRuns(session, observed, 2 + MAX_HANDOFF_ATTEMPTS);
		} finally {
			session.dispose();
		}
		return { sessionManager, observed, nudgedCalls, uiBeforeLastPrompt };
	}

	it("counts each failed cut against the enforcement budget until the request is cancelled", async () => {
		const { observed, nudgedCalls } = await exhaustHandoffBudget({ entries: [], continue: false });

		expect(nudgedCalls).toBe(MAX_HANDOFF_ATTEMPTS);
		expect(observed.requests.length, "first prompt, one request per failed attempt, then the unenforced prompt").toBe(MAX_HANDOFF_ATTEMPTS + 2);
		expect(observed.requests.at(-1) ?? [], "the cancelled request is no longer enforced").not.toSatisfy(carriesRequiredNudge);
		expect(observed.extensionErrors).toStrictEqual([]);
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
		assertPresent(second, "the second handoff has a tool result");
		expect(second.isError).toBe(true);
		expect(messageText(second as Message)).toBe(HANDOFF_FAILED_IN_RUN_REFUSAL);
		expect(requestsAfterHandoffRun, "ready, the first handoff, and the follow-on turn whose handoff was refused; the batch terminated").toBe(3);
		expect(failuresAfterHandoffRun, "one failed cut in the run").toBe(1);
		const third = toolResultFor(sessionManager, "call-third");
		assertPresent(third, "the next run's handoff has a tool result");
		expect(third.isError).toBe(false);
		expect(messageText(third as Message)).toBe(HANDOFF_STAGED_RESULT);
		expect(observed.extensionErrors).toStrictEqual([]);
	});

	it("tells the user no request remains pending when a failed cut exhausts the budget, and cancels it at settle", async () => {
		const ui: string[] = [];
		const { sessionManager, observed, uiBeforeLastPrompt: uiAtExhaustingSettle } = await exhaustHandoffBudget({ entries: [] }, ui);

		const failures = entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE)
			.map((entry) => (entry.type === "custom_message" ? entry.content : undefined));
		expect(failures).toStrictEqual([
			...Array.from({ length: MAX_HANDOFF_ATTEMPTS - 1 }, () =>
				`Handoff failed — ${REASON_NOT_PERSISTED}. The required handoff remains pending; retry when context usage is eligible.`),
			`Handoff failed — ${REASON_NOT_PERSISTED}. No required handoff remains pending; retry when ready.`,
		]);
		const failureNotify = `notify:error:Handoff failed: ${REASON_NOT_PERSISTED}. The handoff can be retried.`;
		const failureAt = ui.flatMap((line, index) => (line === failureNotify ? [index] : []));
		expect(failureAt.length, JSON.stringify(ui)).toBe(MAX_HANDOFF_ATTEMPTS);
		// The failure sets the handoff status right before its notify.
		expect(failureAt.map((index) => ui[index - 1])).toStrictEqual([
			...Array.from({ length: MAX_HANDOFF_ATTEMPTS - 1 }, () => `status:${STATUS_KEY_HANDOFF}:${HANDOFF_REQUIRED_STATUS}`),
			`status:${STATUS_KEY_HANDOFF}:undefined`,
		]);
		const cancelledAt = ui.flatMap((line, index) =>
			(line.startsWith(`notify:warning:Required handoff cancelled after ${MAX_HANDOFF_ATTEMPTS} attempts`) ? [index] : []));
		expect(cancelledAt.length, JSON.stringify(ui)).toBe(1);
		expect(cancelledAt[0], "the watchdog cancels the request at the settle of the run whose cut failed last").toBeGreaterThan(failureAt.at(-1)!);
		expect(cancelledAt[0], "the watchdog cancels the request at the settle of the run whose cut failed last").toBeLessThan(uiAtExhaustingSettle!);
		expect(observed.requests.at(-1) ?? [], "the cancelled request is no longer enforced").not.toSatisfy(carriesRequiredNudge);
		expect(observed.extensionErrors).toStrictEqual([]);
	});
});
