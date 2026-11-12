/**
 * Smoke tests for notifications.ts constants.
 *
 * Verifies the composition chain integrity — a typo in a base constant
 * would cascade to downstream constants. These tests catch that cheaply.
 */

import { expect, test } from "vitest";
import { expectPrefix } from "../assertions.js";
import { applyReadonlyBashGuard, classifyBashCommand } from "../../readonly-bash.js";
import { registerReadonlyPI } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import {
	READONLY_BASH_SCOPE,
	READONLY_NON_TEMP_MUTATION_SCOPE,
	READONLY_EXPLICIT_HANDOFF,
	READONLY_HANDOFF_TRIGGER,
	READONLY_NEXT_CONTEXT_RESUMES,
	READONLY_WRITE_EDIT_BASH,
	READONLY_WRITE_EDIT_BLOCK_REASON,
	READONLY_POWERSHELL_BLOCK_REASON,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_WRITE_EDIT_SUMMARY,
	READONLY_NO_SHELL_SUMMARY,
	READONLY_ACTIVE_SUMMARY,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
	READONLY_ENABLED_STATUS,
	READONLY_COMMAND_DESCRIPTION,
	READONLY_DISABLED_SUMMARY,
	READONLY_DISABLED_NOTIFICATION,
	READONLY_HANDOFF_EXCEPTION_NOTIFICATION,
	READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION,
	READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION,
	READONLY_HANDOFF_RETRY_ADVICE,
	READONLY_CHILD_AUTHORITY_NOTE,
	buildModelGroupNotification,
	buildModelGroupErrorNotification,
	buildModelGroupSetModelErrorNotification,
	buildModelFrontmatterNotification,
	buildModelGroupOverrideWarningNotification,
	buildThinkingFrontmatterNotification,
	buildModelFrontmatterErrorNotification,
	buildModelFrontmatterSetModelErrorNotification,
	buildModelFrontmatterAuthErrorNotification,
	buildStreamingModelSelectionBlockedNotification,
	buildStreamingReadonlyFrontmatterBlockedNotification,
	buildReadonlyBashBlockReason,
	buildReadonlyFrontmatterNotification,
	buildReadonlyPackageManagerBlockReason,
	buildReadonlySandboxPathError,
	buildReadonlyDisabledContextSuffix,
	buildReadonlyTopicBoundaryNotification,
	buildReadonlyRequestedHandoffContinuation,
	buildReadonlyHandoffWaitNotice,
	buildReadonlyHandoffCommandNotice,
} from "../../notifications.js";

const allConstants = {
	READONLY_BASH_SCOPE,
	READONLY_NON_TEMP_MUTATION_SCOPE,
	READONLY_EXPLICIT_HANDOFF,
	READONLY_HANDOFF_TRIGGER,
	READONLY_NEXT_CONTEXT_RESUMES,
	READONLY_WRITE_EDIT_BASH,
	READONLY_WRITE_EDIT_BLOCK_REASON,
	READONLY_POWERSHELL_BLOCK_REASON,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_WRITE_EDIT_SUMMARY,
	READONLY_NO_SHELL_SUMMARY,
	READONLY_ACTIVE_SUMMARY,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
	READONLY_ENABLED_STATUS,
	READONLY_COMMAND_DESCRIPTION,
	READONLY_DISABLED_SUMMARY,
	READONLY_DISABLED_NOTIFICATION,
	READONLY_HANDOFF_EXCEPTION_NOTIFICATION,
	READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION,
	READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION,
};

test.each(Object.entries(allConstants))("all constants are non-empty strings: %s", (name, value) => {
	expect(value, `${name} must be a string`).toBeTypeOf("string");
	expect(value.trim().length, `${name} must be non-empty`).toBeGreaterThan(0);
});

test("composition chain: READONLY_WRITE_EDIT_BASH contains READONLY_BASH_SCOPE", () => {
	expect(READONLY_WRITE_EDIT_BASH).toContain(READONLY_BASH_SCOPE);
});

test("composition chain: READONLY_ENABLED_STATUS contains READONLY_BASH_SCOPE", () => {
	expect(READONLY_ENABLED_STATUS).toContain(READONLY_BASH_SCOPE);
});

test("summary constants use [readonly] prefix", () => {
	expectPrefix(READONLY_WRITE_EDIT_SUMMARY, "[readonly]");
	expectPrefix(READONLY_NO_SHELL_SUMMARY, "[readonly]");
	expectPrefix(READONLY_ACTIVE_SUMMARY, "[readonly]");
	expectPrefix(READONLY_HANDOFF_EXCEPTION_SUMMARY, "[readonly]");
	expectPrefix(READONLY_ENABLED_STATUS, "[readonly]");
	expectPrefix(READONLY_DISABLED_SUMMARY, "[readonly]");
});

