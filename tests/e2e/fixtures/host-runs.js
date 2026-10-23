// host-runs.js — run `count` turns, catching each failure, then exit with the per-run
// outcomes and the last result. Drives correlation, terminal-failure, and retry scenarios.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	const results = [];
	let last = null;
	let settledRuns = 0;
	for (let i = 0; i < (spec.count || 1); i++) {
		try {
			const run = workflow.run(spec.prompt || "/review", spec.options);
			results.push({ ok: true, text: run.text, from: run.fromEntryId, to: run.toEntryId, cost: run.usage.cost.total });
			last = run;
		} catch (error) {
			results.push({ ok: false, error: String(error) });
		}
		// Expose the run counter after a caught failure, so tests can pin what the workflow sees.
		settledRuns = workflow.state().settledRuns;
	}
	workflow.checkpoint({ phase: "done" });
	return workflow.exit({ reason: "ok", results, last, settledRuns });
});
