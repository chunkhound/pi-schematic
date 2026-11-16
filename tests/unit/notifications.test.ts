// The readonly copy the model and the user read, pinned by literal fragments and exact strings, and
// the exact wording of the model-group, model and thinking frontmatter notifications.

import { expect, test } from "vitest";
import {
	READONLY_NON_TEMP_MUTATION_SCOPE,
	READONLY_HANDOFF_TRIGGER,
	READONLY_NEXT_CONTEXT_RESUMES,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
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
	buildReadonlyFrontmatterNotification,
	buildReadonlyPackageManagerBlockReason,
	buildReadonlySandboxPathError,
	buildReadonlyDisabledContextSuffix,
	buildReadonlyTopicBoundaryNotification,
	buildReadonlyRequestedHandoffContinuation,
	buildReadonlyHandoffWaitNotice,
	buildReadonlyHandoffCommandNotice,
} from "../../notifications.js";

test("LLM-facing handoff copy reflects both readonly bypass triggers", () => {
	expect(READONLY_HANDOFF_BLOCK_REASON).toMatch(/explicit \/handoff/i);
	expect(READONLY_HANDOFF_BLOCK_REASON).toMatch(/human topic boundary/i);
	expect(READONLY_HANDOFF_EXCEPTION_SUMMARY).toMatch(/temporary handoff exception active/i);
	expect(READONLY_HANDOFF_EXCEPTION_SUMMARY).toMatch(/write\/edit\/powershell remain blocked/i);
	expect(READONLY_HANDOFF_EXCEPTION_NOTIFICATION).toMatch(/write\/edit\/powershell remain blocked/i);
});

test.each([
	{ source: "READONLY_HANDOFF_EXCEPTION_NOTIFICATION", text: READONLY_HANDOFF_EXCEPTION_NOTIFICATION, fragment: "fresh context resumes in readonly mode" },
	{
		source: "buildReadonlyRequestedHandoffContinuation()",
		text: buildReadonlyRequestedHandoffContinuation(),
		fragment: "fresh context resumes in readonly mode",
	},
	{ source: "buildReadonlyHandoffWaitNotice()", text: buildReadonlyHandoffWaitNotice(), fragment: "Readonly remains active" },
	{ source: "buildReadonlyHandoffCommandNotice()", text: buildReadonlyHandoffCommandNotice(), fragment: "Fresh context resumes in readonly mode." },
	{
		source: 'buildReadonlyTopicBoundaryNotification("oauth", "billing")',
		text: buildReadonlyTopicBoundaryNotification("oauth", "billing"),
		fragment: "the handoff exception activates only once the context is ready",
	},
	{ source: "buildReadonlyDisabledContextSuffix(42)", text: buildReadonlyDisabledContextSuffix(42), fragment: "42%" },
	{ source: "READONLY_NON_TEMP_MUTATION_SCOPE", text: READONLY_NON_TEMP_MUTATION_SCOPE, fragment: "non-temp bash filesystem mutations" },
	{ source: "READONLY_HANDOFF_TRIGGER", text: READONLY_HANDOFF_TRIGGER, fragment: "human topic boundary" },
	{ source: "READONLY_NEXT_CONTEXT_RESUMES", text: READONLY_NEXT_CONTEXT_RESUMES, fragment: "readonly mode" },
	{ source: "READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION", text: READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION, fragment: "resume in readonly mode" },
	{
		source: "READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION",
		text: READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION,
		fragment: "will not resume in readonly mode",
	},
	{ source: "READONLY_HANDOFF_RETRY_ADVICE", text: READONLY_HANDOFF_RETRY_ADVICE, fragment: "temporary readonly exception" },
	{ source: "READONLY_CHILD_AUTHORITY_NOTE", text: READONLY_CHILD_AUTHORITY_NOTE, fragment: "inherit readonly authority" },
	{
		source: 'buildStreamingModelSelectionBlockedNotification("/review")',
		text: buildStreamingModelSelectionBlockedNotification("/review"),
		fragment: "model-selection frontmatter requires an idle agent",
	},
	{
		source: 'buildStreamingReadonlyFrontmatterBlockedNotification("/review")',
		text: buildStreamingReadonlyFrontmatterBlockedNotification("/review"),
		fragment: "readonly frontmatter requires an idle agent",
	},
	{
		source: 'buildReadonlyPackageManagerBlockReason("npm", "install")',
		text: buildReadonlyPackageManagerBlockReason("npm", "install"),
		fragment: "blocked in readonly mode",
	},
	{ source: 'buildReadonlySandboxPathError("/tmp/\'bad")', text: buildReadonlySandboxPathError("/tmp/'bad"), fragment: "cannot safely escape" },
])("shared readonly fragments keep copy aligned across contexts: $source", ({ text, fragment }) => {
	expect(text).toContain(fragment);
});

test.each([
	{
		source: 'buildReadonlyFrontmatterNotification(true, "/review")',
		text: buildReadonlyFrontmatterNotification(true, "/review"),
		expected: "Readonly mode enabled via `/review` frontmatter",
	},
	{
		source: 'buildReadonlyFrontmatterNotification(false, "/review")',
		text: buildReadonlyFrontmatterNotification(false, "/review"),
		expected: "Readonly mode disabled via `/review` frontmatter",
	},
])("shared readonly fragments keep copy aligned across contexts: $source", ({ text, expected }) => {
	expect(text).toBe(expected);
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
	expect(buildStreamingModelSelectionBlockedNotification("/review")).toBe(
		"Cannot execute `/review` during streaming: model-selection frontmatter requires an idle agent.",
	);
});
