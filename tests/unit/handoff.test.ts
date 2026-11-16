import { expect, test } from "vitest";
import { expectPrefix, expectSuffix } from "../assertions.js";
import { Value } from "typebox/value";
import { createState } from "../../state.js";
import type { SchematicState } from "../../state.js";
import { registerHandoffBoundary } from "../../handoff/boundary.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { buildContinuationFrame, buildNextUserMessage, formatLostSuccessorFailure } from "../../handoff/format.js";
import { STATUS_KEY_HANDOFF, STATUS_KEY_NOTEBOOK, STATUS_KEY_TOPIC } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS, registerWatchdog } from "../../watchdog.js";
import {
	SessionManager,
	type ContextUsage,
	type CustomMessageEntryDraft,
	type ExtensionFactory,
	type ExtensionRunner,
	type SessionBoundaryDraft,
	type ToolCallEventResult,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { assertPresent } from "../assertions.js";
import { createRunner, type RunnerFixture } from "../support/runner.js";
import { appendDrafts, ZERO_USAGE } from "../support/session.js";
import { realTheme } from "../support/theme.js";

type ContextMessage = Awaited<ReturnType<ExtensionRunner["emitContext"]>>[number];
type BoundaryResult = Awaited<ReturnType<ExtensionRunner["emitBoundary"]>>;

const ELIGIBLE_USAGE: ContextUsage = { tokens: 50_000, percent: 25, contextWindow: 200_000 };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONTINUATION_FRAME = [
	"## Handoff — Continue Previous Work",
	"",
	"You are continuing a previous agent's work in a clean context. Use the available knowledge correctly:",
	"- Notebook pages are a cache for this stream: code facts are re-derivable, while user guidance, decisions, and design live in pages — fetch them with `notebook_read`",
	"- The next message carries your instruction verbatim, plus the previous agent's remaining situational context",
	"- Use `notebook_index` to scan available pages when needed",
	"- Use `spawn` to delegate isolated subtasks to child agents",
	"- Build on notebook memory and the instruction rather than reconstructing old context",
].join("\n");

const NOT_PERSISTED = "pi did not persist the cut (another extension replaced the turn_end entries, or pi rejected them)";
const PENDING_SUFFIX = "The required handoff remains pending; retry when context usage is eligible.";
const NOT_PENDING_SUFFIX = "No required handoff remains pending; retry when ready.";

/** The handoff command, tool and boundary (or `factories`) on a runner over a seeded state, an in-memory session, and the recording UI. */
interface HandoffHost {
	state: SchematicState;
	fixture: RunnerFixture;
	session: SessionManager;
	setUsage: (usage: ContextUsage | undefined) => void;
	setSignal: (signal: AbortSignal | undefined) => void;
}

interface HostOptions {
	seed?: (state: SchematicState) => void;
	/** The extension factories over the seeded state; the handoff command, tool and boundary when omitted. */
	factories?: (state: SchematicState) => ExtensionFactory[];
	/** Load the shipped extension instead of `factories`; `state` is then a fresh state the extension does not read. */
	shipped?: boolean;
	idle?: boolean;
}

function handoffFactories(state: SchematicState): ExtensionFactory[] {
	return [
		(api) => {
			registerHandoffCommand(api, state);
			registerHandoffTool(api, state);
			registerHandoffBoundary(api, state);
		},
	];
}

async function boundaryHost(options: HostOptions = {}): Promise<HandoffHost> {
	const state = createState();
	options.seed?.(state);
	let usage: ContextUsage | undefined = ELIGIBLE_USAGE;
	let signal: AbortSignal | undefined;
	const cwd = process.cwd();
	const session = SessionManager.inMemory(cwd);
	const fixture = await createRunner({
		cwd,
		mode: "tui",
		factories: options.shipped === true ? undefined : (options.factories ?? handoffFactories)(state),
		sessionManager: session,
		ui: { theme: realTheme },
		context: {
			getContextUsage: () => usage,
			getSignal: () => signal,
			isIdle: () => options.idle ?? true,
			abort: () => undefined,
		},
		activeTools: [],
	});
	return {
		state,
		fixture,
		session,
		setUsage: (next) => {
			usage = next;
		},
		setSignal: (next) => {
			signal = next;
		},
	};
}

function requestHandoff(state: SchematicState, nextInstruction: string | null = null): void {
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction };
}

function executeHandoff(
	{ fixture }: HandoffHost,
	params: Record<string, unknown> = { nextInstruction: "continue work", context: "state" },
	toolCallId = "call-1",
) {
	return fixture.tool("handoff").execute(toolCallId, params);
}

async function runCommand({ fixture }: HandoffHost, name: string, args: string): Promise<void> {
	await fixture.command(name).handler(args, fixture.runner.createCommandContext());
}

function assistantMessage(...calls: { id: string; name: string }[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

/** A tool result message for `toolCallId`, as pi passes it in `TurnEndEvent.toolResults`. */
function handoffToolResult(toolCallId: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "handoff", content: [{ type: "text", text: "Handoff staged." }], isError, timestamp: 0 };
}

/** Run turn_end through pi's boundary chain, by default with the handoff result for `call-1`. */
function emitTurnEnd(
	{ fixture }: HandoffHost,
	overrides: { toolResults?: ToolResultMessage[]; outcome?: TurnEndEvent["outcome"] } = {},
	toolCallId = "call-1",
): Promise<BoundaryResult> {
	return fixture.runner.emitBoundary(
		{
			type: "turn_end",
			turnIndex: 0,
			message: assistantMessage(),
			toolResults: overrides.toolResults ?? [handoffToolResult(toolCallId)],
			messageEntryId: "assistant-entry",
			toolResultEntryIds: [],
			outcome: overrides.outcome ?? "completed",
		},
		() => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true }),
	);
}

async function turnStart({ fixture }: HandoffHost): Promise<void> {
	await fixture.runner.emit({ type: "turn_start", turnIndex: 1, timestamp: 0 });
}

async function agentSettled({ fixture }: HandoffHost): Promise<void> {
	await fixture.runner.emit({ type: "agent_settled", aborted: false });
}

function toolCall({ fixture }: HandoffHost, toolCallId: string, toolName: string): Promise<ToolCallEventResult | undefined> {
	return fixture.runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input: {} });
}

/** Persist notebook entries for `pages` at `epoch` on the branch, as the notebook store writes them. */
function appendNotebook(session: SessionManager, epoch: number, pages: [name: string, content: string][]): void {
	session.appendCustomEntry("notebook-generation", { version: 1, epoch });
	for (const [name, content] of pages) {
		session.appendCustomEntry("notebook-entry", { version: 1, epoch, name, content, clipped: false });
	}
}

