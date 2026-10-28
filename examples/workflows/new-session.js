// new-session.js — replace the session mid-workflow, then exit.
// Exercises `workflow.new` → `ctx.newSession({ withSession })` → host rebind.
return defineWorkflow((workflow) => {
  workflow.new();
  workflow.checkpoint({ phase: "rebound" });
  return workflow.exit({ reason: "ok" });
});