test("block reasons use 'Readonly mode:' prefix", () => {
	expectPrefix(READONLY_WRITE_EDIT_BLOCK_REASON, "Readonly mode:");
	expectPrefix(READONLY_POWERSHELL_BLOCK_REASON, "Readonly mode:");
	expect(READONLY_POWERSHELL_BLOCK_REASON).toMatch(/powershell/);
	expectPrefix(READONLY_HANDOFF_BLOCK_REASON, "Readonly mode:");
	expectPrefix(buildReadonlyBashBlockReason("test", "cmd"), "Readonly mode:");
});

test("bash guard uses centralized readonly block copy", () => {
	const command = "touch /outside-temp-file";
	const result = applyReadonlyBashGuard(command, process.cwd());
	expect(result.action).toBe("block");
	if (result.action === "block") {
		const verdict = classifyBashCommand(command, process.cwd());
		expect(verdict.ok).toBe(false);
		if (verdict.ok === false) {
			expect(result.reason).toBe(buildReadonlyBashBlockReason(verdict.reason, command));
		}
	}
});

test("parent readonly tool-call consumer uses centralized block copy", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		getContextUsage: () => null,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
		},
	} as any);
	const result = await toolCall({ toolName: "write", input: {} }, {});
	expect(result).toStrictEqual({ block: true, reason: READONLY_WRITE_EDIT_BLOCK_REASON });
	const handoffResult = await toolCall({ toolName: "handoff", input: {} }, {});
	expect(handoffResult).toStrictEqual({ block: true, reason: READONLY_HANDOFF_BLOCK_REASON });
});

test("LLM-facing handoff copy reflects both readonly bypass triggers", () => {
	expect(READONLY_HANDOFF_BLOCK_REASON).toMatch(/explicit \/handoff/i);
	expect(READONLY_HANDOFF_BLOCK_REASON).toMatch(/human topic boundary/i);
	expect(READONLY_HANDOFF_EXCEPTION_SUMMARY).toMatch(/temporary handoff exception active/i);
	expect(READONLY_HANDOFF_EXCEPTION_SUMMARY).toMatch(/write\/edit\/powershell remain blocked/i);
	expect(READONLY_HANDOFF_EXCEPTION_SUMMARY).not.toMatch(/for this turn|this request only/i);
	expect(READONLY_HANDOFF_EXCEPTION_NOTIFICATION).toMatch(/write\/edit\/powershell remain blocked/i);
	expect(READONLY_HANDOFF_EXCEPTION_NOTIFICATION).not.toMatch(/for this turn/i);
});

