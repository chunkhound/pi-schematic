/**
 * Smoke tests for notifications.ts constants.
 *
 * Verifies the composition chain integrity — a typo in a base constant
 * would cascade to downstream constants. These tests catch that cheaply.
 */

import test from "node:test";
import assert from "node:assert/strict";
import registerAgenticoding from "../../index.js";
import { wrapWithBwrap, wrapWithSandboxExec } from "../../os-sandbox.js";
import { applyReadonlyBashGuard, classifyBashCommand } from "../../readonly-bash.js";
import { createTestPI } from "./helpers.js";
import {
	READONLY_BASH_SCOPE,
	READONLY_NON_TEMP_MUTATION_SCOPE,
	READONLY_SANDBOX_BLOCK_NOTICE,
	READONLY_EXPLICIT_HANDOFF,
	READONLY_HANDOFF_TRIGGER,
	READONLY_NEXT_CONTEXT_RESUMES,
	READONLY_WRITE_EDIT_BASH,
	READONLY_WRITE_EDIT_BLOCK_REASON,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_WRITE_EDIT_SUMMARY,
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
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_WRITE_EDIT_SUMMARY,
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

test("all constants are non-empty strings", () => {
	for (const [name, value] of Object.entries(allConstants)) {
		assert.equal(typeof value, "string", `${name} must be a string`);
		assert.ok(value.trim().length > 0, `${name} must be non-empty`);
	}
});

test("composition chain: READONLY_WRITE_EDIT_BASH contains READONLY_BASH_SCOPE", () => {
	assert.ok(READONLY_WRITE_EDIT_BASH.includes(READONLY_BASH_SCOPE));
});

test("composition chain: READONLY_ENABLED_STATUS contains READONLY_BASH_SCOPE", () => {
	assert.ok(READONLY_ENABLED_STATUS.includes(READONLY_BASH_SCOPE));
});

test("summary constants use [readonly] prefix", () => {
	assert.ok(READONLY_WRITE_EDIT_SUMMARY.startsWith("[readonly]"));
	assert.ok(READONLY_ACTIVE_SUMMARY.startsWith("[readonly]"));
	assert.ok(READONLY_HANDOFF_EXCEPTION_SUMMARY.startsWith("[readonly]"));
	assert.ok(READONLY_ENABLED_STATUS.startsWith("[readonly]"));
	assert.ok(READONLY_DISABLED_SUMMARY.startsWith("[readonly]"));
});

test("block reasons use 'Readonly mode:' prefix", () => {
	assert.ok(READONLY_WRITE_EDIT_BLOCK_REASON.startsWith("Readonly mode:"));
	assert.ok(READONLY_HANDOFF_BLOCK_REASON.startsWith("Readonly mode:"));
	assert.ok(buildReadonlyBashBlockReason("test", "cmd").startsWith("Readonly mode:"));
});

test("bash and sandbox consumers use centralized readonly copy", () => {
	const command = "touch /outside-temp-file";
	const result = applyReadonlyBashGuard(command, process.cwd());
	assert.equal(result.action, "block");
	if (result.action === "block") {
		const verdict = classifyBashCommand(command, process.cwd());
		assert.equal(verdict.ok, false);
		if (verdict.ok === false) {
			assert.equal(result.reason, buildReadonlyBashBlockReason(verdict.reason, command));
		}
	}
	assert.ok(wrapWithSandboxExec("echo test").includes(READONLY_SANDBOX_BLOCK_NOTICE));
	assert.ok(wrapWithBwrap("echo test").includes(READONLY_SANDBOX_BLOCK_NOTICE));
});

test("parent readonly tool-call consumer uses centralized block copy", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
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
	const [toolCall] = pi.handlers.get("tool_call")!;
	const result = await toolCall({ toolName: "write", input: {} }, {});
	assert.deepEqual(result, { block: true, reason: READONLY_WRITE_EDIT_BLOCK_REASON });
	const handoffResult = await toolCall({ toolName: "handoff", input: {} }, {});
	assert.deepEqual(handoffResult, { block: true, reason: READONLY_HANDOFF_BLOCK_REASON });
});

test("LLM-facing handoff copy reflects both readonly bypass triggers", () => {
	assert.match(READONLY_HANDOFF_BLOCK_REASON, /explicit \/handoff/i);
	assert.match(READONLY_HANDOFF_BLOCK_REASON, /human topic boundary/i);
	assert.match(READONLY_HANDOFF_EXCEPTION_SUMMARY, /temporary handoff exception active/i);
	assert.match(READONLY_HANDOFF_EXCEPTION_SUMMARY, /write\/edit remain blocked/i);
	assert.doesNotMatch(READONLY_HANDOFF_EXCEPTION_SUMMARY, /for this turn|this request only/i);
	assert.match(READONLY_HANDOFF_EXCEPTION_NOTIFICATION, /write\/edit remain blocked/i);
	assert.doesNotMatch(READONLY_HANDOFF_EXCEPTION_NOTIFICATION, /for this turn/i);
});

