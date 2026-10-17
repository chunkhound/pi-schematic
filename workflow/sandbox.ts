// WHY: Node timers overflow above 2^31-1 ms and fire almost immediately, so a finite
// deadline clamps to the timer max instead of becoming an instant timeout. Only an
// explicit no-limit (non-finite or non-positive input) disables the deadline.
import { CodemodeSandbox, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import type { WorkflowLimits, WorkflowSandboxFactory } from "./types.js";
import { registeredState } from "../process-state.js";

export const MAX_TIMEOUT_MS = 2147483647;

// WHY: the time budget is cooperative — it stops the workflow only at a checkpoint. This
// multiplier arms the sandbox's own deadline as a sanity safeguard at twice the budget, so a
// hung host call or a spin loop still dies instead of hanging forever.
// Contract-visible factor; the rule is in docs/workflows.md (Targets, exit, cancellation, salvage).
export const HARD_DEADLINE_FACTOR = 2;

/** Largest time budget whose derived hard deadline still fits the sandbox timer range. */
export const MAX_TIME_BUDGET_MS = Math.floor(MAX_TIMEOUT_MS / HARD_DEADLINE_FACTOR);

/** Finite positive values clamp to Node's timer range; anything else is an explicit no-limit. */
export function clampTimeoutMs(ms: number): number {
	if (!Number.isFinite(ms) || ms <= 0) return Number.POSITIVE_INFINITY;
	return Math.min(ms, MAX_TIMEOUT_MS);
}

/** Sanity deadline for the sandbox. An explicit `hardDeadlineMs` (checkpoint-less runs) wins;
 * otherwise the deadline derives from twice the soft budget. No valid input disables it. */
export function hardDeadlineMs(limits: Pick<WorkflowLimits, "timeBudgetMs" | "hardDeadlineMs">): number {
	const explicit = limits.hardDeadlineMs;
	if (explicit !== null && explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return clampTimeoutMs(explicit);
	const budget = limits.timeBudgetMs;
	if (budget === null || !Number.isFinite(budget) || budget <= 0) return Number.POSITIVE_INFINITY;
	return clampTimeoutMs(budget * HARD_DEADLINE_FACTOR);
}

/** Clamp only an explicit deadline; `undefined` keeps pi-codemode's default. */
function withClampedTimeout(options: CodemodeSandboxOptions): CodemodeSandboxOptions {
	if (typeof options.timeoutMs !== "number") return options;
	return { ...options, timeoutMs: clampTimeoutMs(options.timeoutMs) };
}

/** Process-isolated e2e hosts cannot inject command deps; this seam gates the real sandbox.
 * The e2e harness spawns one process per test, so a set fake never leaks past that process.
 * WHY registeredState: jiti double-loads this module (moduleCache:false), so a module-global
 * would fork per copy and silently drop the fake; a Symbol.for slot is shared by every copy. */
const TEST_SANDBOX = registeredState<{ factory: WorkflowSandboxFactory | null }>("pi-schematic.workflow-sandbox-factory-for-tests", () => ({ factory: null }));

export function setSandboxFactoryForTests(factory: WorkflowSandboxFactory | null): void {
	TEST_SANDBOX.factory = factory;
}

/** Build the sandbox. Tests inject a factory; production uses the real CodemodeSandbox. */
export function createWorkflowSandbox(options: CodemodeSandboxOptions, factory?: WorkflowSandboxFactory): CodemodeSandbox {
	const build = factory ?? TEST_SANDBOX.factory ?? ((opts: CodemodeSandboxOptions) => new CodemodeSandbox(opts));
	return build(withClampedTimeout(options));
}
