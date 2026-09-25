/**
 * Shared notification copy.
 *
 * Keep reusable notification wording here so tool blocks, nudges, TUI, handoff
 * prompts, and model-selection messages stay aligned.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Scope of bash filesystem mutations blocked by readonly mode. */
export const READONLY_BASH_SCOPE = "bash writes/deletions outside temp blocked";
/** Scope of non-temporary mutations blocked while readonly is active. */
export const READONLY_NON_TEMP_MUTATION_SCOPE = "write, edit, and non-temp bash filesystem mutations remain blocked";
/** Message emitted when the OS sandbox rejects a readonly mutation. */
export const READONLY_SANDBOX_BLOCK_NOTICE = "[readonly mode] The OS sandbox blocked a filesystem write outside the OS temp dir.\nUse /readonly to disable, or write within the OS temp dir.";
/** User-visible shorthand for an explicit handoff request. */
export const READONLY_EXPLICIT_HANDOFF = "explicit /handoff";
/** All supported ways to activate the temporary readonly handoff exception. */
export const READONLY_HANDOFF_TRIGGER = "explicit /handoff or an eligible human topic boundary";
/** Post-handoff readonly outcome announced while this context prepares the handoff. */
export const READONLY_NEXT_CONTEXT_RESUMES = "Fresh context resumes in readonly mode.";
/** Child-agent summary of the readonly mutation policy. */
export const READONLY_WRITE_EDIT_BASH = `write/edit blocked; ${READONLY_BASH_SCOPE}`;

/** Reason for malformed bash tool input at the readonly boundary. */
export const READONLY_INVALID_BASH_COMMAND_REASON = "bash command input must be a string";

/** Build the detailed reason returned when a bash command is blocked. */
export function buildReadonlyBashBlockReason(reason: string, command: string): string {
	return `Readonly mode: command blocked.\nReason: ${reason}\nCommand: ${command}`;
}

/** Build the package-manager mutation reason used by the bash classifier. */
export function buildReadonlyPackageManagerBlockReason(command: string, args: string): string {
	return `${command} ${args} is blocked in readonly mode`;
}

/** Build the error for an unsafe OS sandbox profile path. */
export function buildReadonlySandboxPathError(path: string): string {
	return `[readonly] Sandbox profile path contains quote — cannot safely escape: ${path}`;
}

/** Build the notification emitted after readonly frontmatter is applied. */
export function buildReadonlyFrontmatterNotification(enabled: boolean, commandRef: string): string {
	return `Readonly mode ${enabled ? "enabled" : "disabled"} via \`${commandRef}\` frontmatter`;
}

/** Text shown when a readonly handoff is cancelled and must be requested again. */
export const READONLY_HANDOFF_RETRY_ADVICE = "Use /handoff <direction> again to recreate the temporary readonly exception and retry.";

/** Text shown in a readonly child session to establish inherited authority. */
export const READONLY_CHILD_AUTHORITY_NOTE = "You inherit readonly authority in this session.";

export const READONLY_WRITE_EDIT_BLOCK_REASON =
	"Readonly mode: write/edit blocked until the user disables readonly. Do not attempt alternative write strategies.";

export const READONLY_HANDOFF_BLOCK_REASON =
	`Readonly mode: handoff blocked until an ${READONLY_HANDOFF_TRIGGER} enables the temporary exception. Use spawn for same-topic delegation.`;

export const READONLY_WRITE_EDIT_SUMMARY = `[readonly] ${READONLY_WRITE_EDIT_BASH}`;

export const READONLY_ACTIVE_SUMMARY = `[readonly] enabled — write/edit blocked; ${READONLY_BASH_SCOPE}; handoff needs ${READONLY_HANDOFF_TRIGGER}.`;

export const READONLY_HANDOFF_EXCEPTION_SUMMARY = `[readonly] temporary handoff exception active; write/edit remain blocked; ${READONLY_BASH_SCOPE}.`;

/** TUI notification shown when readonly mode is enabled. */
export const READONLY_ENABLED_STATUS = `[readonly] enabled — write/edit blocked; handoff needs ${READONLY_HANDOFF_TRIGGER}; ${READONLY_BASH_SCOPE}`;

export const READONLY_COMMAND_DESCRIPTION =
	`Toggle readonly mode (${READONLY_WRITE_EDIT_BASH}; handoff needs ${READONLY_HANDOFF_TRIGGER})`;

export const READONLY_DISABLED_SUMMARY = "[readonly] disabled — write, edit, handoff, and bash writes are now fully available.";

/** Notification on readonly toggle-off for TUI user. */
export const READONLY_DISABLED_NOTIFICATION = READONLY_DISABLED_SUMMARY;

export const READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION =
	"Pending handoff updated — the fresh context will resume in readonly mode.";

export const READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION =
	"Pending handoff readonly continuation cleared — the fresh context will not resume in readonly mode.";