test("shared readonly fragments keep copy aligned across contexts", () => {
	assert.match(READONLY_HANDOFF_BLOCK_REASON, new RegExp(READONLY_HANDOFF_TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	assert.match(READONLY_HANDOFF_EXCEPTION_NOTIFICATION, /fresh context resumes in readonly mode/i);
	assert.match(buildReadonlyRequestedHandoffContinuation(), /fresh context resumes in readonly mode/i);
	assert.match(buildReadonlyHandoffWaitNotice(), /readonly remains active/i);
	assert.ok(buildReadonlyHandoffCommandNotice().includes(READONLY_NEXT_CONTEXT_RESUMES),
		"the /handoff notice must reuse the shared readonly continuation sentence");
	assert.match(buildReadonlyTopicBoundaryNotification("oauth", "billing"), /handoff exception activates.*once the context is ready/i);
	assert.match(buildReadonlyDisabledContextSuffix(42), /42%/);
	assert.match(READONLY_NON_TEMP_MUTATION_SCOPE, /non-temp bash filesystem mutations/i);
	assert.match(READONLY_HANDOFF_TRIGGER, /human topic boundary/i);
	assert.match(READONLY_NEXT_CONTEXT_RESUMES, /readonly mode/i);
	assert.match(READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION, /resume in readonly mode/i);
	assert.match(READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION, /will not resume in readonly mode/i);
	assert.match(READONLY_HANDOFF_RETRY_ADVICE, /temporary readonly exception/i);
	assert.match(READONLY_CHILD_AUTHORITY_NOTE, /inherit readonly authority/i);
	assert.equal(buildReadonlyFrontmatterNotification(true, "/review"), "Readonly mode enabled via `/review` frontmatter");
	assert.equal(buildReadonlyFrontmatterNotification(false, "/review"), "Readonly mode disabled via `/review` frontmatter");
	assert.match(buildStreamingModelSelectionBlockedNotification("/review"), /model-selection frontmatter requires an idle agent/i);
	assert.match(buildStreamingReadonlyFrontmatterBlockedNotification("/review"), /readonly frontmatter requires an idle agent/i);
	assert.match(buildReadonlyPackageManagerBlockReason("npm", "install"), /blocked in readonly mode/i);
	assert.match(buildReadonlySandboxPathError("/tmp/'bad"), /cannot safely escape/i);
});

test("readonly command consumes the centralized description", () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	assert.equal(pi.commands.get("readonly")?.description, READONLY_COMMAND_DESCRIPTION);
});

// ── Model group / model / thinking frontmatter builders ───────────

test("buildModelGroupNotification includes group, model, and command ref", () => {
	const msg = buildModelGroupNotification("reviewer", "openai", "gpt-4o", "/review");
	assert.equal(msg, "Model changed to openai/gpt-4o via group `reviewer` from `/review` frontmatter");
});

test("buildModelGroupErrorNotification includes group and detail", () => {
	const msg = buildModelGroupErrorNotification("reviewer", "/review", "not defined");
	assert.equal(msg, "Cannot execute `/review`: Model Group `reviewer` error — not defined.");
});

test("buildModelGroupSetModelErrorNotification includes group, model, and command ref", () => {
	const msg = buildModelGroupSetModelErrorNotification("reviewer", "openai", "gpt-4o", "/review");
	assert.equal(msg, "Cannot execute `/review`: failed to switch to routed model openai/gpt-4o from group `reviewer`.");
});

test("buildModelFrontmatterNotification includes model and command ref", () => {
	const msg = buildModelFrontmatterNotification("openai", "gpt-4o", "/review");
	assert.equal(msg, "Model switched to openai/gpt-4o via `/review` frontmatter");
});

test("buildModelGroupOverrideWarningNotification includes group and command ref", () => {
	const msg = buildModelGroupOverrideWarningNotification("reviewer", "/review");
	assert.equal(msg, "Model Group `reviewer` overridden by explicit `model` from `/review` frontmatter");
});

test("buildThinkingFrontmatterNotification includes level and command ref", () => {
	const msg = buildThinkingFrontmatterNotification("high", "/review");
	assert.equal(msg, "Thinking level set to high via `/review` frontmatter");
});

test("buildModelFrontmatterErrorNotification includes model and detail", () => {
	const msg = buildModelFrontmatterErrorNotification("openai", "gpt-4o", "/review", "not found in registry");
	assert.equal(msg, "Cannot execute `/review`: model openai/gpt-4o not found in registry.");
});

test("buildModelFrontmatterSetModelErrorNotification includes model and command ref", () => {
	const msg = buildModelFrontmatterSetModelErrorNotification("openai", "gpt-4o", "/review");
	assert.equal(msg, "Cannot execute `/review`: failed to switch to model openai/gpt-4o.");
});

test("buildModelFrontmatterAuthErrorNotification includes model and command ref", () => {
	const msg = buildModelFrontmatterAuthErrorNotification("openai", "gpt-4o", "/review");
	assert.equal(msg, "Cannot execute `/review`: no API key for model openai/gpt-4o.");
});

test("streaming model-selection notification explains the idle-agent requirement", () => {
	assert.equal(
		buildStreamingModelSelectionBlockedNotification("/review"),
		"Cannot execute `/review` during streaming: model-selection frontmatter requires an idle agent.",
	);
});

test("model-group builders include commandRef in output", () => {
	assert.ok(buildModelGroupNotification("g", "p", "m", "/cmd").includes("/cmd"));
	assert.ok(buildModelGroupErrorNotification("g", "/cmd", "d").includes("/cmd"));
	assert.ok(buildModelGroupSetModelErrorNotification("g", "p", "m", "/cmd").includes("/cmd"));
});

test("model frontmatter builders include commandRef in output", () => {
	assert.ok(buildModelFrontmatterNotification("p", "m", "/cmd").includes("/cmd"));
	assert.ok(buildModelGroupOverrideWarningNotification("g", "/cmd").includes("/cmd"));
	assert.ok(buildModelFrontmatterErrorNotification("p", "m", "/cmd", "d").includes("/cmd"));
	assert.ok(buildModelFrontmatterSetModelErrorNotification("p", "m", "/cmd").includes("/cmd"));
	assert.ok(buildModelFrontmatterAuthErrorNotification("p", "m", "/cmd").includes("/cmd"));
});
