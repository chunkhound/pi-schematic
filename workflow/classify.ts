// WHY: `workflow.classify` must never reject, so a missing model becomes a normal
// ClassifierResult with stopReason "error". The host charges usage cost separately
// because the read-only session manager cannot append a usage entry.
import type { ClassifierAnswer, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierQuestion, ClassifierResult } from "@earendil-works/pi-ai";
import { messageOf } from "./errors.js";
import type { ClassifierRequest } from "./types.js";

/** Runtime discriminators pinned to the pi-ai unions. The docs test compares the author
 * contract in docs/workflows.md to these arrays, so a pi-ai change fails visibly. */
export const CLASSIFIER_QUESTION_TYPES = ["choice", "score", "bool"] as const satisfies readonly ClassifierQuestion["type"][];
export const CLASSIFIER_ANSWER_TYPES = ["choice", "score", "bool"] as const satisfies readonly ClassifierAnswer["type"][];
export const CLASSIFIER_STOP_REASONS = ["stop", "error", "aborted"] as const satisfies readonly ClassifierResult["stopReason"][];

export interface ClassifierDeps {
	getModels: () => readonly ClassifierModel<ClassifierApi>[];
	classify: (
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options: { signal?: AbortSignal },
	) => Promise<ClassifierResult>;
}

export function findClassifierModel(
	models: readonly ClassifierModel<ClassifierApi>[],
	ref: { provider: string; id: string },
): ClassifierModel<ClassifierApi> | undefined {
	return models.find((model) => model.provider === ref.provider && model.id === ref.id);
}

export function classifierErrorResult(ref: { provider: string; id: string }, message: string): ClassifierResult {
	return {
		api: "unknown",
		provider: ref.provider,
		model: ref.id,
		answers: {},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

export async function classifyRequest(
	deps: ClassifierDeps,
	request: ClassifierRequest,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const ref = modelRef(request?.model);
	if (!ref) return classifierErrorResult({ provider: "unknown", id: "unknown" }, "classify request requires model.provider and model.id");
	if (!request.questions || typeof request.questions !== "object")
		return classifierErrorResult(ref, "classify request requires a questions object");
	const model = findClassifierModel(deps.getModels(), ref);
	if (!model) return classifierErrorResult(ref, `classifier model not found: ${ref.provider}/${ref.id}`);
	return runClassifier(deps, ref, model, request, signal);
}

/**
 * Contract: classify never rejects. Provider failures and cancellation become a normal
 * result so the run keeps control of its own exit condition instead of aborting the workflow.
 * The per-call signal (sandbox timeout, script end, host abort) stops in-flight provider work.
 */
async function runClassifier(
	deps: ClassifierDeps,
	ref: { provider: string; id: string },
	model: ClassifierModel<ClassifierApi>,
	request: ClassifierRequest,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	if (signal?.aborted) return classifierAbortedResult(ref, "classify aborted before start");
	try {
		return await deps.classify(
			model,
			{ state: request.state as ClassifierContext["state"], questions: request.questions },
			{ signal },
		);
	} catch (error) {
		const message = messageOf(error);
		return signal?.aborted ? classifierAbortedResult(ref, message) : classifierErrorResult(ref, message);
	}
}

/** Aborted twin of the error result: same shape, but the run ended before any provider work. */
export function classifierAbortedResult(ref: { provider: string; id: string }, message: string): ClassifierResult {
	return { ...classifierErrorResult(ref, message), stopReason: "aborted" };
}

/** Parse the untrusted JSON model reference the workflow supplied. */
function modelRef(value: unknown): { provider: string; id: string } | null {
	const ref = value as { provider?: unknown; id?: unknown } | null | undefined;
	if (!ref || typeof ref.provider !== "string" || typeof ref.id !== "string") return null;
	return { provider: ref.provider, id: ref.id };
}
