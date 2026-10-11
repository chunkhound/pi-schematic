// host-new.js — replace the session (optionally around a run) so the tests can grade the
// baseline-fold rule: a successful new commits settled branch spend once; a failed one commits nothing.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	if (spec.double) {
		workflow.run("first");
		workflow.new();
		workflow.run("second");
	}
	workflow.new();
	workflow.checkpoint({ phase: "new" });
	return workflow.exit({ reason: "ok" });
});
