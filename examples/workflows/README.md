# Workflow examples

Workflow scripts for `/workflow <file>`. For the author contract, see [docs/workflows.md](../../docs/workflows.md). For the engine internals, see [docs/workflow-engine.md](../../docs/workflow-engine.md).

| File | Shows | Status |
|---|---|---|
| [smoke.js](smoke.js) | The smallest real workflow: one shell call, then exit. | Run in E2E (`tests/e2e/workflow.test.ts`). |
| [handoff.js](handoff.js) | `workflow.handoff` compacts, settles the successor, and continues. | Run in E2E. |
| [new-session.js](new-session.js) | `workflow.new` replaces the session mid-run, then exits. | Run in E2E. |
| [review.js](review.js) | The smallest round loop: classify a verdict, plan, execute, and stop on approval, failing tests, or budget. | Template only. Replace `<provider>`/`<classifier-model>` and provide the `/review-worktree` and `/execute` prompts. |
| [gate-then-loop.js](gate-then-loop.js) | The production shape: resolve the test command once, gate the loop on a green baseline, reset context between rounds, and checkpoint at salvage points. | Template only, same prompts as `review.js`. |

Every file here MUST satisfy the author contract. `tests/unit/workflow-examples.test.ts` compiles each one with the engine compiler and pins this file list, so an example cannot rot or drift unnoticed.
