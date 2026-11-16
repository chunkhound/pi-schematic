import { expect, onTestFinished, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ContextUsage } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { spawnPager } from "../../notebook/pager.js";
import { createModelRegistry } from "../support/model-registry.js";
import { runRealChildInvocation } from "../support/real-child.js";
import { ESCAPE, listDriver, press, writePage } from "../support/notebook.js";
import { createRunner, type CustomComponentDriver, type RunnerFixture } from "../support/runner.js";
import { appendDrafts } from "../support/session.js";
import { realTheme } from "../support/theme.js";

const ELIGIBLE_USAGE: ContextUsage = { tokens: 50_000, percent: 25, contextWindow: 200_000 };
// Below the integration project's 60 000 ms test timeout, so a stuck pager ends before the test does.
const PAGER_DEADLINE_MS = 20_000;

interface PagerScript {
	/** The path `PI_PAGER` names. */
	path: string;
	/** True once the pager has read its whole body. */
	started(): boolean;
	/** The body the pager read; throws when it never ran. */
	body(): Promise<string>;
	/** Lets a pager created with `hold` exit. */
	release(): Promise<void>;
}

/** `path` in double quotes, written as a user puts a path with spaces or quotes into `PI_PAGER`. */
function quotedForPager(path: string): string {
	return `"${path.replace(/["\\$`]/g, "\\$&")}"`;
}

/**
 * An executable pager script in a fresh temp directory, set as `PI_PAGER`. It records the body it
 * reads from stdin, marks that it started, and with `hold` waits for `release()`, the removal of its
 * directory or the pager deadline before it exits.
 */
async function pagerScript(options: { hold?: boolean; name?: string } = {}): Promise<PagerScript> {
	const dir = await mkdtemp(join(tmpdir(), "pi-schematic-pager-"));
	const path = join(dir, options.name ?? "pager.sh");
	const releaseFile = join(dir, "release");
	const polls = PAGER_DEADLINE_MS / 50;
	await writeFile(
		path,
		[
			"#!/bin/sh",
			'dir=$(dirname "$0")',
			'cat > "$dir/body"',
			': > "$dir/started"',
			"i=0",
			`while [ -d "$dir" ] && [ ! -e "$dir/release" ] && [ "$i" -lt ${String(polls)} ]; do sleep 0.05; i=$((i + 1)); done`,
			"",
		].join("\n"),
	);
	await chmod(path, 0o755);
	if (options.hold !== true) {
		await writeFile(releaseFile, "");
	}
	onTestFinished(async () => {
		await writeFile(releaseFile, "");
		await rm(dir, { recursive: true, force: true });
	});
	vi.stubEnv("PI_PAGER", quotedForPager(path));
	return {
		path,
		started: () => existsSync(join(dir, "started")),
		body: () => readFile(join(dir, "body"), "utf8"),
		release: () => writeFile(releaseFile, ""),
	};
}

/** The shipped extension with the recording UI, `custom` as the /notebook driver and `tui` as the pager's TUI. */
async function shippedHost(custom: CustomComponentDriver, tui: Partial<Pick<TUI, "stop" | "start">>, session = SessionManager.inMemory(process.cwd())) {
	return createRunner({
		cwd: process.cwd(),
		mode: "tui",
		sessionManager: session,
		modelRegistry: await createModelRegistry({}),
		ui: { theme: realTheme, custom, tui },
		context: {
			getContextUsage: () => ELIGIBLE_USAGE,
			isProjectTrusted: () => false,
			isIdle: () => true,
			getSignal: () => undefined,
			abort: () => undefined,
		},
		activeTools: [],
	});
}

async function runNotebook(fixture: RunnerFixture): Promise<void> {
	await fixture.command("notebook").handler("", fixture.runner.createCommandContext());
}