/** `draft` as a custom-message draft; throws on any other draft. */
function customMessageDraft(draft: SessionBoundaryDraft | undefined): CustomMessageEntryDraft {
	if (draft?.type !== "custom_message") {
		throw new Error(`Expected a custom_message draft, got ${draft?.type ?? "none"}.`);
	}
	return draft;
}

/** The text of a custom-message draft; throws on any other draft or on non-text content. */
function customMessageText(draft: SessionBoundaryDraft | undefined): string {
	const { content } = customMessageDraft(draft);
	if (typeof content !== "string") {
		throw new Error("The custom_message draft has no text content.");
	}
	return content;
}

/** The `epoch` in a custom draft's data; `undefined` for any other draft and for data without an `epoch`. */
function customDraftEpoch(draft: SessionBoundaryDraft): unknown {
	if (draft.type !== "custom" || typeof draft.data !== "object" || draft.data === null || !("epoch" in draft.data)) {
		return undefined;
	}
	return draft.data.epoch;
}

/** The text of the message the host recorded at `index` of its `pi.sendMessage` calls; throws unless it is text. */
function sentMessageText({ fixture }: HandoffHost, index: number): string {
	const content = fixture.host.sentMessages[index]?.message.content;
	if (typeof content !== "string") {
		throw new Error(`The sent message at index ${String(index)} has no text content.`);
	}
	return content;
}

/** A failed handoff stages nothing, starts no run and reports through one displayed message; returns its content. */
function assertFailedWithoutRun(host: HandoffHost): string {
	const { sentMessages, sentUserMessages } = host.fixture.host;
	expect(host.state.stagedHandoff).toBeNull();
	expect(sentUserMessages, "a failed handoff must not start a new run").toStrictEqual([]);
	const content = sentMessageText(host, 0);
	expect(sentMessages).toStrictEqual([
		{
			message: { customType: "pi-schematic-handoff-failed", content, display: true },
			options: { triggerTurn: false },
		},
	]);
	return content;
}

/** The watchdog nudge the real context hook injects, or undefined when it injects none. */
async function watchdogNudge({ fixture }: HandoffHost): Promise<string | undefined> {
	const messages = await fixture.runner.emitContext([{ role: "user", content: "work", timestamp: 1 }]);
	const nudge = messages.find(
		(message): message is Extract<ContextMessage, { role: "custom" }> => message.role === "custom" && message.customType === "pi-schematic-watchdog",
	);
	if (nudge === undefined) {
		return undefined;
	}
	if (typeof nudge.content !== "string") {
		throw new Error("The watchdog nudge has no text content.");
	}
	return nudge.content;
}

test("/handoff sends the direction back through the LLM without opening the editor", async () => {
	const host = await boundaryHost();
	host.setUsage(undefined);

	await runCommand(host, "handoff", "implement auth");

	const { sentUserMessages } = host.fixture.host;
	expect(sentUserMessages).toHaveLength(1);
	expect(sentUserMessages[0].content).toContain("<next-instruction>\nimplement auth\n</next-instruction>");
	expect(sentUserMessages[0].options).toBeUndefined();
});

