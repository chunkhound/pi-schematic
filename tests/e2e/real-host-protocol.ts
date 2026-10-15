/**
 * real-host-protocol.ts — the contract between the real-host harness
 * (`real-host.ts`) and the probe extension the harness loads into pi
 * (`real-host-probe.ts`).
 *
 * Both sides import this module: the harness under the node:test loader, the
 * probe inside the pi process under jiti. It imports no pi runtime code and
 * evaluates nothing but one constant, so it loads in either environment.
 */

import type { ToolCall } from "@earendil-works/pi-ai";
import { buildNextUserMessage } from "../../handoff/format.js";

/** Provider, API and model the probe registers and the harness selects. */
export const PROBE_PROVIDER = "schematic-e2e";
export const PROBE_API = "schematic-e2e-api";
export const PROBE_MODEL_ID = "schematic-e2e-model";
/** Context window of the probe model, which pi's threshold compaction measures usage against. */
export const PROBE_CONTEXT_WINDOW = 200000;

/** File the probe appends its JSON records to; the harness reads and validates them. */
export const PROBE_LOG_ENV_VAR = "PI_SCHEMATIC_E2E_PROBE_LOG";

/** Status key the probe reports each `/e2e-barrier` outcome under, as a JSON `BarrierReport`. */
export const PROBE_BARRIER_STATUS_KEY = "schematic-e2e-barrier";

/** Probe command names as `pi.registerCommand` takes them, without the leading slash. */
export const PROBE_COMMAND = {
	script: "e2e-script",
	barrier: "e2e-barrier",
	tree: "e2e-tree",
	turn: "e2e-turn",
	dropNextCut: "e2e-drop-next-cut",
	abortAfterHandoff: "e2e-abort-after-handoff",
	tools: "e2e-tools",
} as const;

/** Heading the successor message opens with, read off the production builder. */
export const NEXT_INSTRUCTION_PREFIX = buildNextUserMessage({ nextInstruction: "x" }).split("\n")[0];

/** One scripted tool call. */
export type ScriptedCall = { name: string; arguments: ToolCall["arguments"] };

/** A provider error the model call ends with; pi retries it when retry is enabled and `error` matches a retryable pattern. */
export type ScriptedError = { error: string };

/** A text reply that reports `inputTokens` of context usage in place of the probe's default. */
export type ScriptedReply = { text: string; inputTokens: number };

/** Several tool calls the model makes in one assistant message, in order. */
export type ScriptedBatch = { calls: ScriptedCall[] };

/** One scripted model response: what `/e2e-script` arms, one per model call of the run, and what the log carries. */
export type ScriptedStep = ScriptedCall | ScriptedBatch | ScriptedError | ScriptedReply;

/** One line of the probe log. */
export type ProbeRecord =
	| { kind: "request"; step: number; calls: ScriptedStep[] | null; texts: string[] }
	| { kind: "compact"; entryId: string }
	| { kind: "cut"; handoffId: string; dropped: boolean }
	| { kind: "tools"; names: string[] };

/**
 * Outcome of `/e2e-barrier <id> <deadlineMs>`: `failure` is null once nothing is outstanding,
 * or the reason the barrier gave up, naming every outstanding item.
 */
export type BarrierReport = { id: number; failure: string | null };

/** Fail on a record the probe should never have written; `line` is the raw log line. */
function malformed(line: string, reason: string): never {
	throw new Error(`Probe log line is malformed (${reason}): ${line}`);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStep(record: Record<string, unknown>, field: string, line: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		malformed(line, `${field} is not a step count: ${JSON.stringify(value)}`);
	}
	return value;
}

function requireString(record: Record<string, unknown>, field: string, line: string): string {
	const value = record[field];
	if (typeof value !== "string") malformed(line, `${field} is not a string: ${JSON.stringify(value)}`);
	return value;
}

function requireBoolean(record: Record<string, unknown>, field: string, line: string): boolean {
	const value = record[field];
	if (typeof value !== "boolean") malformed(line, `${field} is not a boolean: ${JSON.stringify(value)}`);
	return value;
}

function requireStringArray(record: Record<string, unknown>, field: string, line: string): string[] {
	const value = record[field];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		malformed(line, `${field} is not a string array: ${JSON.stringify(value)}`);
	}
	return value;
}

