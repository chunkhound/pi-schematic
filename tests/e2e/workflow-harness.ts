/**
 * workflow-harness.ts — shared helpers for workflow E2E suites.
 *
 * Wraps `ProcessHarness` with the workflow opt-in and structured readers for the
 * protocol replies, so graders assert on transcript output (appended / ui-events /
 * footer), never on harness internals.
 */
import { ProcessHarness } from "./pty-harness.js";

export type AppendedEntry = Record<string, unknown>;

export interface UiEvents {
	statuses: Record<string, string | undefined>;
	notifications: { message: string; level: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

/** Look up the last single-line `OK:[...]` reply (the appended-entries dump). */
function lastLineOf(output: string, prefix: string): string | undefined {
	const lines = output.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith(prefix)) {
			return lines[i];
		}
	}
	return undefined;
}

/** Parse the last `OK:[...]` reply into an entries array, or null when absent. */
function lastJsonArray(output: string): Record<string, unknown>[] | null {
	const line = lastLineOf(output, "OK:[");
	if (line === undefined) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(3));
	} catch {
		return null;
	}
	if (!isArray(parsed)) {
		return null;
	}
	return parsed.map((entry) => {
		if (!isRecord(entry)) {
			throw new Error("an appended entry is not an object");
		}
		return entry;
	});
}

/** Read the raw payload of the last `OK:` reply for a verb. */
async function readRaw(h: ProcessHarness, verb: string): Promise<unknown> {
	h.write(verb);
	await h.waitForText("OK:");
	const line = lastLineOf(h.snapshot(), "OK:");
	if (line === undefined) {
		return null;
	}
	const payload = line.slice(3);
	try {
		return JSON.parse(payload);
	} catch {
		return payload;
	}
}

/** Spawn a child and opt into the workflow fakes (deterministic shell + pickers). */
async function startWorkflowChild(): Promise<ProcessHarness> {
	const h = new ProcessHarness();
	await h.waitForText("READY");
	h.write("workflow-mocks");
	await h.waitForText("OK");
	return h;
}

export async function withWorkflowChild(run: (h: ProcessHarness) => Promise<void>): Promise<void> {
	const h = await startWorkflowChild();
	try {
		await run(h);
	} finally {
		try {
			h.write("exit");
		} catch {
			// already dead
		}
		h.close();
	}
}

/** Send one verb line and wait for its OK acknowledgement. */
export async function sendOk(h: ProcessHarness, line: string): Promise<void> {
	h.write(line);
	await h.waitForText("OK");
}

/** All appended transcript entries of `customType` as their data payloads. */
export function entryRecords(entries: AppendedEntry[], customType: string): Record<string, unknown>[] {
	return entries
		.filter((entry) => entry.customType === customType)
		.map((entry) => {
			if (!isRecord(entry.data)) {
				throw new Error(`${customType} record is not an object`);
			}
			return entry.data;
		});
}

/** Read all appended transcript entries written so far. */
export async function readAppended(h: ProcessHarness): Promise<AppendedEntry[]> {
	h.write("appended");
	await h.waitForText("OK:");
	return lastJsonArray(h.snapshot()) ?? [];
}

/** Read the current status values and emitted notifications. */
export async function readUiEvents(h: ProcessHarness): Promise<UiEvents> {
	h.write("ui-events");
	await h.waitForText("OK:{");
	const value: unknown = await readRaw(h, "ui-events");
	if (!isRecord(value)) {
		return { statuses: {}, notifications: [] };
	}
	const rawStatuses = isRecord(value.statuses) ? value.statuses : {};
	const statuses: Record<string, string | undefined> = {};
	for (const [key, val] of Object.entries(rawStatuses)) {
		statuses[key] = typeof val === "string" ? val : undefined;
	}
	return {
		statuses,
		notifications: isArray(value.notifications)
			? value.notifications.map((notification) => {
					if (!isRecord(notification)) {
						return { message: "", level: "" };
					}
					return {
						message: typeof notification.message === "string" ? notification.message : "",
						level: typeof notification.level === "string" ? notification.level : "",
					};
				})
			: [],
	};
}

