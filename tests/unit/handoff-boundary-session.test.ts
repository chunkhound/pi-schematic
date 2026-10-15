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
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
	type Message,
} from "@earendil-works/pi-ai";
import registerSchematic from "../../index.js";
import { MIN_HANDOFF_TOKENS } from "../../handoff/eligibility.js";
import {
	HANDOFF_FAILED_CUSTOM_TYPE,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SUCCESSOR_CUSTOM_TYPE,
	buildContinuationFrame,
	buildHandoffSystemPromptNote,
	buildNextUserMessage,
	formatHandoffFailure,
} from "../../handoff/format.js";
import { HANDOFF_SIBLING_REFUSAL, HANDOFF_STAGED_RESULT, REASON_ABORTED, REASON_NOT_PERSISTED } from "../../handoff/copy.js";
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
 * Start a real session with schematic. `before` factories load ahead of
 * schematic, `after` factories behind it (and ahead of the observer). Every
 * response factory records the request it answers.
 */
async function startSession(
	responses: FauxResponseFactory[],
	extensions: { before?: ExtensionFactory[]; after?: ExtensionFactory[] } = {},
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
	await session.bindExtensions({ onError: (error) => observed.extensionErrors.push(`${error.event}: ${error.error}`) });
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
		it(`refuses a tool call that shares the message with handoff (${order})`, async () => {
			const sibling = fauxToolCall("notebook_write", { name: "sibling-page", content: "should never be written" }, { id: "call-sibling" });
			const calls = order === "handoff first" ? [handoffCall(), sibling] : [sibling, handoffCall()];
			const { session, sessionManager, observed } = await startSession([call(...calls), reply("successor answer")]);
			try {
				await session.prompt(LARGE_PROMPT);
				await session.waitForIdle();
			} finally {
				session.dispose();
			}

			const siblingResult = toolResultFor(sessionManager, "call-sibling");
			assert.ok(siblingResult, "the sibling has a tool result");
			assert.equal(siblingResult.isError, true);
			assert.equal(messageText(siblingResult as Message), HANDOFF_SIBLING_REFUSAL);
			assert.deepEqual(entriesOf(sessionManager, "custom", "notebook-entry"), [], "no notebook page was written");
			assert.equal(entriesOf(sessionManager, "compaction").length, 1, "the cut is persisted");
			assert.equal(observed.requests.length, 2, "the batch ended; only the successor turn followed it");
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
});

describe("failed handoff cut in a real agent session", () => {
	// `runs` counts agent starts: the first prompt's run, the /handoff run, and a
	// guidance run only when the handoff run had already ended.
	const dropVariants: { name: string; result: { entries: []; continue?: false }; runs: number }[] = [
		{ name: "the guidance follows up inside the handoff run", result: { entries: [] }, runs: 2 },
		{ name: "the guidance starts a new run", result: { entries: [], continue: false }, runs: 3 },
	];
	for (const variant of dropVariants) {
		it(`sends failure guidance and keeps the request pending when a later extension drops the boundary (${variant.name})`, async () => {
			const dropBoundary: ExtensionFactory = (pi) => {
				pi.on("turn_end", async (event) => (event.entries.length > 0 ? variant.result : undefined));
			};
			const guidance = formatHandoffFailure(REASON_NOT_PERSISTED, true);
			const carriesGuidance = (request: Message[]) =>
				request.some((message) => message.role === "user" && messageText(message) === guidance);
			const guidanceAnswered = createDeferred();
			const answer: FauxResponseFactory = (context) => {
				if (carriesGuidance(context.messages)) guidanceAnswered.resolve();
				return fauxAssistantMessage("plain answer");
			};
			const { session, sessionManager, observed } = await startSession(
				[reply("ready"), call(handoffCall()), answer, answer],
				{ after: [dropBoundary] },
			);
			try {
				await session.prompt(LARGE_PROMPT);
				await session.prompt("/handoff finish the report");
				await settle(session, guidanceAnswered.promise, "a request carrying the failure guidance");
			} finally {
				session.dispose();
			}

			assert.deepEqual(entriesOf(sessionManager, "compaction"), [], "no cut on the branch");
			const guidanceRequest = observed.requests.find(carriesGuidance);
			assert.ok(guidanceRequest, "the failure guidance reached the model as a user message");
			assert.ok(carriesRequiredNudge(guidanceRequest), "the request stays pending and is enforced again");
			assert.deepEqual(entriesOf(sessionManager, "custom_message", HANDOFF_FAILED_CUSTOM_TYPE), [], "the guidance is a user follow-up, not the abort message");
			assert.equal(observed.events.filter((name) => name === "agent_start").length, variant.runs);
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
		const unnudgedAnswer = createDeferred();
		let nudgedRuns = 0;
		const handoffWhenNudged: FauxResponseFactory = (context) => {
			if (carriesRequiredNudge(context.messages)) {
				nudgedRuns += 1;
				return fauxAssistantMessage([fauxToolCall("handoff", { nextInstruction: "x", context: HANDOFF_CONTEXT }, { id: `call-handoff-${nudgedRuns}` })]);
			}
			if (nudgedRuns > 0) unnudgedAnswer.resolve();
			return fauxAssistantMessage("plain answer");
		};
		const { session, observed } = await startSession(
			Array.from({ length: MAX_HANDOFF_ATTEMPTS + 4 }, () => handoffWhenNudged),
			{ after: [dropBoundary] },
		);
		try {
			await session.prompt(LARGE_PROMPT);
			await session.prompt("/handoff finish the report");
			await settle(session, unnudgedAnswer.promise, "a request without the required-handoff nudge");
		} finally {
			session.dispose();
		}

		assert.equal(nudgedRuns, MAX_HANDOFF_ATTEMPTS);
		assert.equal(observed.requests.length, MAX_HANDOFF_ATTEMPTS + 2, "first prompt, one request per failed attempt, then the unenforced follow-up");
		assert.deepEqual(observed.extensionErrors, []);
	});
});
