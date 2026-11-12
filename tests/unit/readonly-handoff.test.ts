import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createState } from "../../state.js";
import { canPromoteBoundary, discardNonHumanBoundary } from "../../readonly-boundary.js";
import { setActiveNotebookTopic } from "../../notebook/topic.js";
import { callHandlers, emitAll, handoffToolResult, makeReadonlyUICtx, registerReadonlyPI, turnEndEvent, type ToolCall } from "./helpers.js";
import type { TestPI } from "./test-host.js";
import { assertPresent, expectPrefix } from "../assertions.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";
import { buildContinuationFrame } from "../../handoff/format.js";
import { HANDOFF_FAILED_IN_RUN_REFUSAL, HANDOFF_NOT_ALONE_REFUSAL } from "../../handoff/copy.js";
import { READONLY_POWERSHELL_BLOCK_REASON, READONLY_WRITE_EDIT_BLOCK_REASON } from "../../notifications.js";

async function createHandoffPI() {
	const { pi, toolCall } = await registerReadonlyPI();
	const agentSettled = (ctx: unknown) => emitAll(pi, "agent_settled", { type: "agent_settled" }, ctx);
	const [sessionTree] = pi.handlers.get("session_tree")!;
	const sessionStart = (event: unknown, ctx: unknown) => emitAll(pi, "session_start", event, ctx);
	return { pi, toolCall, agentSettled, sessionTree, sessionStart };
}

function makeReadonlyResumeCtx(branch: unknown[]) {
	return {
		hasUI: false,
		getContextUsage: () => null,
		sessionManager: {
			getBranch: () => branch,
		},
	};
}

/** Dispatch a tool call as pi does: run the composed tool_call handlers and execute the tool only when none blocks. Returns the block or the tool's result. */
async function dispatchTool(
	pi: TestPI,
	toolCall: ToolCall,
	event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
	ctx: Record<string, unknown>,
): Promise<any> {
	const blocked = await toolCall(event, ctx);
	if (blocked?.block) return blocked;
	return pi.tools.get(event.toolName).execute(event.toolCallId, event.input, undefined, undefined, ctx);
}

const ELIGIBLE_USAGE = { tokens: 50000, percent: 25, contextWindow: 200000 };

/** Execute the handoff tool with an eligible context, leaving the handoff staged. */
async function stageHandoff(pi: TestPI, toolCallId: string, params: Record<string, unknown>): Promise<void> {
	await pi.tools.get("handoff").execute(toolCallId, params, undefined, undefined, {
		hasUI: false,
		getContextUsage: () => ELIGIBLE_USAGE,
	});
}

/** End the staging turn and return the entries the boundary handler asked pi to commit. */
async function endStagingTurn(pi: TestPI, toolCallId: string): Promise<any[]> {
	const results = await callHandlers(
		pi,
		"turn_end",
		turnEndEvent({ toolResults: [handoffToolResult(toolCallId)] }),
		{ hasUI: false, signal: { aborted: false }, getContextUsage: () => null },
	);
	const boundary = results.find((result: any) => result?.entries) as { entries: any[]; continue: boolean } | undefined;
	assertPresent(boundary, "the staging turn_end must return boundary entries");
	expect(boundary.continue).toBe(true);
	return boundary.entries;
}

/** The branch pi would hold after committing `drafts` as session entries. */
function committedBranch(drafts: any[]): any[] {
	return drafts.map((draft, index) => ({ ...draft, id: `entry-${index}`, parentId: index === 0 ? null : `entry-${index - 1}`, timestamp: "2026-01-01T00:00:00.000Z" }));
}

async function turnStartWith(pi: TestPI, branch: any[]): Promise<void> {
	await emitAll(pi, "turn_start", { type: "turn_start" }, { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => branch } });
}

/** Stage → turn_end → turn_start with the committed cut on the branch. Returns the committed drafts. */
async function completeHandoffCut(pi: TestPI, toolCallId: string, params: Record<string, unknown>): Promise<any[]> {
	await stageHandoff(pi, toolCallId, params);
	const drafts = await endStagingTurn(pi, toolCallId);
	await turnStartWith(pi, committedBranch(drafts));
	return drafts;
}

/**
 * Drive a real handoff through the boundary cut, optionally flipping readonly
 * between the tool call and the cut, then read the next model turn's readonly nudge.
 */