/**
 * Starts /notebook without awaiting it. When the test body fails before it awaits the handler, the
 * handler keeps running with its SIGINT guard installed; this releases the pager and waits for the
 * handler to settle before the next test starts. Callbacks run in reverse registration order, so
 * this one runs before `pagerScript` removes the pager's directory.
 */
function startNotebook(fixture: RunnerFixture, pager: PagerScript): Promise<void> {
	const handler = runNotebook(fixture);
	const settled = handler.then(
		() => undefined,
		// The test body reports the handler's failure; this only waits for it.
		() => undefined,
	);
	onTestFinished(async () => {
		await pager.release();
		await settled;
	});
	return handler;
}

/** The child processes this process holds a handle to: Node keeps one from spawn until the child has exited. */
function childProcessHandles(): number {
	return process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length;
}

// ── spawnPager tests ──────────────────────────────────────────────────

// Skipped on Windows: with shell: true a missing binary shows up only as a cmd.exe exit code.
test.skipIf(process.platform === "win32")(
	"spawnPager rejects with a readable error when the pager binary is missing",
	{ timeout: PAGER_DEADLINE_MS },
	async () => {
		await expect(spawnPager("body", { cmd: "pi-schematic-definitely-missing-xyz", args: [] })).rejects.toThrow(/pi-schematic-definitely-missing-xyz not found/);
	},
);

test("spawnPager pipes the full body to the child's stdin", { timeout: PAGER_DEADLINE_MS }, async () => {
	const tmpDir = await mkdtemp(join(tmpdir(), "pager-stdin-test-"));
	const scriptPath = join(tmpDir, "pager.cjs");
	const outPath = join(tmpDir, "out.txt");
	// Removed after the test rather than in a finally, so a test that times out on a pager that never exits still removes it.
	onTestFinished(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});
	// Writes only to a file — produces no stdout, so the child's
	// inherited stdout doesn't pollute the test runner's own output.
	// A script file, not `-e`: shell: true on Windows joins args unquoted,
	// which would split a multi-word -e script apart.
	const script = [
		'const fs = require("node:fs");',
		"const chunks = [];",
		'process.stdin.on("data", (c) => chunks.push(c));',
		'process.stdin.on("end", () => { fs.writeFileSync(process.argv[2], Buffer.concat(chunks)); });',
	].join("\n");
	await writeFile(scriptPath, script);
	const body = "line one\nline two\n";

	await spawnPager(body, { cmd: process.execPath, args: [scriptPath, outPath] });

	expect(await readFile(outPath, "utf8")).toBe(body);
});

test("spawnPager resolves when the pager exits without reading stdin (EPIPE/EOF is swallowed)", { timeout: PAGER_DEADLINE_MS }, async () => {
	// Several MB comfortably exceeds the OS pipe buffer (64KB on Linux), so
	// the write is still in flight — and hits EPIPE (EOF on Windows) — when
	// the child's immediate exit closes the read end, instead of completing
	// before the child even starts.
	const body = "x".repeat(5 * 1024 * 1024);

	await expect(spawnPager(body, { cmd: process.execPath, args: ["-e", "process.exit(0)"] })).resolves.toBeUndefined();
});

test("spawnPager resolves when the pager exits nonzero", { timeout: PAGER_DEADLINE_MS }, async () => {
	await expect(spawnPager("body", { cmd: process.execPath, args: ["-e", "process.exit(1)"] })).resolves.toBeUndefined();
});

// ── /notebook with a real pager ───────────────────────────────────────
// The pager is a shell script, so these tests do not run on Windows.

