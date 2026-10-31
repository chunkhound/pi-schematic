// Pure classifier helpers. `classifyRequest` takes its provider boundary as injected
// deps, so these tests supply plain functions at that seam and never reach a real model.
import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import {
	classifierAbortedResult,
	classifierErrorResult,
	classifyRequest,
	findClassifierModel,
	type ClassifierDeps,
} from "../../workflow/classify.js";
import type { ClassifierRequest } from "../../workflow/types.js";

const ref = { provider: "typesafe", id: "jev" };
const model = { provider: "typesafe", id: "jev", api: "system-one" } as unknown as ClassifierModel<ClassifierApi>;
const otherModel = { provider: "typesafe", id: "other", api: "system-one" } as unknown as ClassifierModel<ClassifierApi>;

function withoutTimestamp(result: ClassifierResult): Omit<ClassifierResult, "timestamp"> {
	const { timestamp, ...rest } = result;
	assert.equal(typeof timestamp, "number", "timestamp is a number");
	return rest;
}

function fakeDeps(classify: ClassifierDeps["classify"], models = [model, otherModel]): ClassifierDeps {
	return { getModels: () => models, classify };
}

const neverCalled: ClassifierDeps["classify"] = async () => {
	throw new Error("the provider must not be reached");
};

test("classifierErrorResult carries the requested ref, an empty answer map, and the message", () => {
	assert.deepEqual(withoutTimestamp(classifierErrorResult(ref, "boom")), {
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
	assert.equal(aborted.stopReason, "aborted");
	assert.deepEqual({ ...aborted, stopReason: "error" }, error);
});

test("findClassifierModel matches on both provider and id", () => {
	assert.equal(findClassifierModel([model, otherModel], { provider: "typesafe", id: "other" }), otherModel);
	assert.equal(findClassifierModel([model], { provider: "elsewhere", id: "jev" }), undefined);
	assert.equal(findClassifierModel([model], { provider: "typesafe", id: "missing" }), undefined);
});

test("classifyRequest turns a malformed model ref into an error result without reaching the provider", async () => {
	for (const request of [{ questions: {} }, { model: { provider: "typesafe" }, questions: {} }, { model: null, questions: {} }]) {
		const result = await classifyRequest(fakeDeps(neverCalled), request as never);
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "classify request requires model.provider and model.id");
	}
});

test("classifyRequest rejects a non-object questions value without reaching the provider", async () => {
	const result = await classifyRequest(fakeDeps(neverCalled), { model: ref, state: {}, questions: null as never });
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "classify request requires a questions object");
	assert.equal(result.provider, "typesafe");
	assert.equal(result.model, "jev");
});

test("classifyRequest reports an unknown model by its requested ref", async () => {
	const result = await classifyRequest(fakeDeps(neverCalled, []), { model: ref, state: {}, questions: {} });
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "classifier model not found: typesafe/jev");
	assert.equal(result.model, "jev");
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
	assert.equal(result, providerResult);
	assert.deepEqual(seen, [model, { state: { step: 1 }, questions }, controller.signal]);
});

test("classifyRequest converts a rejecting provider into an error result instead of rejecting", async () => {
	const deps = fakeDeps(async () => {
		throw new Error("rate limited");
	});
	const result = await classifyRequest(deps, { model: ref, state: {}, questions: {} });
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "rate limited");
});

test("classifyRequest returns aborted without reaching the provider when the signal already fired", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await classifyRequest(fakeDeps(neverCalled), { model: ref, state: {}, questions: {} }, controller.signal);
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.errorMessage, "classify aborted before start");
});

test("classifyRequest maps a provider failure raised after the signal fired to aborted", async () => {
	const controller = new AbortController();
	const deps = fakeDeps(async () => {
		controller.abort();
		throw new Error("request cancelled");
	});
	const result = await classifyRequest(deps, { model: ref, state: {}, questions: {} }, controller.signal);
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.errorMessage, "request cancelled");
});
