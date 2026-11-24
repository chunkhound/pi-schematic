// Classifier contract exercised through the public `workflow.classify` handle
// (createWorkflowHost seam); no workflow-internal imports.
import { expect, test } from "vitest";
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { createState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import type { WorkflowHost, WorkflowHostDeps } from "../../workflow/types.js";

const model = {
	id: "jev",
	name: "jev",
	api: "system-one",
	provider: "typesafe",
	baseUrl: "https://example.test",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	type: "classifier",
	contextWindow: 1000,
} as unknown as ClassifierModel<ClassifierApi>;

function makeResult(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	return {
		api: "system-one",
		provider: "typesafe",
		model: "jev",
		answers: { approve: { type: "bool", probability: 0.9 } },
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/** Fake registry boundary: the workflow only ever sees ctx.modelRegistry, never our internals. */
function classifyHost(
	classify: (model: ClassifierModel<ClassifierApi>, context: unknown, options: { signal?: AbortSignal }) => Promise<ClassifierResult>,
	models: ClassifierModel<ClassifierApi>[] = [model],
): {
	host: WorkflowHost;
	call: (request: unknown, signal?: AbortSignal) => Promise<ClassifierResult>;
	seen: { model: unknown; context: unknown; signal: unknown };
} {
	const seen: { model: unknown; context: unknown; signal: unknown } = { model: undefined, context: undefined, signal: undefined };
	const ctx = {
		cwd: "/workspace",
		sessionManager: { getSessionId: () => "s", getLeafId: () => null, getBranch: () => [] },
		getContextUsage: () => undefined,
		modelRegistry: {
			getModelsOfType: (type: string) => (type === "classifier" ? models : []),
			classify: async (seenModel: ClassifierModel<ClassifierApi>, context: unknown, options: { signal?: AbortSignal }) => {
				seen.model = seenModel;
				seen.context = context;
				seen.signal = options.signal;
				return classify(seenModel, context, options);
			},
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
	const deps: WorkflowHostDeps = {
		pi: { appendEntry: () => {} } as unknown as WorkflowHostDeps["pi"],
		state: createState(),
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		getCtx: () => ctx,
		setReadonly: (enabled: boolean) => enabled,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
	const host = createWorkflowHost(deps);
	const tool = host.globals().find((candidate) => candidate.name === "workflow.classify");
	if (!tool) {
		throw new Error("missing handle: workflow.classify");
	}
	const execute = tool.execute.bind(tool) as (args: unknown, context: unknown) => Promise<ClassifierResult>;
	// The signal rides the execute context, exactly as the sandbox supplies it.
	return { host, call: (request: unknown, signal?: AbortSignal) => execute(request, { signal }), seen };
}

test("workflow.classify routes the requested model ref and passes state plus questions", async () => {
	const questions = { approve: { type: "bool", instructions: "?", criteria: { true: "yes", false: "no" } } };
	const { call, seen } = classifyHost(async () => makeResult());
	const result = await call({ model: { provider: "typesafe", id: "jev" }, state: { review: "ok" }, questions });
	expect(result.stopReason).toBe("stop");
	expect(seen.model, "the registry's matching classifier model is passed through").toBe(model);
	expect(seen.context).toStrictEqual({ state: { review: "ok" }, questions });
});

// A mismatch on either side of the ref misses: the requested ref is echoed back in the
// error result, so the workflow sees which classifier it asked for and never got.
test("workflow.classify reports a missing classifier model as an error result carrying the requested ref", async () => {
	const { call } = classifyHost(async () => makeResult(), []);
	for (const ref of [
		{ provider: "typesafe", id: "other" },
		{ provider: "other", id: "jev" },
	]) {
		const result = await call({ model: ref, state: {}, questions: {} });
		expect(result.stopReason).toBe("error");
		expect(result.provider).toBe(ref.provider);
		expect(result.model).toBe(ref.id);
		expect(result.errorMessage ?? "").toMatch(new RegExp(`${ref.provider}/${ref.id}`));
		expect(result.answers).toStrictEqual({});
	}
});

test("workflow.classify converts a rejecting provider into a stopReason error, never throws", async () => {
	const { call } = classifyHost(async () => {
		throw new Error("provider down");
	});
	const result = await call({ model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} });
	expect(result.stopReason).toBe("error");
	expect(result.answers).toStrictEqual({});
	expect(result.errorMessage ?? "").toMatch(/provider down/);
});

test("workflow.classify returns an aborted result without calling the provider when the signal already fired", async () => {
	const { call, seen } = classifyHost(async () => makeResult());
	const controller = new AbortController();
	controller.abort();
	const result = await call({ model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} }, controller.signal);
	expect(seen.model, "the provider is never called").toBeUndefined();
	expect(result.stopReason).toBe("aborted");
});

// A provider cancelled through the run's own signal (host abort or timeout) rejects with
// the signal already fired: the mapping must read aborted, not error.
test("workflow.classify maps a cancellation rejection to stopReason aborted, never throws", async () => {
	const controller = new AbortController();
	const { call } = classifyHost(async () => {
		controller.abort();
		throw new Error("aborted");
	});
	const result = await call({ model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} }, controller.signal);
	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage ?? "").toMatch(/aborted/);
});

// Design: "An answer mirrors its question's criteria: a choice answer keys `probabilities`
// by the criteria labels, a score answer returns `score`, and a bool answer returns a
// single `probability`." The raw provider response → ClassifierResult conversion lives in
// pi-ai (ctx.modelRegistry.classify, api/system-one-shared); the repo-owned boundary is
// the handle, which must forward criteria labels out and answers back unchanged.
async function classifyFixture(): Promise<{ result: ClassifierResult; seen: { model: unknown; context: unknown; signal: unknown } }> {
	const questions = {
		verdict: { type: "choice", instructions: "pick", criteria: { blocker: "must fix", nit: "nice to have" } },
		safety: { type: "score", instructions: "rate", criteria: ["low risk", "high risk"] },
		approve: { type: "bool", instructions: "ok?", criteria: { true: "no required changes", false: "at least one fix" } },
	};
	// Realistic pi-ai output: one answer per question, each mirroring its question's criteria.
	const providerResult: ClassifierResult = {
		api: "system-one",
		provider: "typesafe",
		model: "jev",
		answers: {
			verdict: { type: "choice", choice: "blocker", probabilities: { blocker: 0.7, nit: 0.3 }, confidence: 0.7 },
			safety: { type: "score", score: 4, confidence: 0.6 },
			approve: { type: "bool", probability: 0.92 },
		},
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	const { call, seen } = classifyHost(async () => providerResult);
	const result = await call({ model: { provider: "typesafe", id: "jev" }, state: { review: "diff" }, questions });
	return { result, seen };
}

test("workflow.classify forwards criteria labels verbatim and keys answers by question name", async () => {
	const { result, seen } = await classifyFixture();
	// Labels reach the provider verbatim: they are what `probabilities` gets keyed by.
	expect(seen.context && (seen.context as { questions: unknown }).questions).toStrictEqual({
		verdict: { type: "choice", instructions: "pick", criteria: { blocker: "must fix", nit: "nice to have" } },
		safety: { type: "score", instructions: "rate", criteria: ["low risk", "high risk"] },
		approve: { type: "bool", instructions: "ok?", criteria: { true: "no required changes", false: "at least one fix" } },
	});
	expect(Object.keys(result.answers).sort()).toStrictEqual(["approve", "safety", "verdict"]);
});

test("workflow.classify mirrors each criteria-shaped answer intact", async () => {
	const { result } = await classifyFixture();
	expect(result.answers).toStrictEqual({
		verdict: { type: "choice", choice: "blocker", probabilities: { blocker: 0.7, nit: 0.3 }, confidence: 0.7 },
		safety: { type: "score", score: 4, confidence: 0.6 },
		approve: { type: "bool", probability: 0.92 },
	});
	expect(result.answers.verdict).toStrictEqual({ type: "choice", choice: "blocker", probabilities: { blocker: 0.7, nit: 0.3 }, confidence: 0.7 });
	expect(result.answers.safety).toStrictEqual({ type: "score", score: 4, confidence: 0.6 });
	expect(result.answers.approve).toStrictEqual({ type: "bool", probability: 0.92 });
});

test("workflow.classify reports the provider stop and its usage", async () => {
	const { result } = await classifyFixture();
	expect(result.stopReason).toBe("stop");
	expect(result.usage?.cost.total, "usage rides the result so the run can charge it").toBe(0.03);
});

// The workflow branches on stopReason before reading answers, so a provider-reported
// error must arrive as a normal result — never a rejection, never stripped.
test("workflow.classify carries a provider stopReason error through with its answers and message", async () => {
	const providerResult: ClassifierResult = {
		api: "system-one",
		provider: "typesafe",
		model: "jev",
		answers: { approve: { type: "bool", probability: 0.1 } },
		stopReason: "error",
		errorMessage: "provider rejected the request",
		timestamp: 0,
	};
	const { call } = classifyHost(async () => providerResult);
	const result = await call({
		model: { provider: "typesafe", id: "jev" },
		state: {},
		questions: { approve: { type: "bool", instructions: "?", criteria: { true: "yes", false: "no" } } },
	});
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe("provider rejected the request");
	expect(result.answers).toStrictEqual(providerResult.answers);
});

// Host lifecycle contract: "classify never rejects" — a run that
// ends before classify still gets a normal aborted result with no provider work, and
// the run itself survives to reach its next checkpoint. Exercised through the real
// host handle, not a stub, because the guarantee lives in host.ts's wrapper.
function hostDeps(getCtx: () => unknown): WorkflowHostDeps {
	return {
		pi: { appendEntry: () => {} } as unknown as WorkflowHostDeps["pi"],
		state: createState(),
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		getCtx: getCtx as WorkflowHostDeps["getCtx"],
		setReadonly: (enabled: boolean) => enabled,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
}

test("classify after run end returns stopReason aborted, does not throw, run survives", async () => {
	const host = createWorkflowHost(hostDeps(() => null));
	host.dispose();
	const tool = host.globals().find((candidate) => candidate.name === "workflow.classify")!;
	const result = (await tool.execute({ model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} }, { signal: host.signal })) as ClassifierResult;
	expect(result.stopReason).toBe("aborted");
	expect(result.answers).toStrictEqual({});
	expect(result.errorMessage ?? "").toMatch(/disposed/);
	// The run survives: the host never records an exit or abort from a failed classify.
	expect(host.abortedReason()).toBeNull();
	expect(host.exitRecord()).toBeNull();
});

test("classify with no live session context returns stopReason aborted instead of throwing", async () => {
	const host = createWorkflowHost(hostDeps(() => null));
	const tool = host.globals().find((candidate) => candidate.name === "workflow.classify")!;
	const result = (await tool.execute({ model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} }, { signal: host.signal })) as ClassifierResult;
	expect(result.stopReason).toBe("aborted");
	expect(result.answers).toStrictEqual({});
	expect(result.errorMessage ?? "").toMatch(/no live session context/);
});
