import { contentText, type ModelThinkingLevel, type StopReason, type TextContent, type Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { stripUnsafeDisplayChars } from "../model-groups/display.js";

export type SpawnOutcome = "running" | "success" | "aborted" | "error";

/** The spawn tool's registered name; the spend ledger's single-owner gate for child tool results. */
export const SPAWN_TOOL_NAME = "spawn";

export type SpawnRouteDetails =
	// provider/modelId are optional only to read sessions persisted before they were added;
	// every new write sets them so the spend ledger never splits one model across two rows.
	| { status: "inherited"; provider?: string; modelId?: string }
	| { status: "routed"; group: string; provider: string; modelId: string }
	| { status: "unknown-fallback"; requestedGroup: string; provider: string; modelId: string };

export interface SpawnResultDetails {
	model: string;
	/** Effective child-session level after Pi applies model capability clamping. */
	thinking: ModelThinkingLevel;
	truncated: boolean;
	outcome: SpawnOutcome;
	route?: SpawnRouteDetails;
	stats?: Record<string, number>;
	statsUnavailable?: boolean;
	/** Teardown failures that did not become the result error: instrumentation-only failures (spend flushes, event unsubscribes) on a successful run, or every cleanup failure on a failed run whose error notice succeeded (the primary error is still thrown). */
	teardownFailures?: string[];
}

export interface SpawnToolResult {
	content: TextContent[];
	details: SpawnResultDetails;
	usage: Usage;
	isError?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow a tool result's free-form `details` to the spawn contract; other tools' records never match. */
export function isSpawnResultDetails(value: unknown): value is SpawnResultDetails {
	return isRecord(value) && typeof value.model === "string" && (value.route === undefined || isRecord(value.route));
}

/** The spend-row identity of a spawn result. A present route must name its provider as a string; a
 * malformed/hostile route degrades to null (unattributed). Control bytes are stripped so a stored or
 * imported result can neither fragment rows nor smuggle rendering bytes into a surface that prints keys. */
export function spawnSpendIdentity(details: SpawnResultDetails): { provider: string | null; model: string } | null {
	const route = details.route;
	const provider = route?.provider;
	if (route !== undefined && typeof provider !== "string") {
		return null;
	}
	const normalizedProvider = typeof provider !== "string" || provider === "" ? null : stripUnsafeDisplayChars(provider);
	return { provider: normalizedProvider, model: stripUnsafeDisplayChars(details.model) };
}

/** Single writer of the inherited route shape: every new write carries the provider/modelId identity. */
export function inheritedRouteDetails(provider: string, modelId: string): SpawnRouteDetails {
	return { status: "inherited", provider, modelId };
}

/** Maps the failure stop reasons to their outcome; every other stop reason has none. */
export function getStopReasonOutcome(stopReason: StopReason | undefined): SpawnOutcome | undefined {
	if (stopReason === "aborted") {
		return "aborted";
	}
	if (stopReason === "error") {
		return "error";
	}
	return undefined;
}

/**
 * Returns all text blocks from the last assistant message, joined by newlines.
 */
export function getLastAssistantText(messages: AgentSession["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") {
			continue;
		}
		const text = contentText(msg.content).trim();
		if (text) {
			return text;
		}
	}
	return "";
}