async function handoffCutAcrossReadonlyToggle(readonlyAfterCut: boolean) {
	const { pi } = await createHandoffPI();
	const [contextHandler] = pi.handlers.get("context")!;
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	// Consume the toggle-on nudge so any later nudge can only come from the handoff.
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);
	await pi.commands.get("handoff").handler("continue work", { ...makeReadonlyUICtx(), isIdle: () => true } as any);
	await stageHandoff(pi, "handoff-1", { nextInstruction: "ignored in favor of the direction" });
	if (!readonlyAfterCut) {
		await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
		// Consume the pre-cut toggle nudge so the probe below sees only the fresh
		// handoff-side announcement of the final live state.
		await contextHandler({ messages: [{ role: "user", content: "toggle", timestamp: 2 }] }, { getContextUsage: () => null } as any);
	}
	const drafts = await endStagingTurn(pi, "handoff-1");
	await turnStartWith(pi, committedBranch(drafts));
	const next = await contextHandler(
		{ messages: [{ role: "user", content: "post-handoff", timestamp: 3 }] },
		{ getContextUsage: () => null } as any,
	);
	const nudge = (next?.messages ?? []).filter((message: any) => message.customType === "pi-schematic-readonly-nudge").at(-1);
	const compaction = drafts.find((draft) => draft.type === "compaction");
	return { summary: compaction.summary as string, nudgeContent: nudge?.content as string | undefined };
}

async function assertNonTempBashBlocked(toolCall: (event: any, ctx: any) => Promise<any>): Promise<void> {
	const target = path.join(os.homedir(), `readonly-handoff-test-${process.pid}-${Date.now()}`);
	const command = `touch "${target}"`;
	await rm(target, { force: true });
	try {
		const event = { toolName: "bash", input: { command } };
		const result = await toolCall(event, { cwd: process.cwd() });
		if (!result?.block) {
			try {
				execFileSync("bash", ["-lc", event.input.command], { cwd: process.cwd(), stdio: "ignore" });
			} catch {
				// A sandbox may reject the command with a non-zero exit status.
			}
		}
		expect(result?.block, "non-temp bash mutations must be blocked before execution").toBe(true);
		await expect(access(target)).rejects.toThrow(/ENOENT/);
	} finally {
		await rm(target, { force: true });
	}
}

async function handoffAllowedAtUsage(usage: { tokens?: number | null; percent?: number | null; contextWindow?: number | null }): Promise<boolean> {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);
	await contextHandler({ messages: [{ role: "user", content: "continue", timestamp: 2 }] }, { getContextUsage: () => usage } as any);
	return (await toolCall({ toolName: "handoff", input: { nextInstruction: "continue billing" } }, {})) === undefined;
}

test("/handoff command creates temporary bypass for handoff tool only", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	expect(await toolCall({ toolName: "handoff", input: { nextInstruction: "continue readonly work" } }, {}), "handoff should be unblocked after explicit /handoff").toBeUndefined();
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, "write should stay blocked").toBe(true);
	const powershell = await toolCall({ toolName: "powershell", input: { command: "Get-ChildItem" } }, {});
	expect(powershell.block, "powershell should stay blocked").toBe(true);
	expect(powershell.reason).toBe(READONLY_POWERSHELL_BLOCK_REASON);
	await assertNonTempBashBlocked(toolCall);
});

test("readonly blocks a non-requested handoff", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const ctx = {
		...makeReadonlyUICtx(),
		cwd: process.cwd(),
		getContextUsage: () => ({ tokens: 50_000, percent: 80, contextWindow: 64_000 }),
	};
	const input = { nextInstruction: "must remain in current context" };
	const blocked = await dispatchTool(pi, toolCall, { toolName: "handoff", toolCallId: "blocked-1", input }, ctx);
	expect(blocked?.block).toBe(true);

	const results = await callHandlers(
		pi,
		"turn_end",
		turnEndEvent({ toolResults: [handoffToolResult("blocked-1")] }),
		{ hasUI: false, signal: { aborted: false }, getContextUsage: () => null },
	);
	expect(results.filter((result: any) => result?.entries), "a blocked handoff leaves no boundary to write").toStrictEqual([]);
});