test.skipIf(process.platform === "win32")("/notebook enter suspends the TUI, awaits the pager, then restores the TUI and reopens the list", async () => {
	const pager = await pagerScript({ hold: true });
	const events: string[] = [];
	const renderRequests: { atStart?: number; atReopen?: number } = {};
	const fixtureRef: { current?: RunnerFixture } = {};
	const renderCount = () => fixtureRef.current?.ui.renderRequests.length ?? -1;
	// Move off the default index 0 so the reopen assertion proves cursor restore.
	const list = listDriver(
		(component) => {
			press(component, "\x1b[B", "\r");
		},
		(component) => {
			renderRequests.atReopen = renderCount();
			press(component, ESCAPE);
		},
	);
	const fixture = await shippedHost(list.driver, {
		stop: () => {
			events.push("stop");
		},
		start: () => {
			events.push("start");
			renderRequests.atStart = renderCount();
		},
	});
	fixtureRef.current = fixture;
	await writePage(fixture, "zeta", "old body");
	await writePage(fixture, "alpha", "other");

	const handler = startNotebook(fixture, pager);
	// Wait until the pager is running before letting it exit.
	await vi.waitFor(
		() => {
			expect(pager.started()).toBe(true);
		},
		{ timeout: PAGER_DEADLINE_MS, interval: 20 },
	);
	expect({ events: [...events], body: await pager.body() }, "TUI must be stopped before spawn and stay stopped while the pager runs").toStrictEqual({
		events: ["stop"],
		body: "old body",
	});
	await pager.release();
	await handler;

	expect({
		events,
		redrawsAfterStart: fixture.ui.renderRequests.slice(renderRequests.atStart, renderRequests.atReopen),
		opened: list.opened,
	}).toStrictEqual({ events: ["stop", "start"], redrawsAfterStart: [true], opened: 2 });
	expect(list.renders[1], "the reopened list keeps zeta selected").toMatch(/→ zeta /);
});

test.skipIf(process.platform === "win32")("/notebook opens a pager whose path contains a space", async () => {
	const pager = await pagerScript({ name: "my pager.sh" });
	const list = listDriver((component) => {
		press(component, "\r");
	});
	const fixture = await shippedHost(list.driver, { stop: vi.fn(), start: vi.fn() });
	await writePage(fixture, "alpha", "page body");

	await runNotebook(fixture);

	expect({ body: await pager.body(), notifications: fixture.ui.notifications }).toStrictEqual({ body: "page body", notifications: [] });
});

test.skipIf(process.platform === "win32")("/notebook pager interaction installs and removes a SIGINT guard", async () => {
	const pager = await pagerScript({ hold: true });
	const baselineSigint = process.listeners("SIGINT").length;
	const list = listDriver((component) => {
		press(component, "\r");
	});
	const fixture = await shippedHost(list.driver, { stop: vi.fn(), start: vi.fn() });
	await writePage(fixture, "alpha", "body");

	const handler = startNotebook(fixture, pager);
	await vi.waitFor(
		() => {
			expect(pager.started()).toBe(true);
		},
		{ timeout: PAGER_DEADLINE_MS, interval: 20 },
	);
	const duringPagerListenerCount = process.listeners("SIGINT").length;
	await pager.release();
	await handler;

	expect(duringPagerListenerCount, "SIGINT guard must be installed during pager").toBe(baselineSigint + 1);
	expect(process.listeners("SIGINT"), "SIGINT guard must be removed after pager").toHaveLength(baselineSigint);
});

test.skipIf(process.platform === "win32")("openInPager removes the SIGINT guard even if tui.start throws", async () => {
	await pagerScript();
	const baselineSigint = process.listeners("SIGINT").length;
	const list = listDriver((component) => {
		press(component, "\r");
	});
	const fixture = await shippedHost(list.driver, {
		stop: vi.fn(),
		start: () => {
			throw new Error("start boom");
		},
	});
	await writePage(fixture, "alpha", "body");

	await expect(runNotebook(fixture)).rejects.toThrow(/start boom/);
	expect(process.listeners("SIGINT"), "SIGINT guard must not leak when tui.start throws").toHaveLength(baselineSigint);
});

