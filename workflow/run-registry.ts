// WHY: `pi.sendUserMessage` is fire-and-forget, so a run resolves only when a later
// `agent_settled` boundary reveals the assistant entry appended after our marker.
import type { SessionEntry, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

type AnyMessage = { role?: string };

/** A workflow-supplied target resolved against the live slash-command catalogue. */
export interface RunTarget {
	/** The invocation text sent with `expandPromptTemplates: true`. */
	text: string;
	source: "prompt" | "skill" | "plain";
}

// Extension commands own their turns and expose no completion signal, so the workflow rejects them.
export function resolveRunTarget(commands: readonly SlashCommandInfo[], prompt: string): RunTarget {
	if (typeof prompt !== "string" || !prompt.trim()) throw new Error("workflow.run requires a non-empty prompt");
	const trimmed = prompt.trim();
	const hadSlash = trimmed.startsWith("/");
	const slashless = hadSlash ? trimmed.slice(1) : trimmed;
	const [head, ...restParts] = slashless.split(/\s+/);
	const rest = restParts.join(" ");
	const match = commands.find((command) => command.name === head) ?? commands.find((command) => command.name === `skill:${head}`);
	if (!match) return { text: hadSlash ? `/${head}${rest ? ` ${rest}` : ""}` : trimmed, source: "plain" };
	if (match.source === "extension")
		throw new Error(`workflow.run cannot run extension command "${head}"; use a prompt template or skill`);
	const canonical = match.source === "skill" ? match.name : head;
	return { text: `/${canonical}${rest ? ` ${rest}` : ""}`, source: match.source };
}

export interface RunMatch {
	fromEntryId: string | null;
	toEntryId: string | null;
	/** All entries after the marker at the settled boundary. */
	branch: SessionEntry[];
}

export interface RunCorrelation {
	promise: Promise<RunMatch>;
	reject(error: unknown): void;
}

export interface RunRegistry {
	correlate(marker: string | null): RunCorrelation;
	dispose(): void;
}

interface PendingRun {
	marker: string | null;
	resolve: (match: RunMatch) => void;
	reject: (error: unknown) => void;
}

function assistantIndexAfter(entries: readonly SessionEntry[], marker: string | null): number | null {
	const at = marker ? entries.findIndex((entry) => entry.id === marker) : -1;
	if (marker !== null && at < 0) return null;
	for (let i = entries.length - 1; i > at; i--) {
		const entry = entries[i];
		if (entry.type === "message" && (entry.message as AnyMessage).role === "assistant") return i;
	}
	return null;
}

/** Correlate one sent run. Null when the branch has no assistant entry after the marker yet. */
export function matchRun(entries: readonly SessionEntry[], marker: string | null): RunMatch | null {
	const index = assistantIndexAfter(entries, marker);
	if (index === null) return null;
	const at = marker ? entries.findIndex((entry) => entry.id === marker) : -1;
	const start = at + 1;
	return {
		fromEntryId: entries[start]?.id ?? null,
		toEntryId: entries[entries.length - 1].id,
		branch: entries.slice(start),
	};
}

interface RegistryState {
	pending: Set<PendingRun>;
	unsubscribe: (() => void) | null;
}

function release(state: RegistryState): void {
	if (state.pending.size > 0 || !state.unsubscribe) return;
	state.unsubscribe();
	state.unsubscribe = null;
}

function checkPending(state: RegistryState, getBranch: () => readonly SessionEntry[]): void {
	const branch = getBranch();
	for (const run of [...state.pending]) {
		const match = matchRun(branch, run.marker);
		if (!match) continue;
		state.pending.delete(run);
		run.resolve(match);
	}
	release(state);
}

function createPendingRun(marker: string | null): { run: PendingRun; promise: Promise<RunMatch> } {
	let resolve!: (match: RunMatch) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<RunMatch>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { run: { marker, resolve, reject }, promise };
}

/** Subscribe once and register one pending run; settled events match runs by branch marker. */
function correlate(
	state: RegistryState,
	onSettled: (listener: () => void) => () => void,
	getBranch: () => readonly SessionEntry[],
	marker: string | null
): RunCorrelation {
	if (!state.unsubscribe) state.unsubscribe = onSettled(() => checkPending(state, getBranch));
	const { run, promise } = createPendingRun(marker);
	state.pending.add(run);
	// Synchronous send errors can reject before the caller starts awaiting.
	promise.catch(() => {});
	return {
		promise,
		reject: (error) => {
			state.pending.delete(run);
			release(state);
			run.reject(error);
		},
	};
}

function dispose(state: RegistryState): void {
	state.unsubscribe?.();
	state.unsubscribe = null;
	for (const run of state.pending) {
		run.reject(new Error("run registry disposed"));
	}
	state.pending.clear();
}

/** Turn `agent_settled` notifications into correlated run matches. One settle may resolve several. */
export function createRunRegistry(deps: {
	onSettled: (listener: () => void) => () => void;
	getBranch: () => readonly SessionEntry[];
}): RunRegistry {
	const state: RegistryState = { pending: new Set(), unsubscribe: null };
	return {
		correlate: (marker) => correlate(state, deps.onSettled, deps.getBranch, marker),
		dispose: () => dispose(state),
	};
}
