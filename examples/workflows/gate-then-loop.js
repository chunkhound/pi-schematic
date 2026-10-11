// TEMPLATE ONLY — the compile guard checks this file but does not run it (it needs a live classifier).
// Illustrative — docs/workflows.md is authoritative on the contract.
// Replace <provider> / <classifier-model>. /review-worktree and /execute are prompt templates or skills.
//
// gate-then-loop.js — the production shape: resolve the test command once, gate the loop on a
// green baseline, then review → classify → fix → test each round, resetting context between rounds.
//
// Prelude: detect the command with a structured run in readonly, drop readonly, run the baseline.
// A detection failure or a red baseline exits before any review round spends budget, and the
// resolved command is reused every round. Round: review → classify verdict → (plan fixes →
// execute) → test. Stop on approval, failing tests, or the round cap. A cost or time limit defers
// to the next workflow.checkpoint(...), which salvages that metadata. Cancellation and errors stop
// at once.
return defineWorkflow((workflow) => {
  const CLASSIFIER = { provider: "<provider>", id: "<classifier-model>" };
  const MAX_ROUNDS = 10;

  workflow.new();

  // Resolve the test command once, in readonly. `output` is requested, so the run either returns
  // the object or rejects; a rejection means no command, so no iteration.
  workflow.readonly(true);
  let testCommand = null;
  try {
    const detected = workflow.run("Explain how to run the test suite of this project", {
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["command"],
          properties: { command: { type: "string" } },
        },
        instructions:
          "Return the single command that runs the project's full test suite from the repo root; do not run it.",
      },
    });
    const out = detected.output;
    testCommand = out && typeof out.command === "string" && out.command.trim() ? out.command.trim() : null;
  } catch {
    return workflow.exit({ reason: "test-command-unknown" });
  }
  if (!testCommand) return workflow.exit({ reason: "test-command-unknown" });

  // Baseline gate: prove the command before review spends a round. The suite may write (caches,
  // artifacts), so drop the detection run's readonly posture first.
  workflow.readonly(false);
  const baseline = workflow.shell(testCommand);
  if (!baseline.ok)
    return workflow.exit({ reason: "baseline-tests-failing", exitCode: baseline.exitCode, output: baseline.output });

  // Safe exit point: a pending limit stops here and salvages the resolved command.
  workflow.checkpoint({ phase: "baseline", testCommand });

  // Start round 0 from a clean context so detection and the baseline log do not bias review.
  workflow.new();

  let outcome = { reason: "round-limit", rounds: MAX_ROUNDS };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const review = workflow.run("/review-worktree", { args: load("intent") });

    const verdict = workflow.classify({
      model: CLASSIFIER,
      state: { review: review.text },
      questions: {
        verdict: {
          type: "choice",
          instructions: "Classify the review verdict for the changeset under review.",
          criteria: {
            Approve: "No required changes; the changeset is safe to commit.",
            "Approve with changes": "Only non-blocking suggestions; no required fix.",
            "Required changes": "At least one blocking fix is required.",
          },
        },
      },
    });
    if (verdict.stopReason !== "stop") {
      outcome = { reason: "classifier-error", error: verdict.errorMessage };
      break;
    }
    if (verdict.answers.verdict.choice === "Approve") {
      outcome = { reason: "approved", round };
      break;
    }

    // The review turn's findings are already in context; the plan reads them there.
    workflow.run("Plan the needed fixes");
    workflow.run("/execute");

    const tests = workflow.shell(testCommand);
    if (!tests.ok) {
      outcome = { reason: "tests-failing", exitCode: tests.exitCode, output: tests.output };
      break;
    }

    // Each round starts from a clean context so repaired-tree review is unbiased.
    if (round < MAX_ROUNDS - 1) workflow.new();

    // Safe exit point: a pending limit stops here, salvaging the outcome.
    workflow.checkpoint(`Round ${round + 1}`);
  }

  return workflow.exit(outcome);
});