test("a write sharing a message with handoff keeps its readonly block while the handoff is refused", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);
	await callHandlers(pi, "message_end", {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-handoff", name: "handoff", arguments: {} },
				{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "/tmp/test", content: "x" } },
			],
		},
	}, {});

	const sibling = await toolCall({ toolName: "write", toolCallId: "call-write", input: { path: "/tmp/test", content: "x" } }, {});
	expect(sibling).toStrictEqual({ block: true, reason: READONLY_WRITE_EDIT_BLOCK_REASON });
	const handoff = await dispatchTool(
		pi,
		toolCall,
		{ toolName: "handoff", toolCallId: "call-handoff", input: { nextInstruction: "continue readonly work" } },
		{ hasUI: false, getContextUsage: () => ELIGIBLE_USAGE },
	);
	expect(handoff).toStrictEqual({ block: true, reason: HANDOFF_NOT_ALONE_REFUSAL, terminate: true });

	const results = await callHandlers(
		pi,
		"turn_end",
		turnEndEvent({ toolResults: [handoffToolResult("call-handoff")] }),
		{ hasUI: false, signal: { aborted: false }, getContextUsage: () => null },
	);
	expect(results.filter((result: any) => result?.entries), "a refused handoff stages nothing").toStrictEqual([]);
});

test("watchdog cancellation clears the readonly handoff bypass", async () => {
	const { pi, toolCall, agentSettled } = await createHandoffPI();
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "handoff pending"]]);
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			notify: () => {},
		},
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
	};
	const [contextHook] = pi.handlers.get("context")!;
	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS; i++) {
		await contextHook({ messages: [{ role: "user", content: "work", timestamp: i }] }, ctx as any);
		await agentSettled(ctx);
	}

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
	expect((await toolCall({ toolName: "handoff", input: {} }, {})).block, "readonly handoff should be blocked after watchdog cancellation").toBe(true);
});

test("after the handoff cut, bypass is cleared and readonly persists", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	await completeHandoffCut(pi, "handoff-1", { nextInstruction: "Continue readonly work" });

	expect((await toolCall({ toolName: "handoff", input: { nextInstruction: "direct call" } }, {})).block, "bypass cleared: direct handoff should be blocked").toBe(true);
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, "readonly persists: write should still be blocked after the cut").toBe(true);
});

test("the readonly bypass stays until the cut is confirmed on the branch", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	await stageHandoff(pi, "handoff-1", { nextInstruction: "Continue readonly work" });
	await endStagingTurn(pi, "handoff-1");

	expect(await toolCall({ toolName: "handoff", input: {} }, {}), "a submitted boundary is not a confirmed cut: the bypass must stay").toBeUndefined();
});

test("synchronous handoff rejection preserves the readonly bypass contract", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	await expect(
		pi.tools.get("handoff").execute(
			"handoff-1",
			{ nextInstruction: "Continue readonly work" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { setStatus: () => {} },
				getContextUsage: () => null,
			},
		),
	).rejects.toThrow(/Context usage unavailable/);

	expect(await toolCall({ toolName: "handoff", input: { nextInstruction: "retry readonly handoff" } }, {}), "readonly bypass should remain active after synchronous rejection").toBeUndefined();
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, "write should stay blocked while the bypass remains active").toBe(true);
});

test("retry succeeds after a handoff cut that pi did not persist", async () => {
	const { pi, toolCall, agentSettled } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	await stageHandoff(pi, "handoff-1", { nextInstruction: "Continue readonly work" });
	await endStagingTurn(pi, "handoff-1");
	const userMessagesBefore = pi.sentUserMessages.length;
	await turnStartWith(pi, []);

	expect(pi.sentUserMessages, "the failed cut must send no user message").toHaveLength(userMessagesBefore);
	expect(pi.sentMessages.at(-1)?.message.customType, "the failed cut must persist the failure guidance").toBe("pi-schematic-handoff-failed");
	expect(pi.sentMessages.at(-1)?.options?.triggerTurn, "the failure guidance must not start a run").toBe(false);

	const sameRun = await toolCall({ toolName: "handoff", input: { nextInstruction: "retry handoff" } }, {});
	expect(sameRun?.block, "a handoff in the run that lost its cut must be blocked").toBe(true);
	expect(sameRun?.reason, "the block must be the boundary's failed-in-run refusal").toBe(HANDOFF_FAILED_IN_RUN_REFUSAL);

	// readonly bypass still active
	await agentSettled({ hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => [] } });
	expect(await toolCall({ toolName: "handoff", input: { nextInstruction: "retry handoff" } }, {}), "the readonly bypass must remain for the retry in the next run").toBeUndefined();

	await expect(
		stageHandoff(pi, "handoff-retry", { nextInstruction: "retry handoff" }),
		"retry handoff should stage after the failed cut",
	).resolves.toBeUndefined();

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, "readonly persists: write should still be blocked after the failed cut").toBe(true);
});

