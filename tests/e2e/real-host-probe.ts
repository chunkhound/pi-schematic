/**
 * real-host-probe.ts — Probe extension loaded into the real pi CLI by the
 * real-host E2E harness (`real-host.ts`).
 *
 * Registers a scripted provider whose responses the test arms through
 * `/e2e-script`, plus commands that wait for outstanding work, navigate the tree,
 * start runs without a user turn, and inject delivery and compaction failures. Every
 * observation is appended as one JSON line to the file `PROBE_LOG_ENV_VAR` names.
 *
 * The harness loads this file after schematic, so its "input" handler runs last and
 * its "continue" means pi accepted the input.
 *
 * Runs inside the pi process: never write to stdout or stderr here.
 */

import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MIN_HANDOFF_TOKENS } from "../../handoff/eligibility.js";
import {
	NEXT_INSTRUCTION_PREFIX,
	PROBE_API,
	PROBE_BARRIER_STATUS_KEY,
	PROBE_COMMAND,
	PROBE_LOG_ENV_VAR,
	PROBE_MODEL_ID,
	PROBE_PROVIDER,
	type BarrierReport,
	type ProbeRecord,
	type ScriptedCall,
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
const usage = {
	input: SCRIPTED_INPUT_TOKENS, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: SCRIPTED_INPUT_TOKENS,
	cost: zeroCost,
};

function parseScript(args: string): ScriptedCall[] {
	const parsed: unknown = JSON.parse(args);
	if (!Array.isArray(parsed)) throw new Error(`/e2e-script expects a JSON array, got: ${args}`);
	return parsed.map((call: unknown, index) => {
		if (typeof call !== "object" || call === null) throw new Error(`/e2e-script call ${index} is not an object`);
		const { name, arguments: callArguments } = call as Record<string, unknown>;
		if (typeof name !== "string" || !name) throw new Error(`/e2e-script call ${index} has no name`);
		if (typeof callArguments !== "object" || callArguments === null || Array.isArray(callArguments)) {
			throw new Error(`/e2e-script call ${index} has no arguments object`);
		}
		// JSON.parse output: every value is JSON.
		return { name, arguments: callArguments as ToolCall["arguments"] };
	});
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

	let armedScript: ScriptedCall[] | null = null;
	let runScript: ScriptedCall[] | null = null;
	let step = 0;
	let runEntryCount = 0;
	let dropNextSuccessor = false;
	let cancelNextCompaction = false;

	// Outstanding work, kept from public extension events only; /e2e-barrier waits until
	// none is left. A successful handoff tool call awaits its compaction's outcome; a handoff
	// compaction awaits its successor input and a failed one its failure-report input
	// (schematic sends one either way); an accepted extension input awaits the user message
	// that delivers it, in a new run or queued into the running one; a run awaits agent_settled.
	const handoffCallsAwaitingCompaction: string[] = [];
	const compactionsAwaitingSuccessor: string[] = [];
	let failedCompactionsAwaitingReport = 0;
	const inputsAwaitingDelivery: string[] = [];
	let runsAwaitingSettle = 0;
	const accountingErrors: string[] = [];
	let wakeBarriers: Array<() => void> = [];
	const wake = () => {
		const waiting = wakeBarriers;
		wakeBarriers = [];
		for (const resolve of waiting) resolve();
	};

	const outstanding = (ctx: ExtensionCommandContext): string[] => [
		...handoffCallsAwaitingCompaction.map((id) => `handoff call ${id} has no compaction outcome`),
		...compactionsAwaitingSuccessor.map((id) => `handoff compaction ${id} has no successor input`),
		...(failedCompactionsAwaitingReport > 0 ? [`${failedCompactionsAwaitingReport} failed handoff compaction(s) have no failure-report input`] : []),
		...inputsAwaitingDelivery.map((text) => `extension input ${JSON.stringify(text.slice(0, 80))} has no user message`),
		...(runsAwaitingSettle > 0 ? [`${runsAwaitingSettle} run(s) have no agent_settled`] : []),
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
			input: ["text"], cost: zeroCost, contextWindow: 200000, maxTokens: 1024,
		}],
		streamSimple(model, context) {
			const i = step++;
			log({ kind: "request", step: i, calls: runScript, texts: contextTexts(context.messages) });
			const id = `e2e-${runEntryCount}-${i}`;
			const toolCall: ToolCall | null = runScript
				? i < runScript.length ? { type: "toolCall", id, ...runScript[i] } : null
				: i === 0 ? { type: "toolCall", id, name: "e2e_noop", arguments: {} } : null;
			const stopReason = toolCall ? "toolUse" : "stop";
			const message: AssistantMessage = {
				role: "assistant",
				content: toolCall ? [toolCall] : [{ type: "text", text: "ack" }],
				api: model.api, provider: model.provider, model: model.id,
				usage, stopReason, timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
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
		wake();
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		const index = inputsAwaitingDelivery.indexOf(messageText(event.message.content));
		if (index === -1) return;
		inputsAwaitingDelivery.splice(index, 1);
		wake();
	});

	pi.on("tool_execution_end", async (event) => {
		// A handoff call that returned without error has called ctx.compact.
		if (event.toolName !== "handoff" || event.isError) return;
		handoffCallsAwaitingCompaction.push(event.toolCallId);
		wake();
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") return { action: "continue" };
		const successor = event.text.startsWith(NEXT_INSTRUCTION_PREFIX);
		const dropped = successor && dropNextSuccessor;
		if (successor) {
			dropNextSuccessor = false;
			log({ kind: "successor-send", text: event.text, dropped });
			compactionsAwaitingSuccessor.shift();
		} else if (failedCompactionsAwaitingReport > 0) {
			failedCompactionsAwaitingReport--;
		}
		if (!dropped) inputsAwaitingDelivery.push(event.text);
		wake();
		return dropped ? { action: "handled" } : { action: "continue" };
	});

	pi.on("session_before_compact", async () => {
		if (!cancelNextCompaction) return;
		cancelNextCompaction = false;
		return { cancel: true };
	});

	pi.on("session_compact", async (event) => {
		const entryId = event.compactionEntry.id;
		log({ kind: "compact", entryId });
		if ((event.compactionEntry.details as { handoff?: unknown } | undefined)?.handoff === true) {
			if (handoffCallsAwaitingCompaction.shift() === undefined) accountingErrors.push(`handoff compaction ${entryId} without a handoff call`);
			compactionsAwaitingSuccessor.push(entryId);
		}
		wake();
	});

	pi.on("session_compact_failed", async () => {
		if (handoffCallsAwaitingCompaction.shift() !== undefined) failedCompactionsAwaitingReport++;
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
			// (the /handoff request, handoff recovery) shows up first as its "input" event; no
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
		description: "Start a run without a user turn",
		handler: async () => {
			pi.sendMessage({ customType: "schematic-e2e-turn", content: "e2e tick", display: false }, { triggerTurn: true });
		},
	});

	pi.registerCommand(PROBE_COMMAND.dropNextSuccessor, {
		description: "Drop the next successor send before it reaches the session",
		handler: async () => {
			dropNextSuccessor = true;
		},
	});

	pi.registerCommand(PROBE_COMMAND.cancelNextCompaction, {
		description: "Cancel the next compaction from session_before_compact",
		handler: async () => {
			cancelNextCompaction = true;
		},
	});

	pi.registerCommand(PROBE_COMMAND.tools, {
		description: "Log the names of every registered tool",
		handler: async () => {
			log({ kind: "tools", names: pi.getAllTools().map((tool) => tool.name) });
		},
	});
}
