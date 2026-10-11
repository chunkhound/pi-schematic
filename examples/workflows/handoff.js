// handoff.js — exercises `workflow.handoff`: compact the context, settle the
// successor, then continue the run to a normal exit.
return defineWorkflow((workflow) => {
  workflow.handoff("continue the resumed work");
  workflow.checkpoint({ phase: "resumed" });
  return workflow.exit({ reason: "ok" });
});