test("an aborted handoff keeps the bypass and persists the failure without starting a run", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	await stageHandoff(pi, "handoff-1", { nextInstruction: "Continue readonly work" });
	const results = await callHandlers(
		pi,
		"turn_end",
		turnEndEvent({ toolResults: [handoffToolResult("handoff-1")] }),
		{ hasUI: false, signal: { aborted: true }, getContextUsage: () => null },
	);
	expect(results.filter((result: any) => result?.entries)).toStrictEqual([]);
	const userMessagesBefore = pi.sentUserMessages.length;
	await emitAll(pi, "agent_settled", { type: "agent_settled" }, { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => [] } });

	expect(pi.sentMessages.at(-1)?.message.customType).toBe("pi-schematic-handoff-failed");
	expect(pi.sentMessages.at(-1)?.options?.triggerTurn).toBe(false);
	expect(pi.sentUserMessages, "an abort must not start another run").toHaveLength(userMessagesBefore);
	expect(await toolCall({ toolName: "handoff", input: {} }, {}), "the readonly bypass must remain for the retry").toBeUndefined();
});

test("/handoff re-enables bypass after the cut", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);

	await pi.commands.get("handoff").handler("first handoff", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);
	await completeHandoffCut(pi, "handoff-1", { nextInstruction: "first handoff" });

	await pi.commands.get("handoff").handler("second readonly handoff", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);
	expect(await toolCall({ toolName: "handoff", input: { nextInstruction: "second readonly handoff" } }, {}), "second /handoff should re-enable the bypass").toBeUndefined();
});

test("the handoff summary stays readonly-free and the fresh context relearns readonly live", async () => {
	// Readonly still active at the cut: the fresh context is told again, from live state.
	const resumed = await handoffCutAcrossReadonlyToggle(true);
	expect(resumed.summary).toBe(buildContinuationFrame());
	expect(resumed.summary, "constraints must never be frozen into the summary").not.toMatch(/readonly/i);
	expect(resumed.summary, "the model-supplied instruction must not leak into the summary").not.toMatch(/ignored in favor of the direction/);
	expect(resumed.nudgeContent ?? "", "the post-handoff turn must relearn readonly from the context hook").toMatch(/\[readonly\] enabled — write\/edit\/powershell blocked/);

	// Readonly dropped before the cut: same constant summary, and the fresh context
	// stays silent — OFF-at-cut needs no announcement, while toggles and tree
	// navigation re-announce via rehydration.
	const dropped = await handoffCutAcrossReadonlyToggle(false);
	expect(dropped.summary).toBe(buildContinuationFrame());
	expect(dropped.summary).not.toMatch(/readonly/i);
	expect(dropped.nudgeContent, "an OFF-at-cut handoff stays silent; ON-to-OFF across start/tree is covered by rehydration").toBeUndefined();
});

test("readonly topic boundary derives eligibility from percentage when tokens are unavailable", async () => {
	expect(await handoffAllowedAtUsage({ tokens: null, percent: 15, contextWindow: 200000 }), "15% of a 200K context meets the minimum token threshold").toBe(true);
	expect(await handoffAllowedAtUsage({ tokens: null, percent: 14.999, contextWindow: 200000 }), "just below the minimum token threshold must remain blocked").toBe(false);
});

test("readonly topic boundary creates the same bypass contract as explicit /handoff", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);

	// Drain the initial readonly nudge
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);

	// Set initial topic, then change it to create a boundary hint
	await pi.commands.get("notebook").handler(
		"oauth",
		{ hasUI: false, getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler(
		"billing",
		{ hasUI: false, getContextUsage: () => null } as any,
	);

	// Context hook should create the bypass from the boundary hint
	await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) },
	);

	// Same observable contract as explicit /handoff: handoff tool is unblocked
	expect(await toolCall({ toolName: "handoff", input: { nextInstruction: "continue billing work" } }, {}), "handoff should be unblocked after topic boundary creates bypass").toBeUndefined();
	// write and non-temp bash mutations stay blocked
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, "write should stay blocked").toBe(true);
	await assertNonTempBashBlocked(toolCall);
});

