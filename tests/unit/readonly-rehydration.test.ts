import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getReadonlyFromBranch } from "../../readonly-rehydration.js";
import { createRunner } from "../support/runner.js";
import { realTheme } from "../support/theme.js";

function makePI(readonlyFlag = false) {
	return { getFlag: () => readonlyFlag };
}

test("getReadonlyFromBranch returns false for empty branch with no CLI flag", () => {
	expect(getReadonlyFromBranch([], makePI(false))).toBe(false);
});

test("getReadonlyFromBranch returns true for empty branch with CLI flag", () => {
	expect(getReadonlyFromBranch([], makePI(true))).toBe(true);
});

/** The branch of an in-memory session holding one `customType` entry per `data` value, in order. */
function branchWith(customType: string, ...data: unknown[]) {
	const session = SessionManager.inMemory(process.cwd());
	for (const entry of data) {
		session.appendCustomEntry(customType, entry);
	}
	return session.getBranch();
}

test("getReadonlyFromBranch uses a persisted readonly entry when present", () => {
	expect(getReadonlyFromBranch(branchWith("pi-schematic-readonly", { enabled: true }), makePI(false))).toBe(true);
	expect(getReadonlyFromBranch(branchWith("pi-schematic-readonly", { enabled: false }), makePI(true))).toBe(false);
});

test.for([
	{ label: "no data", data: undefined },
	{ label: "null data", data: null },
	{ label: "data without enabled", data: {} },
	{ label: "a non-boolean enabled", data: { enabled: "true" } },
])("getReadonlyFromBranch turns readonly off for a persisted entry with $label, even with the CLI flag", ({ data }) => {
	expect(getReadonlyFromBranch(branchWith("pi-schematic-readonly", data), makePI(true))).toBe(false);
});

test("getReadonlyFromBranch picks the latest entry (true wins)", () => {
	const branch = branchWith("pi-schematic-readonly", { enabled: true }, { enabled: false }, { enabled: true });
	expect(getReadonlyFromBranch(branch, makePI(false))).toBe(true);
});

test("getReadonlyFromBranch picks the latest entry (false wins)", () => {
	const branch = branchWith("pi-schematic-readonly", { enabled: true }, { enabled: true }, { enabled: false });
	expect(getReadonlyFromBranch(branch, makePI(false))).toBe(false);
});

test("getReadonlyFromBranch skips entries with wrong customType", () => {
	const branch = branchWith("other-extension", { enabled: true });
	expect(getReadonlyFromBranch(branch, makePI(false))).toBe(false);
});

/** The shipped extension on a runner over `session`, with the recording UI unless `headless`. */
function createReadonlyRunner(session: SessionManager, headless = false) {
	return createRunner({
		cwd: process.cwd(),
		mode: headless ? "print" : "tui",
		sessionManager: session,
		ui: headless ? undefined : { theme: realTheme },
		context: { getContextUsage: () => undefined, isProjectTrusted: () => false },
		activeTools: [],
	});
}

test("session resume restores readonly enforcement from persisted state", async () => {
	const session = SessionManager.inMemory(process.cwd());
	session.appendCustomEntry("pi-schematic-readonly", { enabled: false });
	session.appendCustomEntry("pi-schematic-readonly", { enabled: true });
	const { runner } = await createReadonlyRunner(session, true);

	await runner.emit({ type: "session_start", reason: "resume" });

	expect((await runner.emitToolCall({ type: "tool_call", toolCallId: "write", toolName: "write", input: { path: "/tmp/x", content: "x" } }))?.block).toBe(true);
	expect(await runner.emitToolCall({ type: "tool_call", toolCallId: "read", toolName: "read", input: { path: "/tmp/x" } })).toBeUndefined();
});

test("session tree re-announces readonly even when the rehydrated value is unchanged", async () => {
	const session = SessionManager.inMemory(process.cwd());
	const fixture = await createReadonlyRunner(session);
	const { runner } = fixture;
	await fixture.command("readonly").handler("", runner.createCommandContext());
	// The branch already says readonly: true, so the rehydrated value is unchanged.
	session.appendCustomEntry("pi-schematic-readonly", { enabled: true });
	// Drain the toggle nudge so any later nudge can only come from the tree navigation.
	await runner.emitContext([{ role: "user", content: "drain", timestamp: 1 }]);

	// The re-announcement must still happen: the handoff summary is readonly-free, so
	// a rebuilt context would otherwise never relearn the live mode.
	await runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });

	const result = await runner.emitContext([{ role: "user", content: "probe", timestamp: 2 }]);
	expect(result.at(-1)).toMatchObject({
		role: "custom",
		customType: "pi-schematic-readonly-nudge",
		content:
			"[readonly] enabled — write/edit/powershell blocked; bash writes/deletions outside temp blocked; handoff needs explicit /handoff or an eligible human topic boundary.",
	});
});