test("/handoff requires a direction", async () => {
	const host = await boundaryHost();

	await runCommand(host, "handoff", "   ");

	expect(host.fixture.ui.notifications).toStrictEqual([{ message: "Usage: /handoff <direction>", type: "error" }]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
});

// ── Staging (the handoff tool) ───────────────────────────────────────

test("handoff stages the request, marks it called, shows progress and appends nothing", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	const { state } = host;

	const result = await executeHandoff(host, {
		nextInstruction: "Goal: continue auth-refresh",
		context: "blocked on the token spike",
		discardPages: ["stale", "stale", "old"],
	});

	expect(result).toStrictEqual({
		content: [{ type: "text", text: "Handoff staged. This context is cut when the turn ends, and the successor continues in the same run." }],
		details: {},
		terminate: true,
	});
	const stagedHandoff = state.stagedHandoff;
	assertPresent(stagedHandoff, "the handoff is staged");
	const { handoffId, ...staged } = stagedHandoff;
	expect(handoffId).toMatch(UUID_PATTERN);
	expect(staged).toStrictEqual({
		toolCallId: "call-1",
		nextInstruction: "Goal: continue auth-refresh",
		context: "blocked on the token spike",
		discardPages: ["stale", "old"],
		discardedPages: [],
		phase: "staged",
		declineReason: null,
	});
	expect(state.pendingRequestedHandoff?.toolCalled).toBe(true);
	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff in progress"));
	expect(host.fixture.host.appendedEntries).toStrictEqual([]);
	expect(host.fixture.host.sentMessages).toStrictEqual([]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
});

test("a pending human direction wins over a model-supplied nextInstruction in the staged request", async () => {
	const host = await boundaryHost();
	host.setUsage(undefined);
	await runCommand(host, "handoff", "  Audit the retry budget.  ");
	host.setUsage(ELIGIBLE_USAGE);

	await executeHandoff(host, {
		nextInstruction: "Verify the audit is done",
		context: "state machine rebuilt from scratch",
	});

	expect(host.state.stagedHandoff?.nextInstruction).toBe("Audit the retry budget.");
	expect(host.state.stagedHandoff?.context).toBe("state machine rebuilt from scratch");
});

test("a pending human direction needs no tool arguments", async () => {
	const host = await boundaryHost();
	await runCommand(host, "handoff", "finish the migration");

	await executeHandoff(host, {});

	expect(host.state.stagedHandoff?.nextInstruction).toBe("finish the migration");
	expect(host.state.stagedHandoff?.context).toBe("");
});

test("handoff with no pending direction requires nextInstruction but not context", async () => {
	const host = await boundaryHost();

	await expect(executeHandoff(host, { context: "only context" })).rejects.toThrow(/Empty handoff nextInstruction rejected/);
	expect(host.state.stagedHandoff, "a rejected call must not stage").toBeNull();

	await executeHandoff(host, { nextInstruction: "  Ship the fix  " });

	// Surrounding whitespace is trimmed.
	expect(host.state.stagedHandoff?.nextInstruction).toBe("Ship the fix");
	expect(host.state.stagedHandoff?.context).toBe("");
});

test("handoff is rejected while another handoff is staged, and /handoff reports it busy", async () => {
	const host = await boundaryHost();
	await executeHandoff(host, { nextInstruction: "first task" }, "first");

	await expect(executeHandoff(host, { nextInstruction: "second task" }, "second")).rejects.toThrow(
		new Error("A handoff is already staged in this turn; wait for it to complete."),
	);
	await expect(runCommand(host, "handoff", "replacement direction")).rejects.toThrow(
		new Error("A handoff is in progress; wait for it to complete before requesting another handoff."),
	);

	expect(host.state.stagedHandoff?.nextInstruction, "the first staged request must survive").toBe("first task");
	expect(host.state.stagedHandoff?.toolCallId).toBe("first");
	expect(host.state.pendingRequestedHandoff, "a rejected /handoff must not store its direction").toBeNull();
});

// ── turn_end: the boundary drafts ────────────────────────────────────

test("turn_end appends the cut, successor and note after the existing entries and continues", async () => {
	const foreign: SessionBoundaryDraft = { type: "custom", customType: "other-extension", data: { kept: true } };
	const host = await boundaryHost({
		factories: (state) => [
			// Another extension's turn_end handler, ahead of the boundary, contributes its own entry.
			(api) => {
				api.on("turn_end", () => ({ entries: [foreign] }));
			},
			...handoffFactories(state),
		],
	});
	await executeHandoff(host, { nextInstruction: "Goal: ship", context: "left off at step 3" });
	const stagedHandoff = host.state.stagedHandoff;
	assertPresent(stagedHandoff, "the handoff is staged");
	const handoffId = stagedHandoff.handoffId;

	const { entries, continue: shouldContinue } = await emitTurnEnd(host);

	expect({ entries, continue: shouldContinue }).toStrictEqual({
		entries: [
			foreign,
			{
				type: "compaction",
				summary: CONTINUATION_FRAME,
				firstKeptEntryId: null,
				details: { handoff: true, handoffId },
			},
			{
				type: "custom_message",
				customType: "pi-schematic-handoff",
				content: "## Next instruction\n\nGoal: ship\n\n## Context\n\nleft off at step 3",
				display: true,
				details: { handoffId },
			},
			{
				type: "custom_message",
				customType: "pi-schematic-handoff-note",
				content:
					"The system prompt above was written before this handoff and is refreshed when the next run starts; a message typed during this run does not refresh it. Until then, ignore its notebook topic (the topic is cleared) and its notebook page list (use `notebook_index` for the current pages).",
				display: false,
				details: { handoffId },
			},
		],
		continue: true,
	});
	expect(host.state.stagedHandoff?.phase).toBe("submitted");
});

test("turn_end with discardPages writes the notebook rewrite before the cut", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			s.epoch = 1;
			s.notebookPages.set("stale", "obsolete");
			s.notebookPages.set("keep", "durable");
			s.clippedPages.add("keep");
		},
	});
	await executeHandoff(host, { nextInstruction: "go", discardPages: ["stale", "ghost"] });
	const stagedHandoff = host.state.stagedHandoff;
	assertPresent(stagedHandoff, "the handoff is staged");
	const handoffId = stagedHandoff.handoffId;

	const { entries } = await emitTurnEnd(host);

	expect(entries.slice(0, 3)).toStrictEqual([
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "keep", content: "durable", clipped: true } },
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 2 } },
	]);
	expect(entries[3].type).toBe("compaction");
	expect(customMessageDraft(entries[4]).details).toStrictEqual({ handoffId });
	expect(host.state.stagedHandoff?.discardedPages, "only the requested page that existed is discarded").toStrictEqual(["stale"]);
	expect([...host.state.notebookPages.keys()], "the in-memory notebook changes only once the cut is confirmed").toContain("stale");
});

test("the discard epoch moves past the discard watermark", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			s.epoch = 1;
			s.discardEpochWatermark = 3;
			s.notebookPages.set("stale", "obsolete");
			s.notebookPages.set("keep", "durable");
		},
	});
	await executeHandoff(host, { nextInstruction: "go", discardPages: ["stale"] });

	const { entries } = await emitTurnEnd(host);

	expect(entries.map(customDraftEpoch).slice(0, 3)).toStrictEqual([1, 4, 4]);
});

test.for([{ discardPages: [] }, { discardPages: ["ghost"] }])(
	"turn_end adds no notebook entries when discardPages is empty or names no page (when discardPages is $discardPages)",
	async ({ discardPages }) => {
		const host = await boundaryHost({
			seed: (s) => {
				s.epoch = 1;
				s.notebookPages.set("keep", "durable");
			},
		});
		await executeHandoff(host, { nextInstruction: "go", discardPages });

		const { entries } = await emitTurnEnd(host);

		expect(
			entries.map((entry) => entry.type),
			`discardPages ${JSON.stringify(discardPages)}`,
		).toStrictEqual(["compaction", "custom_message", "custom_message"]);
	},
);

const declineCases: {
	name: string;
	reason: string;
	signal?: AbortSignal;
	event: { toolResults?: ToolResultMessage[]; outcome?: TurnEndEvent["outcome"] };
}[] = [
	{ name: "ctx.signal aborted", reason: "the run was aborted before the cut", signal: AbortSignal.abort(), event: {} },
	{ name: "outcome aborted", reason: "the run was aborted before the cut", event: { outcome: "aborted" } },
	{ name: "outcome error", reason: "the turn ended with an error", event: { outcome: "error" } },
	{ name: "result missing", reason: "the handoff result was missing from its turn", event: { toolResults: [] } },
	{ name: "result for another call", reason: "the handoff result was missing from its turn", event: { toolResults: [handoffToolResult("other-call")] } },
	{ name: "result is an error", reason: "the handoff result was missing from its turn", event: { toolResults: [handoffToolResult("call-1", true)] } },
];

const FOREIGN_ENTRY: SessionBoundaryDraft = { type: "custom", customType: "other-extension", data: { kept: true } };

/** The handoff command, tool and boundary behind another extension's turn_end handler that contributes `FOREIGN_ENTRY`. */
function behindForeignTurnEnd(state: SchematicState): ExtensionFactory[] {
	return [
		(api) => {
			api.on("turn_end", () => ({ entries: [FOREIGN_ENTRY] }));
		},
		...handoffFactories(state),
	];
}

test.for(declineCases)("turn_end declines the cut when $name", async ({ name, reason, signal, event }) => {
	const host = await boundaryHost({ factories: behindForeignTurnEnd });
	await executeHandoff(host);
	host.setSignal(signal);

	const { entries, continue: shouldContinue } = await emitTurnEnd(host, event);

	// The boundary returns nothing: the earlier handler's entries and continue flag pass through unchanged.
	expect({ entries, continue: shouldContinue }, name).toStrictEqual({ entries: [FOREIGN_ENTRY], continue: false });
	expect(host.state.stagedHandoff).toMatchObject({ phase: "declined", declineReason: reason });
});

