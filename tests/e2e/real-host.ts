/**
 * real-host.ts — Harness that runs pi-schematic inside the real pi CLI in RPC
 * mode, driven through `RpcClient`, with the scripted probe provider from
 * `real-host-probe.ts`.
 *
 * Every helper that starts a run or navigates the tree is a step: it returns only
 * once `/e2e-barrier` reports no outstanding work, so tests never issue a
 * non-command prompt while a run or compaction is active, and it fails unless the
 * step started exactly the runs its caller expected. A step that has counted fewer
 * runs than it expects barriers again — a run a command, session_tree or agent_settled
 * handler starts is first visible to the probe at its "input" event — within one
 * barrier's budget. `close()` fails on any run that started outside every step.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { RpcClient, SessionManager, type RpcClientOptions, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	parseBarrierReport,
	parseProbeRecord,
	PROBE_BARRIER_STATUS_KEY,
	PROBE_COMMAND,
	PROBE_LOG_ENV_VAR,
	PROBE_MODEL_ID,
	PROBE_PROVIDER,
	type BarrierReport,
	type ProbeRecord,
	type ScriptedCall,
} from "./real-host-protocol.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMATIC_ENTRY = resolve(HERE, "..", "..", "index.ts");
const PROBE_ENTRY = resolve(HERE, "real-host-probe.ts");
const CLI_PATH = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const REQUIRED_COMMANDS = ["handoff", "notebook", "readonly", PROBE_COMMAND.barrier];

/** Barrier waits one host may make, its `close()` included; a test that needs more fails. */
const REAL_HOST_MAX_BARRIERS_PER_TEST = 4;
/** How much longer than the probe's own deadline the harness waits for a barrier report. */
const BARRIER_REPORT_MARGIN_MS = 5_000;
/** Largest `timeout` node:test accepts; a larger one throws ERR_OUT_OF_RANGE when the test registers. */
const NODE_TEST_MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * `node:test` timeout for a real-host test whose barriers each wait `waitMs`: every barrier
 * a test may make running to its harness deadline, plus a minute for start, commands and
 * close, so a slow test fails with the harness's message, not node:test's. A step that
 * barriers again spends that same deadline and can stretch its phase by one report backstop,
 * which that minute absorbs.
 */
function testTimeoutFor(waitMs: number): number {
	return REAL_HOST_MAX_BARRIERS_PER_TEST * (waitMs + BARRIER_REPORT_MARGIN_MS) + 60_000;
}

function readTimeout(): number {
	const raw = process.env.E2E_REAL_HOST_TIMEOUT_MS;
	if (raw === undefined) return 20_000;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`E2E_REAL_HOST_TIMEOUT_MS must be a positive integer, got: ${raw}`);
	}
	if (testTimeoutFor(value) > NODE_TEST_MAX_TIMEOUT_MS) {
		const max = Math.floor((NODE_TEST_MAX_TIMEOUT_MS - 60_000) / REAL_HOST_MAX_BARRIERS_PER_TEST) - BARRIER_REPORT_MARGIN_MS;
		throw new Error(
			`E2E_REAL_HOST_TIMEOUT_MS=${raw} makes the per-test timeout ${testTimeoutFor(value)} ms, ` +
			`above node:test's limit of ${NODE_TEST_MAX_TIMEOUT_MS} ms; use at most ${max}`,
		);
	}
	return value;
}

/** How long one barrier waits for outstanding work before it fails. */
export const REAL_HOST_TIMEOUT_MS = readTimeout();

export const REAL_HOST_TEST_TIMEOUT_MS = testTimeoutFor(REAL_HOST_TIMEOUT_MS);

/**
 * Deadline a step shares with every barrier round it makes: the budget of a single barrier before
 * the retry, the probe deadline plus the harness's backstop for its report.
 *
 * A round takes what is left of that deadline as its probe deadline, so the rounds together spend
 * one barrier's probe budget, and the harness waits the backstop on top of the last one. A step's
 * phase can therefore outlast its deadline by that backstop, which stays inside the minute
 * `testTimeoutFor` leaves for start, commands and close.
 */
const STEP_BUDGET_MS = REAL_HOST_TIMEOUT_MS + BARRIER_REPORT_MARGIN_MS;

