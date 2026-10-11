// command-arm-carry.js — a held shell parks the run so the test can arm the cancel funnel
// before workflow.new; a second held shell parks past the rebind for the fresh-funnel probes.
return defineWorkflow((workflow) => {
	workflow.shell("echo pre");
	workflow.new();
	workflow.shell("echo post");
	workflow.checkpoint({ phase: "rebound" });
	return workflow.exit({ reason: "ok" });
});
