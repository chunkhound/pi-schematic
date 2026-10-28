// exit-workflow.js — the smallest real workflow: a safe exit point, then exit ok.
// Used by suites that grade the run's limits/dialog decisions, not the effects.
return defineWorkflow((workflow) => {
	workflow.checkpoint({ phase: "ready" });
	return workflow.exit({ reason: "ok" });
});