/** Same expressions as tests/unit/helpers.ts; this harness imports nothing from tests/unit/. */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export type RpcEvent = { type: string; [key: string]: unknown };
export type Notification = { message: string; notifyType: string | undefined };
export type Status = { statusKey: string; statusText: string | undefined };
export type ToolResult = { isError: boolean; text: string };

export interface RealHostOptions {
	seedSession?: (session: SessionManager) => void;
}

function pathEnv(): Record<string, string> {
	const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
	if (!key) throw new Error("No PATH variable in the test environment");
	const current = process.env[key];
	return { [key]: current ? `${dirname(process.execPath)}${delimiter}${current}` : dirname(process.execPath) };
}

function requireString(event: RpcEvent, field: string): string {
	const value = event[field];
	if (typeof value !== "string") throw new Error(`${event.type} field ${field} is not a string: ${JSON.stringify(event)}`);
	return value;
}

function countRuns(events: RpcEvent[]): number {
	return events.filter((event) => event.type === "agent_start").length;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run `body`; when it throws, run `cleanup` and rethrow the body's error. A cleanup
 * error never hides it: both are thrown together as an AggregateError.
 */
async function cleanupOnFailure<T>(body: () => Promise<T>, cleanup: () => unknown): Promise<T> {
	try {
		return await body();
	} catch (failure) {
		try {
			await cleanup();
		} catch (cleanupError) {
			throw new AggregateError(
				[failure, cleanupError],
				`${describeError(failure)}; cleanup also failed: ${describeError(cleanupError)}`,
			);
		}
		throw failure;
	}
}

/** Run `body`, then `cleanup` whether or not it threw; see `cleanupOnFailure`. */
async function withCleanup<T>(body: () => Promise<T>, cleanup: () => unknown): Promise<T> {
	const result = await cleanupOnFailure(body, cleanup);
	await cleanup();
	return result;
}

/** Project `extension_ui_request` setStatus events; a cleared status has `statusText` undefined. */
export function projectStatuses(events: RpcEvent[]): Status[] {
	return events
		.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus")
		.map((event) => ({
			statusKey: requireString(event, "statusKey"),
			statusText: event.statusText === undefined ? undefined : stripAnsi(requireString(event, "statusText")),
		}));
}

/** Text of a message's content: string content as is, text blocks joined by newlines. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) throw new Error(`Unexpected message content: ${JSON.stringify(content)}`);
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Tool results named `name` in an `entries()` snapshot, in session order. */
export function toolResults(entries: SessionEntry[], name: string): ToolResult[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== name) return [];
		return [{ isError: entry.message.isError, text: messageText(entry.message.content) }];
	});
}

export class RealHost {
	client: RpcClient;
	events: RpcEvent[];
	readonly projectDir: string;
	private readonly root: string;
	private readonly logPath: string;
	private options: RpcClientOptions;
	private closing: Promise<void> | null = null;
	/** Barrier phases begun — one per step, one for `close()`; the rounds of a step share its phase. */
	private barrierPhases = 0;
	/** `/e2e-barrier` commands sent; every round reports under its own id. */
	private barrierRounds = 0;
	/** Runs counted inside step windows, and runs of clients replaced by restart(). */
	private stepRuns = 0;
	private runsBeforeRestart = 0;

	private constructor(root: string, logPath: string, options: RpcClientOptions, client: RpcClient, events: RpcEvent[]) {
		this.root = root;
		this.logPath = logPath;
		this.projectDir = join(root, "project");
		this.options = options;
		this.client = client;
		this.events = events;
	}

