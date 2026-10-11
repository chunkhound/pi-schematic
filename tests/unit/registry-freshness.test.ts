import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryFreshness } from "../../model-groups/registry-freshness.js";
import { refreshModelGroupsStateFresh } from "../../model-groups/refresh.js";
import { createState } from "../../state.js";
import { createDeferred } from "./helpers.js";

function revision(value: number) {
	return { dev: 1, ino: 2, size: value, mtimeMs: value, ctimeMs: value };
}

function fixture(result: () => Promise<any> | any = () => ({ aborted: false, errors: new Map() })) {
	let current = 1;
	const calls: unknown[] = [];
	const freshness = createRegistryFreshness({
		getAgentDir: () => "/agent",
		statFile: async () => revision(current),
	});
	const ctx = { modelRegistry: { refresh: async (options: unknown) => {
		calls.push(options);
		return result();
	} } } as any;
	return { freshness, ctx, calls, change: () => { current++; } };
}

test("registry freshness gates unchanged file revisions and passes allowNetwork false", async () => {
	const f = fixture();
	assert.deepEqual(await f.freshness.ensureFresh(f.ctx), { refreshed: true });
	assert.deepEqual(await f.freshness.ensureFresh(f.ctx), { refreshed: false });
	assert.deepEqual(f.calls, [{ allowNetwork: false }]);
	f.change();
	assert.deepEqual(await f.freshness.ensureFresh(f.ctx), { refreshed: true });
	assert.equal(f.calls.length, 2);
});

test("registry freshness coalesces concurrent reconciliation", async () => {
	const pending = createDeferred();
	const f = fixture(async () => {
		await pending.promise;
		return { aborted: false, errors: new Map() };
	});
	const first = f.freshness.ensureFresh(f.ctx);
	const second = f.freshness.ensureFresh(f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.calls.length, 1);
	pending.resolve();
	assert.deepEqual(await Promise.all([first, second]), [{ refreshed: true }, { refreshed: true }]);
});

test("registry freshness retries an errored refresh without advancing its watermark", async () => {
	let attempt = 0;
	const f = fixture(() => ++attempt === 1
		? { aborted: false, errors: new Map([["provider", new Error("bad credentials")]]) }
		: { aborted: false, errors: new Map() });
	const failed = await f.freshness.ensureFresh(f.ctx);
	assert.equal(failed.refreshed, false);
	assert.match(failed.error ?? "", /bad credentials/);
	assert.equal(failed.reportPending, true);
	assert.deepEqual(await f.freshness.ensureFresh(f.ctx), { refreshed: true });
	assert.equal(f.calls.length, 2);
});

test("refresh failure warning fires once per failure streak and resets after success", async () => {
	let attempt = 0;
	const f = fixture(() => {
		attempt++;
		return attempt === 3
			? { aborted: false, errors: new Map() }
			: { aborted: false, errors: new Map([["provider", new Error("unavailable")]]) };
	});
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = { ...f.ctx, hasUI: true, ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } };
	const state = createState(f.freshness);
	await refreshModelGroupsStateFresh(state, ctx as any);
	await refreshModelGroupsStateFresh(state, ctx as any);
	await refreshModelGroupsStateFresh(state, ctx as any);
	f.change();
	await refreshModelGroupsStateFresh(state, ctx as any);
	assert.deepEqual(notifications, [
		{ message: "Model registry refresh failed; using last known models", level: "warning" },
		{ message: "Model registry refresh failed; using last known models", level: "warning" },
	]);
});

test("an unreported failure observed by the silent pre-routing refresh still warns at the next boundary", async () => {
	const f = fixture(() => ({ aborted: false, errors: new Map([["provider", new Error("unavailable")]]) }));
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = { ...f.ctx, hasUI: true, ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } };
	const state = createState(f.freshness);
	// The silent pre-routing refresh observes the failure first but does not report it.
	const silent = await f.freshness.ensureFresh(ctx as any);
	assert.equal(silent.reportPending, true);
	assert.equal(notifications.length, 0);
	// The next interactive boundary still warns, exactly once for the streak.
	await refreshModelGroupsStateFresh(state, ctx as any);
	await refreshModelGroupsStateFresh(state, ctx as any);
	assert.deepEqual(notifications, [
		{ message: "Model registry refresh failed; using last known models", level: "warning" },
	]);
});