/** Notification in /handoff command when readonly is active. */
export const READONLY_HANDOFF_EXCEPTION_NOTIFICATION =
	`Readonly is active. An ${READONLY_EXPLICIT_HANDOFF} exception is reserved for this request; the handoff will start a fresh context once feasible. Write/edit remain blocked, and ${READONLY_BASH_SCOPE} stays in effect. After a successful handoff, ${READONLY_NEXT_CONTEXT_RESUMES.toLowerCase()}`;

/** Add context usage to the one-shot readonly-disabled message. */
export function buildReadonlyDisabledContextSuffix(percent: number): string {
	return ` Context at ${Math.round(percent)}% — if the work changed topics, you can handoff now.`;
}

/** Explain that an eligible human topic boundary will activate the temporary bypass. */
export function buildReadonlyTopicBoundaryNotification(from: string | null, to: string): string {
	return `Active notebook topic changed: ${from ?? "(unset)"} → ${to}. This is a likely task boundary; use spawn only for same-topic delegation. In readonly mode, the handoff exception activates only once the context is ready; until then this boundary is advisory.`;
}

/** Explain when a readonly topic boundary has activated the handoff path. */
export function buildReadonlyBoundaryPromotionNotification(): string {
	return "Readonly topic boundary detected. The handoff exception is now active because context usage is eligible; complete the handoff before continuing normal work.";
}

/** Describe the readonly constraints carried into a required handoff. */
export function buildReadonlyRequestedHandoffContinuation(): string {
	return `${READONLY_HANDOFF_EXCEPTION_SUMMARY} This temporary bypass exists only so you can complete the required handoff now. After success, ${READONLY_NEXT_CONTEXT_RESUMES.toLowerCase()}`;
}

/** Explain the readonly constraint while an ineligible handoff waits. */
export function buildReadonlyHandoffWaitNotice(): string {
	return ` Readonly remains active; ${READONLY_NON_TEMP_MUTATION_SCOPE}.`;
}

/** Add readonly-specific instructions to the explicit /handoff command. */
export function buildReadonlyHandoffCommandNotice(): string {
	return `\n\n${READONLY_HANDOFF_EXCEPTION_SUMMARY} ${READONLY_NEXT_CONTEXT_RESUMES}`;
}

// ── Model Group Frontmatter Notifications ────────────────────────────

/** Notification shown when a frontmatter model-group triggers a model change. */
export function buildModelGroupNotification(groupName: string, provider: string, modelId: string, commandRef: string): string {
	return `Model changed to ${provider}/${modelId} via group \`${groupName}\` from \`${commandRef}\` frontmatter`;
}

/** Error notification when a frontmatter model-group cannot be resolved. */
export function buildModelGroupErrorNotification(groupName: string, commandRef: string, detail: string): string {
	return `Cannot execute \`${commandRef}\`: Model Group \`${groupName}\` error — ${detail}.`;
}

/** Error notification when model change fails after group resolution. */
export function buildModelGroupSetModelErrorNotification(groupName: string, provider: string, modelId: string, commandRef: string): string {
	return `Cannot execute \`${commandRef}\`: failed to switch to routed model ${provider}/${modelId} from group \`${groupName}\`.`;
}

// ── Explicit Model Frontmatter Notifications ────────────────────────

/** Notification shown when an explicit `model` frontmatter triggers a model change. */
export function buildModelFrontmatterNotification(provider: string, modelId: string, commandRef: string): string {
	return `Model switched to ${provider}/${modelId} via \`${commandRef}\` frontmatter`;
}

/** Warning when both `model` and `model-group` are in frontmatter — explicit model wins. */
export function buildModelGroupOverrideWarningNotification(groupName: string, commandRef: string): string {
	return `Model Group \`${groupName}\` overridden by explicit \`model\` from \`${commandRef}\` frontmatter`;
}

/** Notification shown when `thinking` frontmatter changes the thinking level. */
export function buildThinkingFrontmatterNotification(level: ModelThinkingLevel, commandRef: string): string {
	return `Thinking level set to ${level} via \`${commandRef}\` frontmatter`;
}

/** Error notification when an explicit `model` frontmatter cannot be resolved. */
export function buildModelFrontmatterErrorNotification(provider: string, modelId: string, commandRef: string, detail: string): string {
	return `Cannot execute \`${commandRef}\`: model ${provider}/${modelId} ${detail}.`;
}

/** Error notification when model switch fails after validation. */
export function buildModelFrontmatterSetModelErrorNotification(provider: string, modelId: string, commandRef: string): string {
	return `Cannot execute \`${commandRef}\`: failed to switch to model ${provider}/${modelId}.`;
}

/** Error notification when an explicit `model` frontmatter has no API key. */
export function buildModelFrontmatterAuthErrorNotification(provider: string, modelId: string, commandRef: string): string {
	return `Cannot execute \`${commandRef}\`: no API key for model ${provider}/${modelId}.`;
}

export function buildStreamingModelSelectionBlockedNotification(commandRef: string): string {
	return `Cannot execute \`${commandRef}\` during streaming: model-selection frontmatter requires an idle agent.`;
}

export function buildStreamingReadonlyFrontmatterBlockedNotification(commandRef: string): string {
	return `Cannot execute \`${commandRef}\` during streaming: readonly frontmatter requires an idle agent.`;
}
