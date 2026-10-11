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
	dropNextSuccessor: "e2e-drop-next-successor",
	cancelNextCompaction: "e2e-cancel-next-compaction",
	tools: "e2e-tools",
} as const;

/**
 * Heading the successor user message opens with, read off the production builder
 * so the probe recognizes the message schematic sends after a handoff.
 */
export const NEXT_INSTRUCTION_PREFIX = buildNextUserMessage({ nextInstruction: "x" }).split("\n")[0];

/** One scripted tool call: what `/e2e-script` arms and what the log carries. */
export type ScriptedCall = { name: string; arguments: ToolCall["arguments"] };

/** One line of the probe log. */
export type ProbeRecord =
	| { kind: "request"; step: number; calls: ScriptedCall[] | null; texts: string[] }
	| { kind: "compact"; entryId: string }
	| { kind: "successor-send"; text: string; dropped: boolean }
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

/** A request record's `calls`: the armed script, or null when no script was armed. */
function requireScriptedCalls(value: unknown, line: string): ScriptedCall[] | null {
	if (value === null) return null;
	if (!Array.isArray(value)) malformed(line, `calls is neither an array nor null: ${JSON.stringify(value)}`);
	return value.map((call: unknown, index) => {
		if (!isJsonObject(call)) malformed(line, `calls[${index}] is not an object: ${JSON.stringify(call)}`);
		const { name, arguments: callArguments } = call;
		if (typeof name !== "string" || name === "") {
			malformed(line, `calls[${index}] has no name: ${JSON.stringify(call)}`);
		}
		if (!isJsonObject(callArguments)) {
			malformed(line, `calls[${index}] has no arguments object: ${JSON.stringify(call)}`);
		}
		// The line came out of JSON.parse, so the arguments are JSON.
		return { name, arguments: callArguments as ToolCall["arguments"] };
	});
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
		case "successor-send":
			return {
				kind: "successor-send",
				text: requireString(parsed, "text", line),
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