/** One scripted call, parsed strictly: an object with a non-empty `name` and an `arguments` object only. */
function parseScriptedCall(value: unknown, fail: (reason: string) => never): ScriptedCall {
	if (!isJsonObject(value)) fail(`not an object: ${JSON.stringify(value)}`);
	const { name, arguments: callArguments, ...rest } = value;
	if (typeof name !== "string" || name === "") fail(`no name: ${JSON.stringify(value)}`);
	if (!isJsonObject(callArguments)) fail(`no arguments object: ${JSON.stringify(value)}`);
	if (Object.keys(rest).length > 0) fail(`a call step takes only name and arguments: ${JSON.stringify(value)}`);
	// The value came out of JSON.parse, so the arguments are JSON.
	return { name, arguments: callArguments as ToolCall["arguments"] };
}

/**
 * One scripted step, parsed strictly: an object with `error` is a `ScriptedError`, one with `text`
 * a `ScriptedReply`, one with `calls` a `ScriptedBatch`, any other a `ScriptedCall`. `fail` throws
 * with the reason.
 */
export function parseScriptedStep(value: unknown, fail: (reason: string) => never): ScriptedStep {
	if (!isJsonObject(value)) fail(`not an object: ${JSON.stringify(value)}`);
	if ("error" in value) {
		const { error, ...rest } = value;
		if (typeof error !== "string" || error === "") fail(`error is not a non-empty string: ${JSON.stringify(value)}`);
		if (Object.keys(rest).length > 0) fail(`an error step takes no other field: ${JSON.stringify(value)}`);
		return { error };
	}
	if ("text" in value) {
		const { text, inputTokens, ...rest } = value;
		if (typeof text !== "string") fail(`text is not a string: ${JSON.stringify(value)}`);
		if (typeof inputTokens !== "number" || !Number.isInteger(inputTokens) || inputTokens <= 0) {
			fail(`inputTokens is not a positive integer: ${JSON.stringify(value)}`);
		}
		if (Object.keys(rest).length > 0) fail(`a reply step takes only text and inputTokens: ${JSON.stringify(value)}`);
		return { text, inputTokens };
	}
	if ("calls" in value) {
		const { calls, ...rest } = value;
		if (!Array.isArray(calls) || calls.length === 0) fail(`calls is not a non-empty array: ${JSON.stringify(value)}`);
		if (Object.keys(rest).length > 0) fail(`a batch step takes only calls: ${JSON.stringify(value)}`);
		return { calls: calls.map((call: unknown, index) => parseScriptedCall(call, (reason) => fail(`calls[${index}]: ${reason}`))) };
	}
	return parseScriptedCall(value, fail);
}

/** A request record's `calls`: the armed script, or null when no script was armed. */
function requireScriptedCalls(value: unknown, line: string): ScriptedStep[] | null {
	if (value === null) return null;
	if (!Array.isArray(value)) malformed(line, `calls is neither an array nor null: ${JSON.stringify(value)}`);
	return value.map((step: unknown, index) => parseScriptedStep(step, (reason) => malformed(line, `calls[${index}]: ${reason}`)));
}

/** Parse one probe-log line; throws on an unknown kind or a record missing a required field. */
export function parseProbeRecord(line: string): ProbeRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Probe log line is not JSON (${detail}): ${line}`);
	}
	if (!isJsonObject(parsed)) throw new Error(`Probe log line is not a record: ${line}`);
	switch (parsed.kind) {
		case "request":
			return {
				kind: "request",
				step: requireStep(parsed, "step", line),
				calls: requireScriptedCalls(parsed.calls, line),
				texts: requireStringArray(parsed, "texts", line),
			};
		case "compact":
			return { kind: "compact", entryId: requireString(parsed, "entryId", line) };
		case "cut":
			return {
				kind: "cut",
				handoffId: requireString(parsed, "handoffId", line),
				dropped: requireBoolean(parsed, "dropped", line),
			};
		case "tools":
			return { kind: "tools", names: requireStringArray(parsed, "names", line) };
		default:
			throw new Error(`Probe log line has an unknown kind ${JSON.stringify(parsed.kind)}: ${line}`);
	}
}

/** Parse the status text of a `PROBE_BARRIER_STATUS_KEY` status; throws on anything but a `BarrierReport`. */
export function parseBarrierReport(text: string): BarrierReport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Barrier report is not JSON (${detail}): ${text}`);
	}
	if (!isJsonObject(parsed)) throw new Error(`Barrier report is not a record: ${text}`);
	const { id, failure } = parsed;
	if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
		throw new Error(`Barrier report id is not a positive integer: ${text}`);
	}
	if (failure !== null && typeof failure !== "string") {
		throw new Error(`Barrier report failure is neither a string nor null: ${text}`);
	}
	return { id, failure };
}
