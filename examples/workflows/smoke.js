// smoke.js — the smallest real workflow: one shell call, then exit.
// Workflows are synchronous JavaScript; the compiler awaits every workflow.* call.
return defineWorkflow((workflow) => {
  const probe = workflow.shell("echo smoke");
  workflow.checkpoint({ output: probe.output });
  return workflow.exit({
    reason: probe.ok ? "ok" : "shell-failed",
    output: probe.output,
  });
});