test("turn_end without a staged handoff returns nothing", async () => {
	const host = await boundaryHost({ factories: behindForeignTurnEnd });

	const { entries, continue: shouldContinue } = await emitTurnEnd(host);

	expect({ entries, continue: shouldContinue }).toStrictEqual({ entries: [FOREIGN_ENTRY], continue: false });
});

// ── turn_start / agent_settled: confirming the cut ───────────────────

test("turn_start with the cut on the branch completes the handoff", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			requestHandoff(s, "implement auth");
			s.epoch = 1;
			s.notebookPages.set("stale", "obsolete");
			s.notebookPages.set("keep", "durable");
			s.activeNotebookTopic = { name: "oauth", source: "human" };
			s.readonlyEnabled = true;
		},
	});
	const { state } = host;
	const { statuses, widgets, notifications } = host.fixture.ui;
	await executeHandoff(host, { discardPages: ["stale"] });
	appendDrafts(host.session, (await emitTurnEnd(host)).entries);

	await turnStart(host);

	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff).toBeNull();
	expect(state.activeNotebookTopic).toBeNull();
	expect(state.readonlyNudgePending).toBe(true);
	expect([...state.notebookPages], "pages follow what the branch persisted").toStrictEqual([["keep", "durable"]]);
	expect(state.epoch).toBe(2);
	expect(statuses.get(STATUS_KEY_HANDOFF), "the in-progress status the tool set is cleared").toBeUndefined();
	expect(notifications).toStrictEqual([{ message: "Handoff complete. Notebook: 1 page kept, 1 discarded.", type: "info" }]);
	expect(statuses.get(STATUS_KEY_TOPIC), "the topic indicator shows the cleared topic").toBe(realTheme.fg("dim", "🧭 -"));
	expect(statuses.get(STATUS_KEY_NOTEBOOK), "the notebook indicator shows the kept pages").toBe("📒 1");
	expect([...widgets], "the high-context warning is cleared").toStrictEqual([["pi-schematic-warning", undefined]]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
	expect(host.fixture.host.sentMessages).toStrictEqual([]);
});

test("a completed handoff without discardPages notifies a plain completion", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			s.epoch = 1;
			s.notebookPages.set("a", "one");
			s.notebookPages.set("b", "two");
		},
	});
	appendNotebook(host.session, 1, [
		["a", "one"],
		["b", "two"],
	]);
	await executeHandoff(host, { nextInstruction: "go" });
	appendDrafts(host.session, (await emitTurnEnd(host)).entries);

	await turnStart(host);

	expect(host.state.notebookPages.size, "the pages survive, so the plain form does not depend on an empty notebook").toBe(2);
	expect(host.fixture.ui.notifications).toStrictEqual([{ message: "Handoff complete.", type: "info" }]);
});

test("a discard naming no page reports the kept pages without a discarded count", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			s.epoch = 1;
			s.notebookPages.set("a", "one");
			s.notebookPages.set("b", "two");
		},
	});
	appendNotebook(host.session, 1, [
		["a", "one"],
		["b", "two"],
	]);
	await executeHandoff(host, { nextInstruction: "go", discardPages: ["ghost"] });
	assertPresent(host.state.stagedHandoff);
	appendDrafts(host.session, (await emitTurnEnd(host)).entries);

	await turnStart(host);

	expect(host.fixture.ui.notifications).toStrictEqual([{ message: "Handoff complete. Notebook: 2 pages kept.", type: "info" }]);
});

test("a discard dropped from the boundary is counted from the branch and warned about", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			s.epoch = 1;
			s.notebookPages.set("a", "one");
			s.notebookPages.set("stale", "obsolete");
		},
	});
	appendNotebook(host.session, 1, [
		["a", "one"],
		["stale", "obsolete"],
	]);
	await executeHandoff(host, { nextInstruction: "go", discardPages: ["stale"] });
	const { entries } = await emitTurnEnd(host);
	// Another extension's turn_end handler keeps the cut, successor and note but drops the notebook rewrite.
	appendDrafts(
		host.session,
		entries.filter((entry) => entry.type !== "custom"),
	);

	await turnStart(host);

	expect(host.state.notebookPages.get("stale"), "the page stays on the branch").toBe("obsolete");
	expect(host.fixture.ui.notifications).toStrictEqual([
		{ message: "Handoff complete. Notebook: 2 pages kept.", type: "info" },
		{
			message: "The notebook discard was not persisted (another extension's turn_end handler may have dropped it); still in the notebook: stale.",
			type: "warning",
		},
	]);
});

test("a page created under a requested discard name after staging is neither counted nor warned about", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			s.epoch = 1;
			s.notebookPages.set("stale", "obsolete");
		},
	});
	appendNotebook(host.session, 1, [["stale", "obsolete"]]);
	// "ghost" names no page when the boundary is built, so the drafts discard only "stale".
	await executeHandoff(host, { nextInstruction: "go", discardPages: ["stale", "ghost"] });
	appendDrafts(host.session, (await emitTurnEnd(host)).entries);
	// Another extension's turn_end handler keeps the boundary and adds a page named
	// by the request, which never existed when the boundary was built and was never discarded.
	host.session.appendCustomEntry("notebook-entry", { version: 1, epoch: 2, name: "ghost", content: "created after staging", clipped: false });

	await turnStart(host);

	expect([...host.state.notebookPages], "the page added after staging survives").toStrictEqual([["ghost", "created after staging"]]);
	expect(host.fixture.ui.notifications).toStrictEqual([{ message: "Handoff complete. Notebook: 1 page kept, 1 discarded.", type: "info" }]);
});

test("a completed handoff leaves the readonly nudge off when readonly is off", async () => {
	const host = await boundaryHost();
	await executeHandoff(host);
	appendDrafts(host.session, (await emitTurnEnd(host)).entries);

	await turnStart(host);

	expect(host.state.stagedHandoff).toBeNull();
	expect(host.state.readonlyNudgePending).toBe(false);
});

test("turn_start leaves a handoff staged until its turn_end has run", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	await executeHandoff(host);

	await turnStart(host);

	expect(host.state.stagedHandoff?.phase).toBe("staged");
	expect(host.fixture.ui.notifications).toStrictEqual([]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
});

