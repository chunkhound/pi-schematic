// WHY: the coordinator is the only module that bridges a long-running command and a
// fresh post-replacement runtime. These tests pin the reservation semantics
// (single exclusive claim, idempotent release) and the per-session binding isolation
// that let a still-running workflow rebind after a session replacement.
import { expect, test } from "vitest";
import type { WorkflowRuntimeBinding } from "../../workflow/coordinator.js";
import { discardWorkflowRuntime, publishWorkflowRuntime, releaseWorkflow, reserveWorkflow, takeWorkflowRuntime } from "../../workflow/coordinator.js";

/** Minimal binding — tests only assert registry identity, never invoke these. */
function fakeBinding(): WorkflowRuntimeBinding {
	return {
		pi: undefined as never,
		state: undefined as never,
		rebindDeps: (current) => current,
	};
}

/** Reset the process-wide registry so tests don't leak state. */
function resetRegistry(): void {
	releaseWorkflow();
	// Drain any sessions published by prior tests.
	for (const session of ["a", "b", "x", "z"]) {
		discardWorkflowRuntime(session);
	}
}

test("reserveWorkflow claims the single workflow reservation", () => {
	resetRegistry();
	expect(reserveWorkflow()).toBe(true);
	releaseWorkflow();
});

test("reserveWorkflow returns false when already reserved (reservation race)", () => {
	resetRegistry();
	expect(reserveWorkflow()).toBe(true);
	expect(reserveWorkflow(), "second claim must fail while the first is live").toBe(false);
	expect(reserveWorkflow(), "a third claim is just as rejected").toBe(false);
	releaseWorkflow();
	expect(reserveWorkflow(), "claimable again after release").toBe(true);
	releaseWorkflow();
});

test("releaseWorkflow is idempotent: double-release is a no-op, not an error", () => {
	resetRegistry();
	reserveWorkflow();
	releaseWorkflow();
	expect(() => {
		releaseWorkflow();
	}).not.toThrow();
	expect(reserveWorkflow(), "reservation is available after double-release").toBe(true);
	releaseWorkflow();
});

test("runtime bindings are isolated per session id (cross-session isolation)", () => {
	resetRegistry();
	const bindingA = fakeBinding();
	const bindingB = fakeBinding();
	publishWorkflowRuntime("session-a", bindingA);
	publishWorkflowRuntime("session-b", bindingB);
	// Each session sees only its own binding.
	expect(takeWorkflowRuntime("session-a")).toBe(bindingA);
	expect(takeWorkflowRuntime("session-b")).toBe(bindingB);
	// Already-taken sessions return null on a second take.
	expect(takeWorkflowRuntime("session-a")).toBeNull();
	expect(takeWorkflowRuntime("session-b")).toBeNull();
	// Unknown sessions have nothing.
	expect(takeWorkflowRuntime("session-c")).toBeNull();
});

test("takeWorkflowRuntime is consume-once: a second take returns null", () => {
	resetRegistry();
	const binding = fakeBinding();
	publishWorkflowRuntime("session-x", binding);
	expect(takeWorkflowRuntime("session-x")).toBe(binding);
	expect(takeWorkflowRuntime("session-x"), "binding must be consumed").toBeNull();
});

test("discardWorkflowRuntime removes a binding without consuming it for take", () => {
	resetRegistry();
	publishWorkflowRuntime("session-z", fakeBinding());
	discardWorkflowRuntime("session-z");
	expect(takeWorkflowRuntime("session-z"), "discarded session has no binding").toBeNull();
});

test("discarding one session does not affect another session's binding", () => {
	resetRegistry();
	const keep = fakeBinding();
	publishWorkflowRuntime("keep-session", keep);
	publishWorkflowRuntime("drop-session", fakeBinding());
	discardWorkflowRuntime("drop-session");
	expect(takeWorkflowRuntime("keep-session"), "untouched session still has its binding").toBe(keep);
	expect(takeWorkflowRuntime("drop-session"), "dropped session is gone").toBeNull();
});

test("workflow reservation and runtime bindings are independent", () => {
	resetRegistry();
	const binding = fakeBinding();
	publishWorkflowRuntime("indep", binding);
	expect(reserveWorkflow(), "reserving the workflow does not consume a runtime binding").toBe(true);
	expect(takeWorkflowRuntime("indep"), "binding still present while reserved").toBe(binding);
	releaseWorkflow();
	expect(takeWorkflowRuntime("indep"), "binding consumed after release (consume-once)").toBeNull();
});
