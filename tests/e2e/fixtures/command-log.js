// command-log.js — console.log must fold into exactly one workflow-log entry.
return defineWorkflow((workflow) => {
	console.log("hello workflow log");
	workflow.checkpoint({});
	return workflow.exit({ reason: "ok" });
});
