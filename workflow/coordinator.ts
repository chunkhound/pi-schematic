// WHY: a session replacement builds a fresh runtime (fresh pi, state, services), so a
// running workflow must rebind to the replacement's live pieces. jiti can load this module
// more than once per process (moduleCache false), so the registry lives on globalThis
// under a registered symbol: the fresh runtime's publisher and the still-running
// command share one process-wide map.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registeredState } from "../process-state.js";
import type { SchematicState } from "../state.js";
import type { RebindableDeps } from "./rebind.js";

/** Live runtime pieces published by `session_start` and consumed by a running workflow.
 * `rebindDeps` is the one place that knows which deps are session-scoped; a new one is
 * added here (and to RebindableDeps), never in rebindRun's call site. */
export interface WorkflowRuntimeBinding {
	pi: ExtensionAPI;
	state: SchematicState;
	rebindDeps(current: RebindableDeps): RebindableDeps;
}

interface WorkflowGlobal {
	/** Bindings keyed by session id; one entry per live runtime. */
	runtimes: Map<string, WorkflowRuntimeBinding>;
	/** The single active workflow reservation, independent of session identity. */
	workflowReserved: boolean;
}

function workflowGlobal(): WorkflowGlobal {
	// Same Symbol.for key, lazy create on first access (mechanism: process-state.ts).
	return registeredState<WorkflowGlobal>("pi-schematic.workflow-registry", () => ({ runtimes: new Map(), workflowReserved: false }));
}

/** Publish the live runtime for a session. Called synchronously from `session_start`. */
export function publishWorkflowRuntime(sessionId: string, binding: WorkflowRuntimeBinding): void {
	workflowGlobal().runtimes.set(sessionId, binding);
}

/** Drop the runtime published for a session. Called from `session_shutdown`. */
export function discardWorkflowRuntime(sessionId: string): void {
	workflowGlobal().runtimes.delete(sessionId);
}

/** Consume the runtime published for a replacement session; null when none was published. */
export function takeWorkflowRuntime(sessionId: string): WorkflowRuntimeBinding | null {
	const registry = workflowGlobal();
	const binding = registry.runtimes.get(sessionId) ?? null;
	if (binding) registry.runtimes.delete(sessionId);
	return binding;
}

/** Claim the single active workflow before any await; false when one is already running. */
export function reserveWorkflow(): boolean {
	const registry = workflowGlobal();
	if (registry.workflowReserved) return false;
	registry.workflowReserved = true;
	return true;
}

/** Release the active-workflow reservation. */
export function releaseWorkflow(): void {
	workflowGlobal().workflowReserved = false;
}
