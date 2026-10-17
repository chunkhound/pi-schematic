// command-abort-run.js — a checkpoint-less run parked inside workflow.run, so an aborted
// turn (RPC/print abort) must cancel it through the turn_end bridge, with no TUI key funnel.
return defineWorkflow((workflow) => {
	const result = workflow.run("abort me");
	return workflow.exit({ reason: "ok", text: result.text });
});