test("turn_start without the cut on the branch fails the handoff and keeps the request retryable", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			requestHandoff(s, "implement auth");
		},
	});
	await executeHandoff(host);
	await emitTurnEnd(host);

	await turnStart(host);

	expect(host.state.stagedHandoff).toBeNull();
	expect(host.state.pendingRequestedHandoff).toStrictEqual({
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: "implement auth",
	});
	expect(host.fixture.host.sentUserMessages, "a missing cut never starts a run").toStrictEqual([]);
	expect(host.fixture.host.sentMessages).toStrictEqual([
		{
			message: {
				customType: "pi-schematic-handoff-failed",
				content: `Handoff failed — ${NOT_PERSISTED}. ${PENDING_SUFFIX}`,
				display: true,
			},
			options: { triggerTurn: false },
		},
	]);
	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff required — ready to compact"));
	expect(host.fixture.ui.notifications).toStrictEqual([{ message: `Handoff failed: ${NOT_PERSISTED}. The handoff can be retried.`, type: "error" }]);
});

test("a failed handoff shows the waiting status when usage becomes unavailable", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	await executeHandoff(host);
	await emitTurnEnd(host);
	host.setUsage(undefined);

	await turnStart(host);

	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff requested — waiting for eligible context"));
});

test("a failed handoff without a pending request clears the status and says nothing remains pending", async () => {
	const host = await boundaryHost();
	await executeHandoff(host);
	await emitTurnEnd(host);

	await turnStart(host);

	const { sentMessages, sentUserMessages } = host.fixture.host;
	expect(host.state.pendingRequestedHandoff).toBeNull();
	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF), "the in-progress status the tool set is cleared").toBeUndefined();
	expect(sentUserMessages).toStrictEqual([]);
	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0].message.customType).toBe("pi-schematic-handoff-failed");
	expect(sentMessages[0].message.display).toBe(true);
	expectSuffix(sentMessageText(host, 0), NOT_PENDING_SUFFIX);
	expect(sentMessages[0].options).toStrictEqual({ triggerTurn: false });
});

test.for([
	{
		run: "a nudged",
		attemptsBefore: MAX_HANDOFF_ATTEMPTS - 1,
		nudged: true,
		outcome: "does not call",
		requestSurvives: false,
		suffix: NOT_PENDING_SUFFIX,
		status: undefined,
	},
	{
		run: "a nudged",
		attemptsBefore: MAX_HANDOFF_ATTEMPTS - 2,
		nudged: true,
		outcome: "keeps",
		requestSurvives: true,
		suffix: PENDING_SUFFIX,
		status: realTheme.fg("accent", "🤝 Handoff required — ready to compact"),
	},
	{
		run: "an un-nudged",
		attemptsBefore: MAX_HANDOFF_ATTEMPTS - 1,
		nudged: false,
		outcome: "keeps",
		requestSurvives: true,
		suffix: PENDING_SUFFIX,
		status: realTheme.fg("accent", "🤝 Handoff required — ready to compact"),
	},
])(
	"a failed cut on $run run after $attemptsBefore counted attempts $outcome the request pending",
	async ({ attemptsBefore, nudged, requestSurvives, suffix, status }) => {
		const host = await boundaryHost({
			seed: (s) => {
				s.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: attemptsBefore, eligibleNudgeDelivered: nudged, nextInstruction: null };
			},
			factories: (state) => [
				(api) => {
					registerHandoffTool(api, state);
					registerHandoffBoundary(api, state);
					registerWatchdog(api, state);
				},
			],
		});
		await executeHandoff(host);
		await emitTurnEnd(host);

		await agentSettled(host);

		expect(host.state.pendingRequestedHandoff !== null, "whether the request is still pending").toBe(requestSurvives);
		expect(host.fixture.host.sentMessages).toHaveLength(1);
		expectSuffix(sentMessageText(host, 0), suffix);
		expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(status);
		expect(host.fixture.ui.notifications[0]?.message).toBe(`Handoff failed: ${NOT_PERSISTED}. The handoff can be retried.`);
	},
);

test("agent_settled with the cut on the branch completes with the successor-did-not-run warning", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	await executeHandoff(host);
	appendDrafts(host.session, (await emitTurnEnd(host)).entries);

	await agentSettled(host);

	expect(host.state.stagedHandoff).toBeNull();
	expect(host.state.pendingRequestedHandoff).toBeNull();
	expect(host.fixture.ui.notifications).toStrictEqual([
		{ message: "Handoff complete, but the successor turn did not run. Send a message to continue.", type: "warning" },
	]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
});

test("agent_settled fails a declined handoff with its decline reason in a displayed message and starts no run", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	await executeHandoff(host);
	await emitTurnEnd(host, { toolResults: [] });

	await agentSettled(host);

	expect(host.state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expectPrefix(assertFailedWithoutRun(host), "Handoff failed — the handoff result was missing from its turn.");
	expect(host.fixture.ui.notifications[0].type).toBe("error");
});

test("agent_settled fails a handoff whose turn_end never ran", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	await executeHandoff(host);

	await agentSettled(host);

	expect(host.state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expectPrefix(assertFailedWithoutRun(host), "Handoff failed — the turn ended without writing the cut.");
	expect(host.fixture.ui.notifications).toStrictEqual([
		{ message: "Handoff failed: the turn ended without writing the cut. The handoff can be retried.", type: "error" },
	]);
});

test("a handoff declined for an abort fails at agent_settled with a displayed message and starts no run", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	await executeHandoff(host);
	host.setSignal(AbortSignal.abort());
	await emitTurnEnd(host);
	host.setSignal(undefined);

	await agentSettled(host);

	expect(host.state.pendingRequestedHandoff?.toolCalled).toBe(false);
	expect(assertFailedWithoutRun(host)).toBe(`Handoff failed — the run was aborted before the cut. ${PENDING_SUFFIX}`);
	expect(host.fixture.ui.notifications).toStrictEqual([
		{ message: "Handoff failed: the run was aborted before the cut. The handoff can be retried.", type: "error" },
	]);
});

test("a submitted handoff whose cut is missing but whose notebook drafts persisted follows the branch's notebook", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			s.epoch = 1;
			s.notebookPages.set("stale", "obsolete");
			s.notebookPages.set("keep", "durable");
		},
	});
	await executeHandoff(host, { nextInstruction: "go", discardPages: ["stale"] });
	const { entries } = await emitTurnEnd(host);
	appendDrafts(
		host.session,
		entries.filter((entry) => entry.type !== "compaction"),
	);

	await turnStart(host);

	expect(host.state.stagedHandoff).toBeNull();
	expect(host.fixture.host.sentMessages[0].message.customType).toBe("pi-schematic-handoff-failed");
	expect([...host.state.notebookPages], "the discard drafts persisted, so the discard applies").toStrictEqual([["keep", "durable"]]);
	expect(host.state.epoch).toBe(2);
	expect(host.state.discardEpochWatermark).toBe(2);
});

