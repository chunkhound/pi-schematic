// host-echo.js — dispatch one host handle named in `load("intent")` and exit with its
// result. Drives the host-level E2E scenarios from the transcript alone.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	let result;
	// Optional in-run spend: run cost is scoped from run start, so tests generate
	// spend with a scripted turn consumed here instead of pre-run seeds.
	if (spec.spend) workflow.run("spend");
	if (spec.handle === "budget") result = workflow.budget();
	else if (spec.handle === "state") result = workflow.state();
	else if (spec.handle === "entries") result = workflow.entries(spec.options || {});
	else if (spec.handle === "readonly") result = workflow.readonly(spec.value);
	else if (spec.handle === "classify") result = workflow.classify(spec.classify);
	else if (spec.handle === "run") {
		result = workflow.run(spec.prompt, spec.options);
		// `trace` exposes real branch ids so a test can pin the run span endpoints.
		if (spec.trace) result.trace = workflow.entries();
	}
	else if (spec.handle === "shell") result = workflow.shell(spec.command);
	else if (spec.handle === "checkpoint") result = workflow.checkpoint(spec.metadata);
	else if (spec.handle === "exit") return workflow.exit(spec.metadata);
	workflow.checkpoint({ phase: "done" });
	return workflow.exit({ reason: "ok", result });
});