test("shared readonly fragments keep copy aligned across contexts", () => {
	expect(READONLY_HANDOFF_BLOCK_REASON).toMatch(new RegExp(READONLY_HANDOFF_TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	expect(READONLY_HANDOFF_EXCEPTION_NOTIFICATION).toMatch(/fresh context resumes in readonly mode/i);
	expect(buildReadonlyRequestedHandoffContinuation()).toMatch(/fresh context resumes in readonly mode/i);
	expect(buildReadonlyHandoffWaitNotice()).toMatch(/readonly remains active/i);
	expect(buildReadonlyHandoffCommandNotice(), "the /handoff notice must reuse the shared readonly continuation sentence").toContain(READONLY_NEXT_CONTEXT_RESUMES);
	expect(buildReadonlyTopicBoundaryNotification("oauth", "billing")).toMatch(/handoff exception activates.*once the context is ready/i);
	expect(buildReadonlyDisabledContextSuffix(42)).toMatch(/42%/);
	expect(READONLY_NON_TEMP_MUTATION_SCOPE).toMatch(/non-temp bash filesystem mutations/i);
	expect(READONLY_HANDOFF_TRIGGER).toMatch(/human topic boundary/i);
	expect(READONLY_NEXT_CONTEXT_RESUMES).toMatch(/readonly mode/i);
	expect(READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION).toMatch(/resume in readonly mode/i);
	expect(READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION).toMatch(/will not resume in readonly mode/i);
	expect(READONLY_HANDOFF_RETRY_ADVICE).toMatch(/temporary readonly exception/i);
	expect(READONLY_CHILD_AUTHORITY_NOTE).toMatch(/inherit readonly authority/i);
	expect(buildReadonlyFrontmatterNotification(true, "/review")).toBe("Readonly mode enabled via `/review` frontmatter");
	expect(buildReadonlyFrontmatterNotification(false, "/review")).toBe("Readonly mode disabled via `/review` frontmatter");
	expect(buildStreamingModelSelectionBlockedNotification("/review")).toMatch(/model-selection frontmatter requires an idle agent/i);
	expect(buildStreamingReadonlyFrontmatterBlockedNotification("/review")).toMatch(/readonly frontmatter requires an idle agent/i);
	expect(buildReadonlyPackageManagerBlockReason("npm", "install")).toMatch(/blocked in readonly mode/i);
	expect(buildReadonlySandboxPathError("/tmp/'bad")).toMatch(/cannot safely escape/i);
});

test("readonly command consumes the centralized description", async () => {
	const pi = await createTestHost();
	expect(pi.commands.get("readonly")?.description).toBe(READONLY_COMMAND_DESCRIPTION);
});

// ── Model group / model / thinking frontmatter builders ───────────

test("buildModelGroupNotification includes group, model, and command ref", () => {
	const msg = buildModelGroupNotification("reviewer", "openai", "gpt-4o", "/review");
	expect(msg).toBe("Model changed to openai/gpt-4o via group `reviewer` from `/review` frontmatter");
});

test("buildModelGroupErrorNotification includes group and detail", () => {
	const msg = buildModelGroupErrorNotification("reviewer", "/review", "not defined");
	expect(msg).toBe("Cannot execute `/review`: Model Group `reviewer` error — not defined.");
});

test("buildModelGroupSetModelErrorNotification includes group, model, and command ref", () => {
	const msg = buildModelGroupSetModelErrorNotification("reviewer", "openai", "gpt-4o", "/review");
	expect(msg).toBe("Cannot execute `/review`: failed to switch to routed model openai/gpt-4o from group `reviewer`.");
});

test("buildModelFrontmatterNotification includes model and command ref", () => {
	const msg = buildModelFrontmatterNotification("openai", "gpt-4o", "/review");
	expect(msg).toBe("Model switched to openai/gpt-4o via `/review` frontmatter");
});

test("buildModelGroupOverrideWarningNotification includes group and command ref", () => {
	const msg = buildModelGroupOverrideWarningNotification("reviewer", "/review");
	expect(msg).toBe("Model Group `reviewer` overridden by explicit `model` from `/review` frontmatter");
});

test("buildThinkingFrontmatterNotification includes level and command ref", () => {
	const msg = buildThinkingFrontmatterNotification("high", "/review");
	expect(msg).toBe("Thinking level set to high via `/review` frontmatter");
});

test("buildModelFrontmatterErrorNotification includes model and detail", () => {
	const msg = buildModelFrontmatterErrorNotification("openai", "gpt-4o", "/review", "not found in registry");
	expect(msg).toBe("Cannot execute `/review`: model openai/gpt-4o not found in registry.");
});

test("buildModelFrontmatterSetModelErrorNotification includes model and command ref", () => {
	const msg = buildModelFrontmatterSetModelErrorNotification("openai", "gpt-4o", "/review");
	expect(msg).toBe("Cannot execute `/review`: failed to switch to model openai/gpt-4o.");
});

test("buildModelFrontmatterAuthErrorNotification includes model and command ref", () => {
	const msg = buildModelFrontmatterAuthErrorNotification("openai", "gpt-4o", "/review");
	expect(msg).toBe("Cannot execute `/review`: no API key for model openai/gpt-4o.");
});

test("streaming model-selection notification explains the idle-agent requirement", () => {
	expect(buildStreamingModelSelectionBlockedNotification("/review")).toBe("Cannot execute `/review` during streaming: model-selection frontmatter requires an idle agent.");
});

test("model-group builders include commandRef in output", () => {
	expect(buildModelGroupNotification("g", "p", "m", "/cmd")).toContain("/cmd");
	expect(buildModelGroupErrorNotification("g", "/cmd", "d")).toContain("/cmd");
	expect(buildModelGroupSetModelErrorNotification("g", "p", "m", "/cmd")).toContain("/cmd");
});

test("model frontmatter builders include commandRef in output", () => {
	expect(buildModelFrontmatterNotification("p", "m", "/cmd")).toContain("/cmd");
	expect(buildModelGroupOverrideWarningNotification("g", "/cmd")).toContain("/cmd");
	expect(buildModelFrontmatterErrorNotification("p", "m", "/cmd", "d")).toContain("/cmd");
	expect(buildModelFrontmatterSetModelErrorNotification("p", "m", "/cmd")).toContain("/cmd");
	expect(buildModelFrontmatterAuthErrorNotification("p", "m", "/cmd")).toContain("/cmd");
});