test.skipIf(process.platform === "win32")("openInPager propagates a tui.stop failure without spawning, guarding SIGINT, or restarting", async () => {
	// Held, so a pager spawned by mistake and not awaited is still running when the command has
	// settled; one that was awaited has left its started marker.
	const pager = await pagerScript({ hold: true });
	const baselineSigint = process.listeners("SIGINT").length;
	const start = vi.fn();
	const list = listDriver((component) => {
		press(component, "\r");
	});
	const fixture = await shippedHost(list.driver, {
		stop: () => {
			throw new Error("stop boom");
		},
		start,
	});
	await writePage(fixture, "alpha", "body");

	await expect(runNotebook(fixture)).rejects.toThrow(/stop boom/);
	// Every earlier test in this file waits for its children to exit, so any live child is a pager spawned by mistake.
	expect({ liveChildren: childProcessHandles(), started: pager.started() }, "pager must not spawn when tui.stop throws").toStrictEqual({
		liveChildren: 0,
		started: false,
	});
	expect(process.listeners("SIGINT"), "SIGINT guard must not leak when tui.stop throws").toHaveLength(baselineSigint);
	expect(start, "TUI must not restart after a failed stop").not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")("/notebook surfaces pager spawn errors as a warning notification", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-schematic-pager-"));
	onTestFinished(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const missing = join(dir, "missing-pager");
	vi.stubEnv("PI_PAGER", quotedForPager(missing));
	const list = listDriver((component) => {
		press(component, "\r");
	});
	const fixture = await shippedHost(list.driver, { stop: vi.fn(), start: vi.fn() });
	await writePage(fixture, "alpha", "body");

	await runNotebook(fixture);

	expect(fixture.ui.notifications).toStrictEqual([{ message: `pager failed: ${missing} not found`, type: "warning" }]);
});

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-2", name: "handoff", arguments: {} }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

test.skipIf(process.platform === "win32")("/notebook reopens the list when the selected page vanished while it was open", async () => {
	const pager = await pagerScript();
	const session = SessionManager.inMemory(process.cwd());
	const fixtureRef: { current?: RunnerFixture } = {};
	// turn_start applies the discard after the list was built with alpha and before Enter selects it.
	const list = listDriver(async (component) => {
		await fixtureRef.current?.runner.emit({ type: "turn_start", turnIndex: 1, timestamp: 0 });
		press(component, "\r");
	});
	const fixture = await shippedHost(list.driver, { stop: vi.fn(), start: vi.fn() }, session);
	fixtureRef.current = fixture;
	await writePage(fixture, "alpha", "body");
	await fixture.tool("handoff").execute("call-2", { nextInstruction: "continue", discardPages: ["alpha"] });
	const boundary = await fixture.runner.emitBoundary(
		{
			type: "turn_end",
			turnIndex: 0,
			message: assistantMessage(),
			toolResults: [
				{ role: "toolResult", toolCallId: "call-2", toolName: "handoff", content: [{ type: "text", text: "Handoff staged." }], isError: false, timestamp: 0 },
			],
			messageEntryId: "assistant-entry",
			toolResultEntryIds: [],
			outcome: "completed",
		},
		() => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true }),
	);
	appendDrafts(session, boundary.entries);

	await runNotebook(fixture);

	expect(list.opened, "list must reopen instead of closing").toBe(2);
	expect(list.renders[1]).toMatch(/Notebook \(0 pages\)/);
	expect(pager.started(), "a vanished page must not open the pager").toBe(false);
});

// ── Spawned child prompt ──────────────────────────────────────────────

test("a spawned child's prompt carries no notebook clipping decorations", async () => {
	const proof = await runRealChildInvocation({ prompt: "Do the task.", notebookPages: { page: Array(2001).fill("x").join("\n") } });

	expect(proof.observedMessages.join("\n")).toContain("Available notebook pages:\n  page: x\n");
	expect(proof.observedMessages.filter((message) => /\[truncated\]|Notice:/.test(message))).toStrictEqual([]);
});
