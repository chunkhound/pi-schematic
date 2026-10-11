// WHY: the coordinator is the only module that bridges a long-running command and a
// fresh post-replacement runtime. These tests pin the reservation semantics
// (single exclusive claim, idempotent release) and the per-session binding isolation
// that let a still-running workflow rebind after a session replacement.
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRuntimeBinding } from "../../workflow/coordinator.js";
import {
	discardWorkflowRuntime,
	publishWorkflowRuntime,
	releaseWorkflow,
	reserveWorkflow,
	takeWorkflowRuntime,
} from "../../workflow/coordinator.js";

/** Minimal binding — tests only assert registry identity, never invoke these. */
function fakeBinding(): WorkflowRuntimeBinding {
	return {
		pi: undefined as never,
		state: undefined as never,
		setReadonly: () => false,
		requestHandoff: async () => {},
		prepareRunFrontmatter: async () => {},
	};
}

/** Reset the process-wide registry so tests don't leak state. */
function resetRegistry(): void {
	releaseWorkflow();
	// Drain any sessions published by prior tests.
	for (const session of ["a", "b", "x", "z"]) discardWorkflowRuntime(session);
}

test("reserveWorkflow claims the single workflow reservation", () => {
	resetRegistry();
	assert.equal(reserveWorkflow(), true);
	releaseWorkflow();
});

test("reserveWorkflow returns false when already reserved (reservation race)", () => {
	resetRegistry();
	assert.equal(reserveWorkflow(), true);
	assert.equal(reserveWorkflow(), false, "second claim must fail while the first is live");
	assert.equal(reserveWorkflow(), false, "a third claim is just as rejected");
	releaseWorkflow();
	assert.equal(reserveWorkflow(), true, "claimable again after release");
	releaseWorkflow();
});

test("releaseWorkflow is idempotent: double-release is a no-op, not an error", () => {
	resetRegistry();
	reserveWorkflow();
	releaseWorkflow();
	assert.doesNotThrow(() => releaseWorkflow(), "second release must not throw");
	assert.equal(reserveWorkflow(), true, "reservation is available after double-release");
	releaseWorkflow();
});

test("runtime bindings are isolated per session id (cross-session isolation)", () => {
	resetRegistry();
	const bindingA = fakeBinding();
	const bindingB = fakeBinding();
	publishWorkflowRuntime("session-a", bindingA);
	publishWorkflowRuntime("session-b", bindingB);
	// Each session sees only its own binding.
	assert.equal(takeWorkflowRuntime("session-a"), bindingA);
	assert.equal(takeWorkflowRuntime("session-b"), bindingB);
	// Already-taken sessions return null on a second take.
	assert.equal(takeWorkflowRuntime("session-a"), null);
	assert.equal(takeWorkflowRuntime("session-b"), null);
	// Unknown sessions have nothing.
	assert.equal(takeWorkflowRuntime("session-c"), null);
});

test("takeWorkflowRuntime is consume-once: a second take returns null", () => {
	resetRegistry();
	const binding = fakeBinding();
	publishWorkflowRuntime("session-x", binding);
	assert.equal(takeWorkflowRuntime("session-x"), binding);
	assert.equal(takeWorkflowRuntime("session-x"), null, "binding must be consumed");
});

test("discardWorkflowRuntime removes a binding without consuming it for take", () => {
	resetRegistry();
	publishWorkflowRuntime("session-z", fakeBinding());
	discardWorkflowRuntime("session-z");
	assert.equal(takeWorkflowRuntime("session-z"), null, "discarded session has no binding");
});

test("discarding one session does not affect another session's binding", () => {
	resetRegistry();
	const keep = fakeBinding();
	publishWorkflowRuntime("keep-session", keep);
	publishWorkflowRuntime("drop-session", fakeBinding());
	discardWorkflowRuntime("drop-session");
	assert.equal(takeWorkflowRuntime("keep-session"), keep, "untouched session still has its binding");
	assert.equal(takeWorkflowRuntime("drop-session"), null, "dropped session is gone");
});

test("workflow reservation and runtime bindings are independent", () => {
	resetRegistry();
	const binding = fakeBinding();
	publishWorkflowRuntime("indep", binding);
	assert.equal(reserveWorkflow(), true, "reserving the workflow does not consume a runtime binding");
	assert.equal(takeWorkflowRuntime("indep"), binding, "binding still present while reserved");
	releaseWorkflow();
	assert.equal(takeWorkflowRuntime("indep"), null, "binding consumed after release (consume-once)");
});