test("a failed handoff, a retry and the second cut deliver the human direction and the retry's discard", async () => {
	const host = await boundaryHost({
		seed: (s) => {
			requestHandoff(s, "human direction");
			s.epoch = 1;
			s.notebookPages.set("stale", "obsolete");
			s.notebookPages.set("keep", "durable");
			s.notebookPages.set("other", "also durable");
		},
	});
	const { state } = host;
	appendNotebook(host.session, 1, [
		["stale", "obsolete"],
		["keep", "durable"],
		["other", "also durable"],
	]);
	await executeHandoff(host, { nextInstruction: "first model instruction", discardPages: ["other"] }, "first");
	await emitTurnEnd(host, {}, "first");
	await turnStart(host);
	await agentSettled(host);
	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff?.nextInstruction, "the failed cut keeps the request pending").toBe("human direction");

	await executeHandoff(host, { nextInstruction: "second model instruction", discardPages: ["stale"] }, "second");
	const { entries } = await emitTurnEnd(host, {}, "second");
	appendDrafts(host.session, entries);
	await turnStart(host);

	const successor = entries.find((entry) => entry.type === "custom_message" && entry.customType === "pi-schematic-handoff");
	expect(customMessageText(successor)).toBe("## Next instruction\n\nhuman direction");
	expect(state.stagedHandoff).toBeNull();
	expect(state.pendingRequestedHandoff).toBeNull();
	expect([...state.notebookPages].sort()).toStrictEqual([
		["keep", "durable"],
		["other", "also durable"],
	]);
});

test("a handoff whose branch holds only an earlier handoff's cut fails as not persisted", async () => {
	const host = await boundaryHost();
	host.session.appendCompaction(CONTINUATION_FRAME, null, 0, { handoff: true, handoffId: "handoff-a" }, true);
	await executeHandoff(host);
	await emitTurnEnd(host);

	await turnStart(host);

	expect(host.state.stagedHandoff).toBeNull();
	expectPrefix(sentMessageText(host, 0), `Handoff failed — ${NOT_PERSISTED}.`);
});

test("a cut followed only by another handoff's successor fails as a lost successor", async () => {
	const host = await boundaryHost();
	await executeHandoff(host, { nextInstruction: "continue work", context: "state" });
	const { entries } = await emitTurnEnd(host);
	// The cut lands, but the only successor after it belongs to another handoff.
	appendDrafts(
		host.session,
		entries.filter((entry) => entry.type === "compaction"),
	);
	host.session.appendCustomMessageEntry("pi-schematic-handoff", "## Next instruction\n\nother work", true, { handoffId: "other-handoff" });

	await turnStart(host);

	expect(host.fixture.host.sentMessages).toStrictEqual([
		{
			message: {
				customType: "pi-schematic-handoff-failed",
				content:
					"Handoff failed — the cut was written but its successor instruction was not persisted after it (another extension's turn_end handler may have dropped it or written a later compaction). The context is already cut, so the handoff is not retried and no required handoff remains pending. The instruction it carried:\n\n## Next instruction\n\ncontinue work\n\n## Context\n\nstate",
				display: true,
			},
			options: { triggerTurn: false },
		},
	]);
});

test("a lost-successor failure clears the in-progress handoff status", async () => {
	const host = await boundaryHost();
	await executeHandoff(host, { nextInstruction: "continue work", context: "state" });
	const { entries } = await emitTurnEnd(host);
	appendDrafts(
		host.session,
		entries.filter((entry) => entry.type === "compaction"),
	);
	host.session.appendCustomMessageEntry("pi-schematic-handoff", "## Next instruction\n\nother work", true, { handoffId: "other-handoff" });
	const { statuses } = host.fixture.ui;
	expect(statuses.get(STATUS_KEY_HANDOFF), "the tool set the in-progress status").toBe(realTheme.fg("accent", "🤝 Handoff in progress"));

	await turnStart(host);

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
});

test("agent_settled after a handoff completed at turn_start sends and notifies nothing", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	const { notifications } = host.fixture.ui;
	await executeHandoff(host);
	appendDrafts(host.session, (await emitTurnEnd(host)).entries);
	await turnStart(host);
	const notificationsAtCompletion = notifications.length;

	await agentSettled(host);

	expect(notificationsAtCompletion).toBe(1);
	expect(notifications, "no second notification at settle").toHaveLength(1);
	expect(host.fixture.host.sentMessages).toStrictEqual([]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
});

// ── Sibling refusal ──────────────────────────────────────────────────

async function messageEnd({ fixture }: HandoffHost, ...calls: { id: string; name: string }[]): Promise<void> {
	await fixture.runner.emitMessageEnd({ type: "message_end", message: assistantMessage(...calls) });
}

const NOT_ALONE_REFUSAL = {
	block: true,
	reason:
		"Not run: handoff must be the only tool call in its message. The other calls in this message were handled on their own; call handoff alone in your next message.",
	terminate: true,
};

const FAILED_IN_RUN_REFUSAL = {
	block: true,
	reason: "Not run: a handoff already failed in this run. Do not call handoff again in this run.",
	terminate: true,
};

test("in a message holding only handoff calls, the first runs and the others are refused", async () => {
	const host = await boundaryHost();
	await messageEnd(host, { id: "h1", name: "handoff" }, { id: "h2", name: "handoff" });

	expect(await toolCall(host, "h1", "handoff")).toBeUndefined();
	expect(await toolCall(host, "h2", "handoff")).toStrictEqual({
		block: true,
		reason: "Not run: only the first handoff call in an assistant message runs.",
		terminate: true,
	});
});

test("every handoff sharing a message with other calls is refused and the other calls are not refused", async () => {
	const host = await boundaryHost();
	await messageEnd(host, { id: "w1", name: "write" }, { id: "h1", name: "handoff" }, { id: "n1", name: "notebook_write" }, { id: "h2", name: "handoff" });

	expect(await toolCall(host, "h1", "handoff")).toStrictEqual(NOT_ALONE_REFUSAL);
	expect(await toolCall(host, "h2", "handoff")).toStrictEqual(NOT_ALONE_REFUSAL);
	expect(await toolCall(host, "w1", "write")).toBeUndefined();
	expect(await toolCall(host, "n1", "notebook_write")).toBeUndefined();
});