	static async start(options: RealHostOptions = {}): Promise<RealHost> {
		if (!existsSync(CLI_PATH)) throw new Error(`pi CLI not found at ${CLI_PATH}`);
		const root = mkdtempSync(join(os.tmpdir(), "pi-schematic-e2e-"));
		return cleanupOnFailure(async () => {
			const agentDir = join(root, "agent");
			const homeDir = join(root, "home");
			const projectDir = join(root, "project");
			const sessionsDir = join(root, "sessions");
			const logPath = join(root, "probe.jsonl");
			for (const dir of [agentDir, homeDir, projectDir, sessionsDir]) mkdirSync(dir);
			writeFileSync(logPath, "");
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
				compaction: { enabled: false, keepRecentTokens: 1 },
				retry: { enabled: false },
			}));
			const args = [
				"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
				"--no-context-files", "--no-approve", "--offline",
				"--session-dir", sessionsDir,
				"-e", SCHEMATIC_ENTRY,
				"-e", PROBE_ENTRY,
			];
			if (options.seedSession) {
				const session = SessionManager.create(projectDir, sessionsDir);
				options.seedSession(session);
				const sessionFile = session.getSessionFile();
				if (!sessionFile || !existsSync(sessionFile)) {
					throw new Error(`Seeded session file was not written (${sessionFile}); the seed must append a user or assistant message`);
				}
				args.push("--session", sessionFile);
			}
			const clientOptions: RpcClientOptions = {
				cliPath: CLI_PATH,
				cwd: projectDir,
				provider: PROBE_PROVIDER,
				model: PROBE_MODEL_ID,
				env: {
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					HOME: homeDir,
					USERPROFILE: homeDir,
					[PROBE_LOG_ENV_VAR]: logPath,
					FORCE_COLOR: "0",
					NODE_OPTIONS: "",
					...pathEnv(),
				},
				args,
			};
			const { client, events } = await startClient(clientOptions);
			return new RealHost(root, logPath, clientOptions, client, events);
		}, () => removeRoot(root));
	}

	get notifications(): Notification[] {
		return this.events
			.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
			.map((event) => ({
				message: requireString(event, "message"),
				notifyType: event.notifyType === undefined ? undefined : requireString(event, "notifyType"),
			}));
	}

	get statuses(): Status[] {
		return projectStatuses(this.events);
	}

	/** Run an extension command; it must report "handled" without an extension_error, from the command or from any handler it triggers. */
	async command(text: string): Promise<void> {
		if (!text.startsWith("/")) throw new Error(`command() needs a slash command, got: ${text}`);
		const mark = this.events.length;
		const disposition = await this.client.prompt(text);
		if (disposition !== "handled") throw new Error(`${text} reported "${disposition}", expected "handled"`);
		const spaceIndex = text.indexOf(" ");
		const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		this.assertNoExtensionErrors(mark, text, `command:${name}`);
	}

	/** Submit a user prompt on an idle session; a step that starts `runs` runs, its own included. */
	async say(text: string, runs: number): Promise<void> {
		const mark = this.events.length;
		const disposition = await this.client.prompt(text);
		if (disposition !== "started") throw new Error(`"${text}" reported "${disposition}", expected "started"`);
		await this.step(mark, `"${text}"`, runs);
	}

	/** Run a command whose handler starts a run on an idle session; a step that starts `runs` runs. */
	async turn(text: string, runs: number): Promise<void> {
		const mark = this.events.length;
		await this.command(text);
		await this.step(mark, text, runs);
	}

	async arm(calls: ScriptedCall[]): Promise<void> {
		await this.command("/" + PROBE_COMMAND.script + " " + JSON.stringify(calls));
	}

	/** Arm `calls` and say "go"; a step that starts `runs` runs. */
	async script(calls: ScriptedCall[], runs: number): Promise<void> {
		await this.arm(calls);
		await this.say("go", runs);
	}

	/** Wait for outstanding work; a step that starts `runs` runs. */
	async settle(runs: number): Promise<void> {
		await this.step(this.events.length, "settle", runs);
	}

	async entries(): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		return this.client.getEntries();
	}

	probeLog(): ProbeRecord[] {
		return readFileSync(this.logPath, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => parseProbeRecord(line));
	}

	successorSends(): Array<Extract<ProbeRecord, { kind: "successor-send" }>> {
		return this.probeLog().filter((record): record is Extract<ProbeRecord, { kind: "successor-send" }> => record.kind === "successor-send");
	}

	/** Navigate the tree to `entryId`; a step that starts `runs` runs. */
	async navigate(entryId: string, runs: number): Promise<void> {
		const mark = this.events.length;
		await this.command("/" + PROBE_COMMAND.tree + " " + entryId);
		await this.step(mark, `navigate to ${entryId}`, runs);
	}

	/** Stop the CLI and start a new one on the same session file, temp root and probe log. */
	async restart(): Promise<void> {
		const { sessionFile } = await this.client.getState();
		if (!sessionFile || !existsSync(sessionFile)) {
			throw new Error(`restart() needs a session file on disk (${sessionFile}); pi writes it only after a user or assistant message`);
		}
		await this.client.stop();
		const args = [...(this.options.args ?? [])];
		const sessionIndex = args.indexOf("--session");
		if (sessionIndex !== -1) args.splice(sessionIndex, 2);
		args.push("--session", sessionFile);
		this.options = { ...this.options, args };
		// A timed-out test body keeps running after its after-hook closed the host; whatever the
		// new CLI wrote into the removed root, and the CLI itself when it started, is cleared here.
		const { client, events } = await cleanupOnFailure(() => startClient(this.options), () => {
			if (this.closing) removeRoot(this.root);
		});
		if (this.closing) {
			await withCleanup(() => client.stop(), () => removeRoot(this.root));
			throw new Error("restart() finished after close(); the new CLI was stopped");
		}
		this.runsBeforeRestart += countRuns(this.events);
		this.client = client;
		this.events = events;
	}

	/**
	 * Wait for outstanding work and fail on any run no step expected, then stop the CLI and
	 * remove the temp root. Runs once: every call returns the first call's outcome.
	 */
	close(): Promise<void> {
		this.closing ??= withCleanup(
			() => withCleanup(() => this.assertNoUnexpectedRuns(), () => this.client.stop()),
			() => removeRoot(this.root),
		);
		return this.closing;
	}

	private async assertNoUnexpectedRuns(): Promise<void> {
		this.startBarrierPhase();
		await this.barrier(REAL_HOST_TIMEOUT_MS);
		const unexpected = this.runsBeforeRestart + countRuns(this.events) - this.stepRuns;
		if (unexpected !== 0) throw new Error(`${unexpected} run(s) started outside every step; no step expected them`);
	}

	/**
	 * Throw when any extension_error event, from a command or an event handler, arrived at or
	 * after `mark`. An error from extension path `commandPath` is reported as the command's own failure.
	 */
	private assertNoExtensionErrors(mark: number, action: string, commandPath?: string): void {
		const failures = this.events.slice(mark).filter((event) => event.type === "extension_error");
		const own = commandPath === undefined ? undefined : failures.find((event) => event.extensionPath === commandPath);
		if (own) throw new Error(`${action} failed: ${requireString(own, "error")}`);
		const failure = failures[0];
		if (!failure) return;
		throw new Error(
			`${action} raised an extension error in ${requireString(failure, "extensionPath")} ` +
			`(event ${requireString(failure, "event")}): ${requireString(failure, "error")}`,
		);
	}

	/**
	 * End a step that began at event index `mark`: wait for the barrier, require no extension_error
	 * since `mark`, then require exactly `runs` agent_start events since `mark`.
	 *
	 * A run a command, session_tree or agent_settled handler starts is first visible to the probe at
	 * its "input" event, so a barrier can report quiet before that run has started. A step that has
	 * counted fewer runs than it expects therefore barriers again after the next observed event,
	 * inside the step's one `STEP_BUDGET_MS`; every round spends what is left of it, so a run that
	 * appears late still gets a barrier that measures it with quiet. More runs than expected, or
	 * the budget, fail.
	 */
	private async step(mark: number, action: string, runs: number): Promise<void> {
		this.startBarrierPhase();
		const deadline = Date.now() + STEP_BUDGET_MS;
		let rounds = 0;
		let started = 0;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			rounds++;
			await this.barrier(remaining);
			this.assertNoExtensionErrors(mark, action);
			started = countRuns(this.events.slice(mark));
			if (started >= runs) break;
			// Wait for the event the missing run shows up as; the checks at the top of the
			// loop then decide whether the step has another round left.
			await this.waitForEvent(this.events.length, deadline);
		}
		this.stepRuns += started;
		if (started === runs) return;
		if (started > runs) throw new Error(`${action} started ${started} run(s), expected ${runs}`);
		throw new Error(
			`${action} started ${started} run(s), expected ${runs}; ` +
			`the ${STEP_BUDGET_MS} ms step budget expired after ${rounds} barrier round(s)`,
		);
	}

	/** Claim a barrier phase; `testTimeoutFor` covers REAL_HOST_MAX_BARRIERS_PER_TEST of them. */
	private startBarrierPhase(): void {
		const phase = ++this.barrierPhases;
		if (phase > REAL_HOST_MAX_BARRIERS_PER_TEST) {
			throw new Error(
				`Barrier phase ${phase} exceeds REAL_HOST_MAX_BARRIERS_PER_TEST (${REAL_HOST_MAX_BARRIERS_PER_TEST}), ` +
				"which sizes REAL_HOST_TEST_TIMEOUT_MS; raise it for this test",
			);
		}
	}

	/**
	 * Resolve on the next event the harness observes past index `seen`, or at `deadline`. The check
	 * before the subscription is what makes the wake-up complete: an event that arrived while the
	 * caller was counting resolves at once. Nothing else wakes the wait, so a barrier round that
	 * found nothing outstanding never spins.
	 */
	private async waitForEvent(seen: number, deadline: number): Promise<void> {
		if (this.events.length > seen) return;
		const { client, events } = this;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				unsubscribe();
				resolve();
			}, Math.max(deadline - Date.now(), 0));
			const unsubscribe = client.onEvent(() => {
				if (events.length <= seen) return;
				clearTimeout(timer);
				unsubscribe();
				resolve();
			});
		});
	}

	/** Run `/e2e-barrier <id> <probeDeadlineMs>` and wait for its report; throws with the probe's outstanding items when it failed. */
	private async barrier(probeDeadlineMs: number): Promise<void> {
		const id = ++this.barrierRounds;
		const client = this.client;
		const events = this.events;
		const mark = events.length;
		const findReport = (): BarrierReport | undefined => {
			for (const event of events.slice(mark)) {
				if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== PROBE_BARRIER_STATUS_KEY) continue;
				const report = parseBarrierReport(requireString(event, "statusText"));
				if (report.id === id) return report;
			}
			return undefined;
		};
		await this.command(`/${PROBE_COMMAND.barrier} ${id} ${probeDeadlineMs}`);
		const waitMs = probeDeadlineMs + BARRIER_REPORT_MARGIN_MS;
		const report = findReport() ?? await new Promise<BarrierReport>((resolveWait, rejectWait) => {
			const timer = setTimeout(() => {
				unsubscribe();
				rejectWait(new Error(`Timed out after ${waitMs} ms waiting for barrier ${id} to report. Stderr: ${client.getStderr()}`));
			}, waitMs);
			const unsubscribe = client.onEvent(() => {
				let found: BarrierReport | undefined;
				try {
					found = findReport();
				} catch (error) {
					clearTimeout(timer);
					unsubscribe();
					rejectWait(error);
					return;
				}
				if (!found) return;
				clearTimeout(timer);
				unsubscribe();
				resolveWait(found);
			});
		});
		if (report.failure !== null) throw new Error(`Barrier ${id} failed: ${report.failure}`);
	}
}

