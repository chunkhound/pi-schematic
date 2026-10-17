/**
 * real-host-probe.ts — Probe extension loaded into the real pi CLI by the
 * real-host E2E harness (`real-host.ts`).
 *
 * Registers a scripted provider whose responses the test arms through
 * `/e2e-script`, plus the `PROBE_COMMAND` commands. Every observation is appended
 * as one JSON line to the file `PROBE_LOG_ENV_VAR` names.
 *
 * The harness loads this file after schematic, so its "input" handler runs last and
 * its "continue" means pi accepted the input, and its turn_end handler sees the
 * boundary entries schematic returned.
 *
 * Runs inside the pi process: never write to stdout or stderr here.
 */

import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MIN_HANDOFF_TOKENS } from "../../handoff/eligibility.js";
import { HANDOFF_SUCCESSOR_CUSTOM_TYPE } from "../../handoff/format.js";
import {
	PROBE_API,
	PROBE_BARRIER_STATUS_KEY,
	PROBE_COMMAND,
	PROBE_CONTEXT_WINDOW,
	PROBE_LOG_ENV_VAR,
	PROBE_MODEL_ID,
	PROBE_PROVIDER,
	cutHandoffId,
	parseScriptedStep,
	type BarrierReport,
	type ProbeRecord,
	type ScriptedStep,
} from "./real-host-protocol.js";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const SCRIPTED_INPUT_TOKENS = 50000;
// Load-time check: every scripted response must clear the handoff floor whatever the
// context size, or schematic rejects the handoffs this suite scripts.
if (!(SCRIPTED_INPUT_TOKENS > MIN_HANDOFF_TOKENS)) {
	throw new Error(
		`The probe's scripted usage (${SCRIPTED_INPUT_TOKENS} input tokens) must exceed ` +
		`MIN_HANDOFF_TOKENS (${MIN_HANDOFF_TOKENS}); schematic would reject every scripted handoff.`,
	);
}
function usageOf(inputTokens: number): AssistantMessage["usage"] {
	return { input: inputTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens, cost: zeroCost };
}

function parseScript(args: string): ScriptedStep[] {
	const parsed: unknown = JSON.parse(args);
	if (!Array.isArray(parsed)) throw new Error(`/e2e-script expects a JSON array, got: ${args}`);
	return parsed.map((step: unknown, index) => parseScriptedStep(step, (reason) => {
		throw new Error(`/e2e-script step ${index}: ${reason}`);
	}));
}

/** The run count `/e2e-turn` takes: none means one, otherwise one positive integer. */
function parseTurnCount(args: string): number {
	const text = args.trim();
	if (text === "") return 1;
	const count = Number(text);
	if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(count)) {
		throw new Error(`/e2e-turn expects no argument or a positive decimal run count, got: ${args}`);
	}
	return count;
}

/** One positive integer argument of `/e2e-barrier`. */
function parseBarrierArgument(value: string | undefined, name: string, args: string): number {
	const parsed = Number(value);
	if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`/e2e-barrier expects "<id> <deadlineMs>" as positive integers; ${name} is invalid in: ${args}`);
	}
	return parsed;
}

/** Text of a message's content: block arrays reduced to their text blocks joined by newlines, strings as is. */
function messageText(content: unknown): string {
	return contextTexts([{ content }]).join("\n");
}

/** Text of every context message: block arrays reduced to their text blocks, strings as is. */
function contextTexts(messages: ReadonlyArray<{ content?: unknown }>): string[] {
	return messages.flatMap((message) => {
		const content = message.content;
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text);
		}
		return typeof content === "string" ? [content] : [];
	});
}

