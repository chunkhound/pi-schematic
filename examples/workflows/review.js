// TEMPLATE ONLY — the compile guard checks this file but does not run it (it needs a live classifier).
// Illustrative — docs/workflows.md is authoritative on the contract.
// Replace <provider> / <classifier-model> with your classifier model before use.
// review.js — the smallest round loop: classify a review verdict, plan the fixes, execute them,
// and stop on approval, failing tests, or budget exhaustion. See gate-then-loop.js for the
// production shape (baseline gate and per-round context reset).
//
// A `bool` classifier answer is `{ type: "bool", probability: number }`. It has no
// `probabilities` map and no `confidence`; read `answers.approve.probability`.
// `/review-worktree` and `/execute` are project prompt templates or skills.
return defineWorkflow((workflow) => {
  // Resolve the project's test command once in readonly mode, then gate the loop on a green baseline.
  // A requested `output` rejects when the model never calls the output tool.
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
        instructions: "Return the single command that runs the project's full test suite; do not run it.",
      },
    });
    // `output` is untyped here: narrow before reading fields so a non-object response cannot throw.
    const detectedOutput = typeof detected.output === "object" && detected.output !== null ? detected.output : null;
    testCommand = detectedOutput && typeof detectedOutput.command === "string" ? detectedOutput.command.trim() : null;
  } catch {
    // Fall through to the shared exit below: readonly must be restored first.
    testCommand = null;
  }
  // Restore write posture before any exit after the readonly detection run.
  workflow.readonly(false);
  if (!testCommand) return workflow.exit({ reason: "test-command-unknown" });

  const baseline = workflow.shell(testCommand);
  if (!baseline.ok) return workflow.exit({ reason: "baseline-tests-failing", output: baseline.output });
  // Safe exit point: a pending cost or time stop lands here and salvages this metadata.
  workflow.checkpoint({ phase: "baseline", cmd: testCommand });

  for (let round = 0; round < 10; round++) {
    const review = workflow.run("/review-worktree", { args: load("intent") }); // codemode store set by the workflow command
    const verdict = workflow.classify({
      model: { provider: "<provider>", id: "<classifier-model>" }, // replace with your classifier model
      state: { review: review.text },
      questions: {
        approve: {
          type: "bool",
          instructions: "Does the review approve the changeset?",
          criteria: { true: "No required changes", false: "At least one required fix" },
        },
      },
    });
    if (verdict.stopReason !== "stop") return workflow.exit({ reason: "classifier-error", error: verdict.errorMessage });
    if (verdict.answers.approve.probability >= 0.85) return workflow.exit({ reason: "approved" });

    const findings = workflow.entries({ after: review.fromEntryId });
    // The plan is an inline prompt; /execute is a project skill.
    workflow.run("Plan the needed fixes. List each fix and its file. Do not edit.", { input: findings });
    workflow.run("/execute");

    const tests = workflow.shell(testCommand);
    if (!tests.ok) return workflow.exit({ reason: "tests-failing", output: tests.output });

    const budget = workflow.budget();
    // A null remainder means "no target"; null-check before `<= 0` (null <= 0 is true in JS).
    if ((budget.costRemaining != null && budget.costRemaining <= 0) || (budget.timeRemainingMs != null && budget.timeRemainingMs <= 0)) return workflow.exit({ reason: "budget-exhausted" });
    workflow.handoff("Next round: review the repaired tree.");
    workflow.checkpoint({ round, approved: verdict.answers.approve.probability });
  }
  return workflow.exit({ reason: "round-limit" });
});