/** Run a workflow to completion and return the appended entries. */
export async function runWorkflow(h: ProcessHarness, workflowPath: string): Promise<AppendedEntry[]> {
	h.write(`cmd workflow ${workflowPath}`);
	await h.waitForText("OK");
	return readAppended(h);
}

/** Run a path workflow with verbatim args (the fixture reads them via `load("intent")`). */
export async function runWorkflowArgs(h: ProcessHarness, workflowPath: string, args: string): Promise<AppendedEntry[]> {
	h.write(`cmd workflow ${workflowPath} ${args}`);
	await h.waitForText("OK");
	return readAppended(h);
}

/** Captured model-override sequences, the seeded current model, and the live thinking level. */
export interface ModelCalls {
	model: unknown[];
	thinking: string[];
	current: unknown;
	thinkingLevel: string;
}

export function readModelCalls(h: ProcessHarness): Promise<ModelCalls | null> {
	return readRaw(h, "model-calls").then((value) => {
		if (!isRecord(value)) {
			return null;
		}
		return {
			model: isArray(value.model) ? value.model : [],
			thinking: isArray(value.thinking) ? value.thinking.filter((level): level is string => typeof level === "string") : [],
			current: value.current,
			thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : "",
		};
	});
}

export function readSentMessages(h: ProcessHarness): Promise<{ content: string; options?: unknown }[]> {
	return readRaw(h, "sent-messages").then((value) => {
		if (!isArray(value)) {
			return [];
		}
		return value.map((message) => {
			if (!isRecord(message)) {
				return { content: "" };
			}
			return { content: typeof message.content === "string" ? message.content : "", options: message.options };
		});
	});
}

export function readActiveTools(h: ProcessHarness): Promise<string[]> {
	return readRaw(h, "active-tools").then((value) => (isArray(value) ? value.filter((tool): tool is string => typeof tool === "string") : []));
}

/** Registered tool names; the `tools` verb replies with a comma-joined scalar, not JSON. */
export async function readTools(h: ProcessHarness): Promise<string[]> {
	const raw = await readRaw(h, "tools");
	if (typeof raw !== "string" || raw.length === 0) {
		return [];
	}
	return raw.split(",");
}

/** Installed unified-footer first line, or null when pi's built-in footer is active. */
export function readFooter(h: ProcessHarness): Promise<string | null> {
	return readRaw(h, "footer").then((value) => (typeof value === "string" ? value : null));
}

/** Whether a terminal-input (cancellation) listener is currently registered. */
export function readTerminal(h: ProcessHarness): Promise<{ registered: boolean }> {
	return readRaw(h, "terminal").then((value) => {
		if (!isRecord(value)) {
			return { registered: false };
		}
		return { registered: value.registered === true };
	});
}

/** Current setWidget keys. */
export function readWidgets(h: ProcessHarness): Promise<string[]> {
	return readRaw(h, "widgets").then((value) => (isArray(value) ? value.filter((widget): widget is string => typeof widget === "string") : []));
}

/**
 * Poll the extension outbox until `text` appears. Handoff prep messages land async in
 * sent-messages (never on stdout), so the caller cannot rely on waitForText. Polls at
 * most `attempts` times with a short sleep each, mirroring the previous wall-clock bound.
 */
export async function waitForSent(h: ProcessHarness, text: string, attempts = 150): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		h.write("sent-messages");
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (h.snapshot().includes(text)) {
			return;
		}
	}
	throw new Error(`waitForSent timeout waiting for outbox to include "${text}".\nOutput so far:\n${h.snapshot()}`);
}

export function readSandboxOptions(h: ProcessHarness): Promise<{ timeoutMs: number | string; memoryLimitBytes: number } | null> {
	return readRaw(h, "sandbox-options").then((value) => {
		if (!isRecord(value)) {
			return null;
		}
		return {
			timeoutMs: typeof value.timeoutMs === "number" || typeof value.timeoutMs === "string" ? value.timeoutMs : 0,
			memoryLimitBytes: typeof value.memoryLimitBytes === "number" ? value.memoryLimitBytes : 0,
		};
	});
}

/** The most recent `workflow-summary` payload, or undefined when none was appended. */
export function latestSummary(entries: AppendedEntry[]): Record<string, unknown> | undefined {
	return entryRecords(entries, "workflow-summary").at(-1);
}