async function startClient(options: RpcClientOptions): Promise<{ client: RpcClient; events: RpcEvent[] }> {
	const client = new RpcClient(options);
	const events: RpcEvent[] = [];
	client.onEvent((event) => {
		events.push(event as unknown as RpcEvent);
	});
	await cleanupOnFailure(async () => {
		await client.start();
		const commands = await client.getCommands();
		const names = new Set(commands.filter((command) => command.source === "extension").map((command) => command.name));
		const missing = REQUIRED_COMMANDS.filter((name) => !names.has(name));
		if (missing.length > 0) {
			throw new Error(`pi started without extension commands ${missing.join(", ")}. Stderr: ${client.getStderr()}`);
		}
	}, () => client.stop());
	return { client, events };
}

function removeRoot(root: string): void {
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function startRealHost(options?: RealHostOptions): Promise<RealHost> {
	return RealHost.start(options);
}

/**
 * Start a host and run `run` against it, then close it. The close also hangs off an after-hook
 * on `t`: node:test does not cancel a timed-out test body, so only a hook still runs then.
 * `close()` runs once however many of these paths reach it. The inline close keeps a cleanup
 * error visible next to a body failure; node:test ignores an after-hook error once the test
 * has failed (timeout included), so the hook also records it as a diagnostic.
 */
export async function withRealHost(t: TestContext, run: (host: RealHost) => Promise<void>, options?: RealHostOptions): Promise<void> {
	const host = await startRealHost(options);
	t.after(() => host.close().catch((error: unknown) => {
		t.diagnostic(`cleanup failed: ${describeError(error)}`);
		throw error;
	}));
	await withCleanup(() => run(host), () => host.close());
}