test("promoted readonly boundary preserves bypass across execute-time eligibility failures", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);
	await contextHandler(
		{ messages: [{ role: "user", content: "promote", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) } as any,
	);

	for (const { usage, message } of [
		{ usage: () => null, message: /Context usage unavailable/ },
		{ usage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }), message: /handoff unavailable yet/ },
	]) {
		await expect(
			pi.tools.get("handoff").execute("boundary-retry", { nextInstruction: "continue billing" }, undefined, undefined, {
				getContextUsage: usage,
			}),
		).rejects.toThrow(message);
		expect(await toolCall({ toolName: "handoff", input: {} }, {}), "execute-time rejection must preserve the promoted readonly bypass").toBeUndefined();
	}

	await completeHandoffCut(pi, "boundary-success", { nextInstruction: "continue billing" });
	expect((await toolCall({ toolName: "handoff", input: {} }, {})).block).toBe(true);
});

test("readonly topic boundary promotion exposes the handoff status", async () => {
	const { pi } = await createHandoffPI();
	const statuses = new Map<string, string | undefined>();
	const notifications: string[] = [];
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	await contextHandler(
		{ messages: [{ role: "user", content: "continue", timestamp: 2 }] },
		{
			hasUI: true,
			ui: {
				theme: { fg: (_name: string, text: string) => text },
				setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
				notify: (message: string) => { notifications.push(message); },
			},
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		} as any,
	);

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBe("🤝 Handoff required — ready to compact");
	expect(notifications[0] ?? "").toMatch(/handoff exception is now active/i);
});

test("readonly topic boundary stays advisory until handoff is eligible", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	const result = await contextHandler(
		{ messages: [{ role: "user", content: "continue", timestamp: 2 }] },
		{ getContextUsage: () => null } as any,
	);

	expect(result.messages.at(-1)?.content ?? "").toMatch(/topic changed/i);
	expect(result.messages.at(-1)?.content ?? "").not.toMatch(/call handoff/i);
	expect((await toolCall({ toolName: "handoff", input: {} }, {})).block, "ineligible boundary must not unblock handoff").toBe(true);
});

test("readonly human topic boundary promotes exactly at the token threshold without repeated advisory nudges", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	const first = await contextHandler(
		{ messages: [{ role: "user", content: "still small", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 29_999, percent: 15, contextWindow: 200000 }) } as any,
	);
	expect(first.messages.at(-1)?.content ?? "").toMatch(/topic changed/i);
	expect((await toolCall({ toolName: "handoff", input: {} }, {})).block).toBe(true);

	const second = await contextHandler(
		{ messages: [{ role: "user", content: "still ineligible", timestamp: 3 }] },
		{ getContextUsage: () => ({ tokens: 29_999, percent: 15, contextWindow: 200000 }) } as any,
	);
	expect(second, "an ineligible boundary should not repeat its advisory nudge").toBeUndefined();

	await contextHandler(
		{ messages: [{ role: "user", content: "now eligible", timestamp: 4 }] },
		{ getContextUsage: () => ({ tokens: 30_000, percent: 15, contextWindow: 200000 }) } as any,
	);
	expect(await toolCall({ toolName: "handoff", input: {} }, {})).toBeUndefined();
});

test("readonly topic boundary handoff clears its bypass after the cut", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);
	await contextHandler(
		{ messages: [{ role: "user", content: "handoff", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) } as any,
	);

	const drafts = await completeHandoffCut(pi, "boundary-handoff", { nextInstruction: "Continue billing work" });

	const compaction = drafts.find((draft) => draft.type === "compaction");
	const successor = drafts.find((draft) => draft.customType === "pi-schematic-handoff");
	expect(compaction.summary, "readonly must not be frozen into the summary").toBe(buildContinuationFrame());
	const prefix = "## Next instruction\n\nContinue billing work";
	expectPrefix(successor.content, prefix, "the successor turn carries the stored direction verbatim");
	expect((await toolCall({ toolName: "handoff", input: {} }, {})).block).toBe(true);
	expect((await toolCall({ toolName: "write", input: {} }, {})).block).toBe(true);
});

test("readonly agent topic transitions cannot promote or remain queued", () => {
	const state = createState();
	setActiveNotebookTopic(state, "oauth", "agent");
	setActiveNotebookTopic(state, "billing", "agent");

	expect(canPromoteBoundary(state, { tokens: 50_000, percent: 80, contextWindow: 64_000 })).toBe(false);
	expect(discardNonHumanBoundary(state)).toBe(true);
	expect(state.pendingTopicBoundaryHint).toBeNull();
});

