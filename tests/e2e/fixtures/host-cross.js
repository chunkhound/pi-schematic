// host-cross.js — checkpoint first, then a run that crosses the cost target, then shell
// effects. Drives the hard-abort salvage: the last checkpoint metadata survives the escalation.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	workflow.checkpoint(spec.checkpoint);
	workflow.run("spend");
	for (let i = 0; i < (spec.count || 0); i++) workflow.shell("echo " + i);
	return workflow.exit({ reason: "ok" });
});
