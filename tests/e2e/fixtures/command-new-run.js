// command-new-run.js — replace the session, then run a turn through the replacement
// runtime. The run registry must re-subscribe so workflow.run still resolves.
return defineWorkflow((workflow) => {
	workflow.new();
	const result = workflow.run("plain prompt");
	workflow.checkpoint({});
	return workflow.exit({ reason: "ok", text: result.text });
});