test("calls in an assistant message without handoff are not refused", async () => {
	const host = await boundaryHost();
	await messageEnd(host, { id: "w1", name: "write" }, { id: "r1", name: "read" });

	expect(await toolCall(host, "w1", "write")).toBeUndefined();
	expect(await toolCall(host, "r1", "read")).toBeUndefined();
});

test("refusals last until the next assistant message and are not cleared by other messages", async () => {
	const host = await boundaryHost();
	await messageEnd(host, { id: "h1", name: "handoff" }, { id: "w1", name: "write" });

	await host.fixture.runner.emitMessageEnd({ type: "message_end", message: handoffToolResult("w1") });
	expect((await toolCall(host, "h1", "handoff"))?.block, "a tool result message must not clear refusals").toBe(true);

	await messageEnd(host, { id: "w2", name: "write" });
	expect(await toolCall(host, "h1", "handoff"), "the next assistant message clears the previous refusals").toBeUndefined();
});

test("turn_end clears the refusals", async () => {
	const host = await boundaryHost();
	await messageEnd(host, { id: "h1", name: "handoff" }, { id: "w1", name: "write" });

	await emitTurnEnd(host, { toolResults: [] });

	expect(await toolCall(host, "h1", "handoff")).toBeUndefined();
});

// ── session_tree ─────────────────────────────────────────────────────

test("session_tree invalidates a staged handoff and the handoff refusals", async () => {
	const host = await boundaryHost({ shipped: true });
	await executeHandoff(host, { nextInstruction: "first task" }, "first");
	await messageEnd(host, { id: "h1", name: "handoff" }, { id: "w1", name: "write" });
	await expect(executeHandoff(host, { nextInstruction: "second task" }, "second")).rejects.toThrow(
		new Error("A handoff is already staged in this turn; wait for it to complete."),
	);
	expect((await toolCall(host, "h1", "handoff"))?.block).toBe(true);

	await host.fixture.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });

	await executeHandoff(host, { nextInstruction: "second task" }, "second");
	expect(await toolCall(host, "h1", "handoff")).toBeUndefined();
});

test("after a failed cut the run refuses further handoff calls until the agent settles", async () => {
	const host = await boundaryHost();
	await executeHandoff(host);
	await emitTurnEnd(host);
	await turnStart(host);

	expect(await toolCall(host, "again", "handoff")).toStrictEqual(FAILED_IN_RUN_REFUSAL);
	expect(await toolCall(host, "w1", "write"), "other tools are not refused for the failed cut").toBeUndefined();

	await agentSettled(host);

	expect(await toolCall(host, "again", "handoff")).toBeUndefined();
});

test("session_tree clears the failed-in-run refusal", async () => {
	const host = await boundaryHost({ shipped: true });
	await executeHandoff(host);
	await emitTurnEnd(host);
	await turnStart(host);
	expect((await toolCall(host, "again", "handoff"))?.block).toBe(true);

	await host.fixture.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });

	expect(await toolCall(host, "again", "handoff")).toBeUndefined();
});

test("a completed handoff clears the requested-handoff nudge", async () => {
	const host = await boundaryHost({ shipped: true });
	await runCommand(host, "handoff", "continue work");
	expect((await watchdogNudge(host)) ?? "").toContain("A real handoff is required");
	await executeHandoff(host, { nextInstruction: "continue work" });
	const { entries } = await emitTurnEnd(host);
	appendDrafts(host.session, entries);

	await turnStart(host);

	expectPrefix(customMessageText(entries[1]), "## Next instruction\n\ncontinue work", "successor turn must start with the delivered instruction:");
	expect(await watchdogNudge(host), "a completed handoff leaves no requested-handoff nudge").toBeUndefined();
});

test("/handoff sets the handoff status indicator", async () => {
	const host = await boundaryHost();
	host.setUsage(undefined);

	await runCommand(host, "handoff", "implement auth");

	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff requested — waiting for eligible context"));
});

test("/handoff shows ready status when context is eligible", async () => {
	const host = await boundaryHost();

	await runCommand(host, "handoff", "implement auth");

	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff required — ready to compact"));
});

test("handoff status becomes ready when later context becomes eligible", async () => {
	const host = await boundaryHost({ shipped: true });
	host.setUsage(undefined);
	await runCommand(host, "handoff", "implement auth");
	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff requested — waiting for eligible context"));

	host.setUsage(ELIGIBLE_USAGE);
	await host.fixture.runner.emitContext([]);

	expect(host.fixture.ui.statuses.get(STATUS_KEY_HANDOFF)).toBe(realTheme.fg("accent", "🤝 Handoff required — ready to compact"));
});

test.for([
	{ name: "NaN tokens", usage: { tokens: Number.NaN, percent: 20, contextWindow: 200000 } },
	{ name: "infinite tokens", usage: { tokens: Number.POSITIVE_INFINITY, percent: 20, contextWindow: 200000 } },
	{ name: "NaN percent", usage: { tokens: null, percent: Number.NaN, contextWindow: 200000 } },
	{ name: "no usage", usage: undefined },
	{ name: "null tokens and null percent", usage: { tokens: null, percent: null, contextWindow: 200_000 } },
])("handoff tool rejects unusable context usage without staging: $name", async ({ usage }) => {
	const host = await boundaryHost();
	host.setUsage(usage);

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).rejects.toThrow(
		new Error("Context usage unavailable; handoff rejected. Continue working and retry."),
	);

	expect(host.state.stagedHandoff, "unusable usage must not stage").toBeNull();
});

test("every handoff tool parameter is optional", async () => {
	const host = await boundaryHost();
	const { parameters } = host.fixture.registeredTool("handoff").definition;

	// A pending human direction makes nextInstruction redundant, and a handoff with nothing
	// to add makes context redundant. The runtime guard rejects the one combination that
	// cannot work: no instruction.
	expect(Value.Check(parameters, { nextInstruction: "continue work" })).toBe(true);
	expect(Value.Check(parameters, { context: "blocked on auth" })).toBe(true);
	expect(Value.Check(parameters, {})).toBe(true);
});

test("the continuation frame is pinned byte-for-byte", () => {
	// The frame is the only summary text a successor sees, so every byte is a contract.
	// The frame carries no task or constraints: a frozen task invites paraphrase, and frozen
	// constraints lie after a /tree rollback.
	expect(buildContinuationFrame()).toBe(CONTINUATION_FRAME);
});

