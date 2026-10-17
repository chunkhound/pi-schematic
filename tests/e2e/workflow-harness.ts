/**
 * workflow-harness.ts — shared helpers for workflow E2E suites.
 *
 * Wraps `ProcessHarness` with the workflow opt-in and structured readers for the
 * protocol replies, so graders assert on transcript output (appended / ui-events /
 * footer), never on harness internals.
 */
import { ProcessHarness } from "./pty-harness.js";

export interface AppendedEntry {
	customType: string;
	data: unknown;
}

export interface UiEvents {
	statuses: Record<string, string | undefined>;
	notifications: Array<{ message: string; level: string }>;
}

/** Spawn a child and opt into the workflow fakes (deterministic shell + pickers). */
export async function startWorkflowChild(): Promise<ProcessHarness> {
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

/** Parse the last single-line `OK:[...]` reply (the appended-entries dump). */
function lastJsonArray(output: string): AppendedEntry[] | null {
	const line = output.split("\n").filter((candidate) => candidate.startsWith("OK:[")).at(-1);
	return line ? JSON.parse(line.slice(3)) : null;
}

function lastJsonObject<T>(output: string): T | null {
	const line = output.split("\n").filter((candidate) => candidate.startsWith("OK:{")).at(-1);
	return line ? JSON.parse(line.slice(3)) : null;
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
	return lastJsonObject<UiEvents>(h.snapshot()) ?? { statuses: {}, notifications: [] };
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

/** Parse the last single-line JSON payload reply for `verb` (object, array, or scalar). */
async function readJson<T>(h: ProcessHarness, verb: string): Promise<T | null> {
	h.write(verb);
	await h.waitForText("OK:");
	const line = h.snapshot().split("\n").filter((candidate) => candidate.startsWith("OK:")).at(-1);
	if (!line) return null;
	const payload = line.slice(3);
	try {
		return JSON.parse(payload) as T;
	} catch {
		return payload as unknown as T;
	}
}

/** Captured model-override sequences, the seeded current model, and the live thinking level. */
export interface ModelCalls {
	model: unknown[];
	thinking: string[];
	current: unknown;
	thinkingLevel: string;
}

export function readModelCalls(h: ProcessHarness): Promise<ModelCalls | null> {
	return readJson<ModelCalls>(h, "model-calls");
}

export function readSentMessages(h: ProcessHarness): Promise<Array<{ content: string; options?: unknown }>> {
	return readJson<Array<{ content: string; options?: unknown }>>(h, "sent-messages").then((value) => value ?? []);
}

export function readActiveTools(h: ProcessHarness): Promise<string[]> {
	return readJson<string[]>(h, "active-tools").then((value) => value ?? []);
}

/** Registered tool names; the `tools` verb replies with a comma-joined scalar, not JSON. */
export async function readTools(h: ProcessHarness): Promise<string[]> {
	const raw = await readJson<string>(h, "tools");
	return typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
}

/** Installed unified-footer first line, or null when pi's built-in footer is active. */
export function readFooter(h: ProcessHarness): Promise<string | null> {
	return readJson<string | null>(h, "footer");
}

/** Whether a terminal-input (cancellation) listener is currently registered. */
export function readTerminal(h: ProcessHarness): Promise<{ registered: boolean }> {
	return readJson<{ registered: boolean }>(h, "terminal").then((value) => value ?? { registered: false });
}

/** Current setWidget keys. */
export function readWidgets(h: ProcessHarness): Promise<string[]> {
	return readJson<string[]>(h, "widgets").then((value) => value ?? []);
}

/**
 * Poll the extension outbox until `text` appears. Handoff prep messages land async in
 * sent-messages (never on stdout), so the caller cannot rely on waitForText.
 */
export async function waitForSent(h: ProcessHarness, text: string, timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		h.write("sent-messages");
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (h.snapshot().includes(text)) return;
	}
	throw new Error(`waitForSent timeout waiting for outbox to include "${text}".\nOutput so far:\n${h.snapshot()}`);
}

export function readSandboxOptions(h: ProcessHarness): Promise<{ timeoutMs: number | string; memoryLimitBytes: number } | null> {
	return readJson(h, "sandbox-options");
}

/** The most recent `workflow-summary` payload, or undefined when none was appended. */
export function latestSummary(entries: AppendedEntry[]): Record<string, any> | undefined {
	const summaries = entries.filter((entry) => entry.customType === "workflow-summary");
	return summaries.at(-1)?.data as Record<string, any> | undefined;
}
