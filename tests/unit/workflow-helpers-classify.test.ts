// Pure classifier helpers. `classifyRequest` takes its provider boundary as injected
// deps, so these tests supply plain functions at that seam and never reach a real model.
import { expect, test } from "vitest";
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { classifierAbortedResult, classifierErrorResult, classifyRequest, findClassifierModel, type ClassifierDeps } from "../../workflow/classify.js";
import type { ClassifierRequest } from "../../workflow/types.js";

const ref = { provider: "typesafe", id: "jev" };
const model = { provider: "typesafe", id: "jev", api: "system-one" } as unknown as ClassifierModel<ClassifierApi>;
const otherModel = { provider: "typesafe", id: "other", api: "system-one" } as unknown as ClassifierModel<ClassifierApi>;

function withoutTimestamp(result: ClassifierResult): Omit<ClassifierResult, "timestamp"> {
	const { timestamp, ...rest } = result;
	expect(typeof timestamp, "timestamp is a number").toBe("number");
	return rest;
}

function fakeDeps(classify: ClassifierDeps["classify"], models = [model, otherModel]): ClassifierDeps {
	return { getModels: () => models, classify };
}

const neverCalled: ClassifierDeps["classify"] = async () => {
	throw new Error("the provider must not be reached");
};

test("classifierErrorResult carries the requested ref, an empty answer map, and the message", () => {
	expect(withoutTimestamp(classifierErrorResult(ref, "boom"))).toStrictEqual({
		api: "unknown",
		provider: "typesafe",
		model: "jev",
		answers: {},
		stopReason: "error",
		errorMessage: "boom",
	});
});

test("classifierAbortedResult differs from the error result only in its stop reason", () => {
	const error = withoutTimestamp(classifierErrorResult(ref, "cancelled"));
	const aborted = withoutTimestamp(classifierAbortedResult(ref, "cancelled"));
	expect(aborted.stopReason).toBe("aborted");
	expect({ ...aborted, stopReason: "error" }).toStrictEqual(error);
});

test("findClassifierModel matches on both provider and id", () => {
	expect(findClassifierModel([model, otherModel], { provider: "typesafe", id: "other" })).toBe(otherModel);
	expect(findClassifierModel([model], { provider: "elsewhere", id: "jev" })).toBeUndefined();
	expect(findClassifierModel([model], { provider: "typesafe", id: "missing" })).toBeUndefined();
});

test("classifyRequest turns a malformed model ref into an error result without reaching the provider", async () => {
	for (const request of [{ questions: {} }, { model: { provider: "typesafe" }, questions: {} }, { model: null, questions: {} }]) {
		const result = await classifyRequest(fakeDeps(neverCalled), request as never);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("classify request requires model.provider and model.id");
	}
});

test("classifyRequest rejects a non-object questions value without reaching the provider", async () => {
	const result = await classifyRequest(fakeDeps(neverCalled), { model: ref, state: {}, questions: null as never });
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe("classify request requires a questions object");
	expect(result.provider).toBe("typesafe");
	expect(result.model).toBe("jev");
});

test("classifyRequest reports an unknown model by its requested ref", async () => {
	const result = await classifyRequest(fakeDeps(neverCalled, []), { model: ref, state: {}, questions: {} });
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe("classifier model not found: typesafe/jev");
	expect(result.model).toBe("jev");
});

test("classifyRequest hands the provider its state, questions, and the call signal", async () => {
	const controller = new AbortController();
	const seen: unknown[] = [];
	const providerResult: ClassifierResult = {
		api: "system-one",
		provider: "typesafe",
		model: "jev",
		answers: {},
		stopReason: "stop",
		timestamp: 0,
	};
	const deps = fakeDeps(async (picked, context, options) => {
		seen.push(picked, context, options.signal);
		return providerResult;
	});
	const questions = { approve: { type: "bool" } } as unknown as ClassifierRequest["questions"];
	const result = await classifyRequest(deps, { model: ref, questions, state: { step: 1 } }, controller.signal);
	expect(result).toBe(providerResult);
	expect(seen).toStrictEqual([model, { state: { step: 1 }, questions }, controller.signal]);
});

test("classifyRequest converts a rejecting provider into an error result instead of rejecting", async () => {
	const deps = fakeDeps(async () => {
		throw new Error("rate limited");
	});
	const result = await classifyRequest(deps, { model: ref, state: {}, questions: {} });
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe("rate limited");
});

test("classifyRequest returns aborted without reaching the provider when the signal already fired", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await classifyRequest(fakeDeps(neverCalled), { model: ref, state: {}, questions: {} }, controller.signal);
	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage).toBe("classify aborted before start");
});

test("classifyRequest maps a provider failure raised after the signal fired to aborted", async () => {
	const controller = new AbortController();
	const deps = fakeDeps(async () => {
		controller.abort();
		throw new Error("request cancelled");
	});
	const result = await classifyRequest(deps, { model: ref, state: {}, questions: {} }, controller.signal);
	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage).toBe("request cancelled");
});