test("the lost-successor failure is pinned byte-for-byte and carries the instruction", () => {
	// The failure is the only place the lost instruction survives.
	expect(formatLostSuccessorFailure("the successor was lost", "## Next instruction\n\nfinish the report\n\n## Context\n\nmid-task state")).toBe(
		"Handoff failed — the successor was lost. The context is already cut, so the handoff is not retried and no required handoff remains pending. The instruction it carried:\n\n## Next instruction\n\nfinish the report\n\n## Context\n\nmid-task state",
	);
});

test("buildNextUserMessage carries the instruction verbatim and the context second", () => {
	const instruction = "  Refactor billing to use the shared meter.  ";
	expect(buildNextUserMessage({ nextInstruction: instruction, context: "  blocked on the auth spike  " })).toBe(
		"## Next instruction\n\n  Refactor billing to use the shared meter.  \n\n## Context\n\nblocked on the auth spike",
	);
	expect(buildNextUserMessage({ nextInstruction: "Refactor billing" })).toBe("## Next instruction\n\nRefactor billing");
	expect(buildNextUserMessage({ nextInstruction: "Refactor billing", context: "   \n " }), "whitespace-only context adds no empty section").toBe(
		"## Next instruction\n\nRefactor billing",
	);
});

test("handoff tool rejects an empty nextInstruction with context usage", async () => {
	const host = await boundaryHost();
	host.setUsage({ tokens: null, contextWindow: 0, percent: 42 });

	await expect(executeHandoff(host, { nextInstruction: "" })).rejects.toThrow(
		new Error(
			"Context at 42%. Empty handoff nextInstruction rejected. Save findings to notebook, then call handoff with the instruction the successor must execute.",
		),
	);

	expect(host.state.stagedHandoff, "an empty instruction must not stage").toBeNull();
	expect(host.fixture.host.sentUserMessages, "the error result is the only report; nothing queues for a later turn").toStrictEqual([]);
});

test("handoff tool rejects small session with clear error", async () => {
	const host = await boundaryHost();
	host.setUsage({ tokens: 5000, percent: 2.5, contextWindow: 200000 });

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("handoff unavailable yet");
		expect(error.message).toContain("~3% (5000 tokens)");
		expect(error.message).toContain("Continue working");
		return true;
	});

	expect(host.state.stagedHandoff, "small-session rejection must not stage").toBeNull();
});

test("a small-session rejection keeps the pending request and states it in the error without queuing a follow-up", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	host.setUsage({ tokens: 5000, percent: 2.5, contextWindow: 200000 });

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("handoff unavailable yet");
		expect(error.message).toContain("The required handoff remains pending");
		return true;
	});

	expect(host.state.pendingRequestedHandoff).toStrictEqual({
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	expect([...host.fixture.ui.statuses], "the rejection leaves every status as it was").toStrictEqual([]);
	expect(host.fixture.ui.notifications, "the error result is the only report of the rejection").toStrictEqual([]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
});

test("handoff tool rejects small session with null percent without crashing", async () => {
	const host = await boundaryHost();
	host.setUsage({ tokens: 5000, percent: null, contextWindow: 200000 });

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("handoff unavailable yet");
		expect(error.message).toContain("(5000 tokens)");
		expect(error.message).toContain("Continue working");
		return true;
	});

	expect(host.state.stagedHandoff, "null-percent rejection must not stage").toBeNull();
});

test("handoff tool rejects small session estimated from percent when tokens are unavailable", async () => {
	const host = await boundaryHost();
	host.setUsage({ tokens: null, percent: 10, contextWindow: 200000 });

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("handoff unavailable yet");
		expect(error.message).toContain("~20000 tokens estimated from context usage");
		expect(error.message).toContain("Continue working");
		return true;
	});

	expect(host.state.stagedHandoff, "estimated small-session rejection must not stage").toBeNull();
});

test("handoff tool accepts large estimated session when tokens are unavailable", async () => {
	const host = await boundaryHost();
	host.setUsage({ tokens: null, percent: 20, contextWindow: 200000 });

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).resolves.toMatchObject({ terminate: true });
	expect(host.state.stagedHandoff?.phase, "an accepted handoff must stage").toBe("staged");
});

test("handoff tool accepts the exact 30000-token minimum", async () => {
	const host = await boundaryHost();
	host.setUsage({ tokens: 30000, percent: 15, contextWindow: 200000 });

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).resolves.toMatchObject({ terminate: true });
	expect(host.state.stagedHandoff?.phase, "an accepted handoff must stage").toBe("staged");
});

test("handoff tool rejects session just below the 30000-token minimum", async () => {
	const host = await boundaryHost();
	host.setUsage({ tokens: 29999, percent: 15, contextWindow: 200000 });

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("handoff unavailable yet");
		expect(error.message).toContain("29999 tokens");
		expect(error.message).toContain("Continue working");
		return true;
	});

	expect(host.state.stagedHandoff, "just-below-boundary rejection must not stage").toBeNull();
});

test("handoff tool rejects a whitespace-only nextInstruction", async () => {
	const host = await boundaryHost();
	host.setUsage(undefined);

	await expect(executeHandoff(host, { nextInstruction: "   \t\n " })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("Empty handoff nextInstruction rejected");
		expect(error.message).toContain("Context at ?");
		return true;
	});

	expect(host.state.stagedHandoff).toBeNull();
});

test("/handoff queues as a followUp while a run is active", async () => {
	const host = await boundaryHost({ idle: false });

	await runCommand(host, "handoff", "continue work");

	expect(host.fixture.host.sentUserMessages[0]?.options?.deliverAs, "a direction sent mid-run must queue instead of being rejected").toBe("followUp");
});

test("an unavailable-usage rejection keeps the pending request and states it in the error without queuing a follow-up", async () => {
	const host = await boundaryHost({ seed: requestHandoff });
	host.setUsage(undefined);

	await expect(executeHandoff(host, { nextInstruction: "Goal: continue" })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("Context usage unavailable");
		expect(error.message).toContain("The required handoff remains pending");
		return true;
	});

	expect(host.state.pendingRequestedHandoff).toStrictEqual({
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: null,
	});
	expect([...host.fixture.ui.statuses], "the rejection leaves every status as it was").toStrictEqual([]);
	expect(host.fixture.ui.notifications, "the error result is the only report of the rejection").toStrictEqual([]);
	expect(host.fixture.host.sentUserMessages).toStrictEqual([]);
});
