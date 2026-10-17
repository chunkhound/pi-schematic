// host-preview.js — buffer one notebook preview, then run once or twice so the tests can
// grade the composed prompt (preview fence, args, options.input), the consume-once rule, and
// the buffered-preview invariant when a run's override fails before dispatch.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	workflow.notebookWrite({ name: "findings", content: "first line\nsecond line" });
	let first = null;
	let firstError = null;
	try {
		first = workflow.run(spec.first || "/review", spec.firstOptions);
	} catch (error) {
		firstError = String(error);
	}
	let second = null;
	if (spec.second !== undefined) second = workflow.run(spec.second, spec.secondOptions);
	workflow.checkpoint({ phase: "done" });
	return workflow.exit({ reason: "ok", first, firstError, second });
});