test("readonly agent topic boundary is not promoted to handoff bypass", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	// Drain the initial readonly toggle nudge
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);

	// Set the initial topic via notebook_topic_set (agent source). The public
	// tool intentionally rejects agent overrides, so transition behavior is
	// covered by the pure state/helper test above.
	const notebookTopicTool = pi.tools.get("notebook_topic_set");
	await notebookTopicTool.execute("1", { topic: "oauth" }, undefined, undefined, {
		hasUI: false,
		getContextUsage: () => null,
	} as any);

	const result = await contextHandler(
		{ messages: [{ role: "user", content: "continue", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) } as any,
	);

	expect(result).toBeUndefined();
	expect((await toolCall({ toolName: "handoff", input: {} }, {})).block, "agent topic without boundary must not unblock handoff in readonly mode").toBe(true);
});

test("advisoryDelivered flag prevents repeated advisory nudges for ineligible boundary", async () => {
	const { pi, toolCall } = await createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	// Drain the initial readonly toggle nudge
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	// Set human topic boundary
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	// First context hook at ineligible usage — should deliver advisory
	const first = await contextHandler(
		{ messages: [{ role: "user", content: "small", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) } as any,
	);
	assertPresent(first, "first call should return messages");
	expect(first.messages.at(-1)?.content ?? "").toMatch(/topic changed/i);

	// Second context hook at same ineligible usage — should NOT repeat advisory
	const second = await contextHandler(
		{ messages: [{ role: "user", content: "still small", timestamp: 3 }] },
		{ getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) } as any,
	);
	expect(second, "ineligible boundary should not repeat its advisory nudge").toBeUndefined();

	// Handoff should still be blocked
	expect((await toolCall({ toolName: "handoff", input: {} }, {})).block).toBe(true);
});

test("session tree drops a staged handoff, releases the overlap guard, and a stale turn_end writes no cut", async () => {
	const { pi, toolCall, sessionTree } = await createHandoffPI();
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "stale"]]);

	await stageHandoff(pi, "branch-handoff", { nextInstruction: "continue branch work" });
	await sessionTree({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: () => {},
		},
		getContextUsage: () => null,
	} as any);

	expect(statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
	expect(await toolCall({ toolName: "handoff", input: {} }, {}), "non-readonly branch should not retain a stale readonly handoff block").toBeUndefined();

	const staleResults = await callHandlers(
		pi,
		"turn_end",
		turnEndEvent({ toolResults: [handoffToolResult("branch-handoff")] }),
		{ hasUI: false, signal: { aborted: false }, getContextUsage: () => null },
	);
	expect(staleResults.filter((result: any) => result?.entries), "the dropped handoff must not write a cut").toStrictEqual([]);

	const drafts = await completeHandoffCut(pi, "fresh-branch-handoff", { nextInstruction: "continue fresh branch work" });
	expect(pi.sentUserMessages, "the dropped handoff reports no failure and the fresh one completes").toHaveLength(0);
	const successor = drafts.find((draft) => draft.customType === "pi-schematic-handoff");
	expectPrefix(successor.content, "## Next instruction\n\ncontinue fresh branch work", "the fresh branch must receive its own instruction");
});

test("session resume restores readonly enforcement from persisted state", async () => {
	const { toolCall, sessionStart } = await createHandoffPI();
	const branch = [
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: false } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
	];

	await sessionStart({ reason: "resume" }, makeReadonlyResumeCtx(branch) as any);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block).toBe(true);
	expect(await toolCall({ toolName: "read", input: { path: "/tmp/x" } }, {})).toBeUndefined();
});

test("session tree re-announces readonly even when the rehydrated value is unchanged", async () => {
	const { pi, sessionTree } = await createHandoffPI();
	const [contextHandler] = pi.handlers.get("context")!;

	await pi.commands.get("readonly")!.handler("", makeReadonlyUICtx() as any);
	// Drain the toggle nudge so any later nudge can only come from the tree navigation.
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);

	// The branch already says readonly: true, so the rehydrated value is unchanged.
	// The re-announcement must still happen: the handoff summary is readonly-free, so
	// a rebuilt context would otherwise never relearn the live mode.
	await sessionTree({}, {
		hasUI: false,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } }] },
	} as any);

	const result = await contextHandler(
		{ messages: [{ role: "user", content: "probe", timestamp: 2 }] },
		{ getContextUsage: () => null } as any,
	);
	const lastNudge = (result?.messages ?? []).filter((message: any) => message.customType === "pi-schematic-readonly-nudge").at(-1);
	expect(lastNudge?.content ?? "").toMatch(/\[readonly\] enabled/);
});
