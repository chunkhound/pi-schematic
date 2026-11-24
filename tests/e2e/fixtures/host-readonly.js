// host-readonly.js — drive the readonly posture so the tests can grade the notification and
// answer-widget refresh the workflow-driven toggle mirrors from /readonly.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	if (spec.both) {
		workflow.readonly(true);
		workflow.readonly(false);
	} else {
		workflow.readonly(spec.value);
	}
	workflow.checkpoint({ phase: "readonly" });
	return workflow.exit({ reason: "ok" });
});