export default function realHostProbe(pi: ExtensionAPI): void {
	const logPath = process.env[PROBE_LOG_ENV_VAR];
	if (!logPath) throw new Error(`${PROBE_LOG_ENV_VAR} is not set`);
	const log = (record: ProbeRecord) => appendFileSync(logPath, JSON.stringify(record) + "\n");

	let armedScript: ScriptedStep[] | null = null;
	let runScript: ScriptedStep[] | null = null;
	let step = 0;
	let runEntryCount = 0;
	// How the next turn_end boundary that carries a handoff cut is altered: the whole
	// boundary dropped, only its successor dropped, or a compaction appended after the cut.
	let nextCutTamper: "drop" | "dropSuccessor" | "compactAfter" | null = null;
	let abortAfterHandoff = false;
	// Runs `/e2e-turn <count>` still has to start, one per agent_settled.
	let chainedTurns = 0;

	// Outstanding work, kept from public extension events only; /e2e-barrier waits until
	// none is left. A successful handoff tool call awaits the turn_end that writes or
	// declines its cut; an accepted extension input awaits the user message that delivers
	// it, in a new run or queued into the running one; a run awaits agent_settled.
	const handoffCallsAwaitingBoundary: string[] = [];
	const inputsAwaitingDelivery: string[] = [];
	let runsAwaitingSettle = 0;
	const accountingErrors: string[] = [];
	let wakeBarriers: Array<() => void> = [];
	const wake = () => {
		const waiting = wakeBarriers;
		wakeBarriers = [];
		for (const resolve of waiting) resolve();
	};

	const startTurn = () => {
		pi.sendMessage({ customType: "schematic-e2e-turn", content: "e2e tick", display: false }, { triggerTurn: true });
	};

	const outstanding = (ctx: ExtensionCommandContext): string[] => [
		...handoffCallsAwaitingBoundary.map((id) => `handoff call ${id} has no turn_end`),
		...inputsAwaitingDelivery.map((text) => `extension input ${JSON.stringify(text.slice(0, 80))} has no user message`),
		...(runsAwaitingSettle > 0 ? [`${runsAwaitingSettle} run(s) have no agent_settled`] : []),
		...(chainedTurns > 0 ? [`${chainedTurns} chained /e2e-turn run(s) have not started`] : []),
		...(ctx.isIdle() ? [] : ["pi is not idle"]),
		...(ctx.hasPendingMessages() ? ["pi has pending messages"] : []),
	];

	// Returns once nothing is outstanding and pi is idle with no pending message. Wakes on
	// waitForIdle (which also covers actions pi defers to after agent_settled) and on the
	// accounted events; the deadline fails with every outstanding item.
	const awaitQuiet = async (ctx: ExtensionCommandContext, deadlineMs: number): Promise<void> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"deadline">((resolve) => {
			timer = setTimeout(() => resolve("deadline"), deadlineMs);
		});
		const fail = (reason: string) => new Error(`/e2e-barrier ${reason}; outstanding: ${outstanding(ctx).join("; ") || "nothing"}`);
		try {
			for (;;) {
				// Subscribed before the checks, so an event between them is not missed.
				const changed = new Promise<"changed">((resolve) => wakeBarriers.push(() => resolve("changed")));
				const idle = ctx.waitForIdle().then(() => "idle" as const);
				if (await Promise.race([idle, deadline]) === "deadline") throw fail(`timed out after ${deadlineMs} ms waiting for idle`);
				if (accountingErrors.length > 0) throw fail(`cannot account for: ${accountingErrors.join("; ")}`);
				if (outstanding(ctx).length === 0) return;
				if (!ctx.isIdle()) continue;
				if (await Promise.race([changed, deadline]) === "deadline") throw fail(`timed out after ${deadlineMs} ms`);
			}
		} finally {
			clearTimeout(timer);
		}
	};

	pi.registerProvider(PROBE_PROVIDER, {
		api: PROBE_API, apiKey: "test-key", baseUrl: "http://localhost.invalid",
		models: [{
			id: PROBE_MODEL_ID, name: "Schematic E2E Model", reasoning: false,
			input: ["text"], cost: zeroCost, contextWindow: PROBE_CONTEXT_WINDOW, maxTokens: 1024,
		}],
		streamSimple(model, context) {
			const i = step++;
			log({ kind: "request", step: i, calls: runScript, texts: contextTexts(context.messages) });
			const id = `e2e-${runEntryCount}-${i}`;
			const scripted: ScriptedStep | null = runScript
				? i < runScript.length ? runScript[i] : null
				: i === 0 ? { name: "e2e_noop", arguments: {} } : null;
			const origin = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
			const stream = createAssistantMessageEventStream();
			if (scripted !== null && "error" in scripted) {
				const error: AssistantMessage = {
					...origin, role: "assistant", content: [], usage: usageOf(0), stopReason: "error", errorMessage: scripted.error,
				};
				queueMicrotask(() => {
					stream.push({ type: "error", reason: "error", error });
					stream.end();
				});
				return stream;
			}
			const toolCalls: ToolCall[] = scripted === null ? []
				: "name" in scripted ? [{ type: "toolCall", id, ...scripted }]
				: "calls" in scripted ? scripted.calls.map((call, n) => ({ type: "toolCall", id: `${id}-${n}`, ...call }))
				: [];
			const reply = scripted !== null && "text" in scripted ? scripted : { text: "ack", inputTokens: SCRIPTED_INPUT_TOKENS };
			const stopReason = toolCalls.length > 0 ? "toolUse" : "stop";
			const message: AssistantMessage = {
				...origin, role: "assistant",
				content: toolCalls.length > 0 ? toolCalls : [{ type: "text", text: reply.text }],
				usage: usageOf(toolCalls.length > 0 ? SCRIPTED_INPUT_TOKENS : reply.inputTokens), stopReason,
			};
			queueMicrotask(() => {
				stream.push({ type: "done", reason: stopReason, message });
				stream.end();
			});
			return stream;
		},
	});

	pi.registerTool({
		name: "e2e_noop",
		label: "E2E noop",
		description: "Does nothing and returns noop.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "noop" }], details: {} };
		},
	});

	pi.on("agent_start", async (_event, ctx) => {
		// pi starts a pass with agent_start for each automatic retry or continuation inside a
		// run; only the run's first agent_start, with no run awaiting agent_settled, starts one.
		if (runsAwaitingSettle > 0) return;
		runScript = armedScript;
		armedScript = null;
		step = 0;
		runEntryCount = ctx.sessionManager.getEntries().length;
		runsAwaitingSettle++;
		wake();
	});

	pi.on("agent_settled", async () => {
		if (runsAwaitingSettle === 0) accountingErrors.push("agent_settled without an agent_start");
		else runsAwaitingSettle--;
		// pi defers a send from an agent_settled handler until the handlers return, so the
		// chained run starts after this one has settled.
		if (chainedTurns > 0) {
			chainedTurns--;
			startTurn();
		}
		wake();
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		const index = inputsAwaitingDelivery.indexOf(messageText(event.message.content));
		if (index === -1) return;
		inputsAwaitingDelivery.splice(index, 1);
		wake();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		// A handoff call that returned without error has staged a cut for its turn_end.
		if (event.toolName !== "handoff" || event.isError) return;
		handoffCallsAwaitingBoundary.push(event.toolCallId);
		if (abortAfterHandoff) {
			abortAfterHandoff = false;
			ctx.abort();
		}
		wake();
	});

	pi.on("turn_end", async (event) => {
		for (const result of event.toolResults) {
			if (result.toolName !== "handoff" || result.isError) continue;
			const index = handoffCallsAwaitingBoundary.indexOf(result.toolCallId);
			if (index === -1) accountingErrors.push(`turn_end holds handoff result ${result.toolCallId} without its tool_execution_end`);
			else handoffCallsAwaitingBoundary.splice(index, 1);
		}
		const handoffId = event.entries.map(cutHandoffId).find((id) => id !== null);
		wake();
		if (handoffId === undefined) return undefined;
		const tamper = nextCutTamper;
		nextCutTamper = null;
		log({ kind: "cut", handoffId, dropped: tamper === "drop" });
		switch (tamper) {
			case null:
				return undefined;
			case "drop":
				// Drop every draft and the continuation, as pi itself does for an invalid boundary.
				return { entries: [], continue: false };
			case "dropSuccessor":
				return { entries: event.entries.filter((entry) => !(entry.type === "custom_message" && entry.customType === HANDOFF_SUCCESSOR_CUSTOM_TYPE)) };
			case "compactAfter":
				return { entries: [...event.entries, { type: "compaction", summary: "e2e compaction after the cut", firstKeptEntryId: null }] };
		}
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") return { action: "continue" };
		inputsAwaitingDelivery.push(event.text);
		wake();
		return { action: "continue" };
	});

	pi.on("session_compact", async (event) => {
		// A handoff cut is a boundary entry and fires no session_compact; this is pi's own compaction.
		log({ kind: "compact", entryId: event.compactionEntry.id });
		wake();
	});

	pi.registerCommand(PROBE_COMMAND.script, {
		description: "Arm a scripted tool-call sequence for the next run",
		handler: async (args) => {
			if (armedScript) throw new Error(`a script is already armed: ${JSON.stringify(armedScript)}`);
			armedScript = parseScript(args);
		},
	});

	pi.registerCommand(PROBE_COMMAND.barrier, {
		description: "Report under PROBE_BARRIER_STATUS_KEY once no accounted work is outstanding",
		handler: async (args, ctx) => {
			// Returns at once and reports through a status, so the wait is bounded by the
			// deadline the harness passes, not by RpcClient's fixed request timeout.
			// Still assumed: a send that a command, session_tree or agent_settled handler starts
			// (the /handoff request) shows up first as its "input" event; no
			// public event announces it earlier. A barrier processed before that event reports
			// quiet with the run still to come, so a harness step that has counted fewer runs
			// than it expects waits for the next observed event and barriers again. The
			// assumption therefore only reaches a step whose expected count is already met —
			// the "nothing happened" checks (0 expected runs) above all. Those stay sound while
			// schematic's /handoff, session_tree and agent_settled handlers and its "input"
			// handler ahead of this file's await no I/O (that one returns early for the
			// extension-sourced sends at issue here). A run that starts late anyway lands in the
			// next step's window or in close(), which fails on any run no step expected. Closing
			// this needs a pi API upstream declined (#9632, #10451, #9969).
			const [idText, deadlineText, ...rest] = args.trim().split(/\s+/);
			if (rest.length > 0) throw new Error(`/e2e-barrier expects "<id> <deadlineMs>", got: ${args}`);
			const id = parseBarrierArgument(idText, "id", args);
			const deadlineMs = parseBarrierArgument(deadlineText, "deadlineMs", args);
			const report = (outcome: BarrierReport) => ctx.ui.setStatus(PROBE_BARRIER_STATUS_KEY, JSON.stringify(outcome));
			void awaitQuiet(ctx, deadlineMs).then(
				() => report({ id, failure: null }),
				(error: unknown) => report({ id, failure: error instanceof Error ? error.message : String(error) }),
			);
		},
	});

	pi.registerCommand(PROBE_COMMAND.tree, {
		description: "Navigate the session tree to an entry",
		handler: async (args, ctx) => {
			const entryId = args.trim();
			if (!entryId) throw new Error("/e2e-tree needs an entry id");
			await ctx.navigateTree(entryId);
		},
	});

	pi.registerCommand(PROBE_COMMAND.turn, {
		description: "Start a run without a user turn; with a count, start each further run once the previous one settles",
		handler: async (args) => {
			chainedTurns = parseTurnCount(args) - 1;
			startTurn();
		},
	});

	pi.registerCommand(PROBE_COMMAND.dropNextCut, {
		description: "Drop the next handoff cut and its continuation from the turn_end boundary",
		handler: async () => {
			nextCutTamper = "drop";
		},
	});

	pi.registerCommand(PROBE_COMMAND.dropNextSuccessor, {
		description: "Keep the next handoff cut but drop its successor from the turn_end boundary",
		handler: async () => {
			nextCutTamper = "dropSuccessor";
		},
	});

	pi.registerCommand(PROBE_COMMAND.compactAfterNextCut, {
		description: "Append a compaction after the next handoff cut in the turn_end boundary",
		handler: async () => {
			nextCutTamper = "compactAfter";
		},
	});

	pi.registerCommand(PROBE_COMMAND.abortAfterHandoff, {
		description: "Abort the run once the next handoff call has returned without error",
		handler: async () => {
			abortAfterHandoff = true;
		},
	});

	pi.registerCommand(PROBE_COMMAND.tools, {
		description: "Log the names of every registered tool",
		handler: async () => {
			log({ kind: "tools", names: pi.getAllTools().map((tool) => tool.name) });
		},
	});
}
