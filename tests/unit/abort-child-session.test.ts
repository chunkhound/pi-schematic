import { expect, test, vi } from "vitest";
import { createState, abortChildSession } from "../../state.js";
import { createSession } from "./helpers.js";

function createMockSession(abortImpl: () => Promise<void> | void) {
	return Object.assign(createSession([]), { abort: abortImpl });
}

test("abortChildSession returns the same promise for the same session", async () => {
	const state = createState();
	const session = createMockSession(vi.fn(() => Promise.resolve()));
	
	const promise1 = abortChildSession(state, session);
	const promise2 = abortChildSession(state, session);
	
	expect(promise1, "same session returns same promise").toBe(promise2);
	
	await promise1;
	await promise2;
});

test("abortChildSession handles synchronous abort() throw", async () => {
	const state = createState();
	const syncError = new Error("sync abort failure");
	const session = createMockSession(() => { throw syncError; });
	
	const promise = abortChildSession(state, session);
	
	await expect(promise).rejects.toBe(syncError);
});

test("abortChildSession returns different promises for different sessions", async () => {
	const state = createState();
	const session1 = createMockSession(vi.fn(() => Promise.resolve()));
	const session2 = createMockSession(vi.fn(() => Promise.resolve()));
	
	const promise1 = abortChildSession(state, session1);
	const promise2 = abortChildSession(state, session2);
	
	expect(promise1, "different sessions return different promises").not.toBe(promise2);
	
	await promise1;
	await promise2;
});

test("abortChildSession promise resolves when abort completes", async () => {
	const state = createState();
	let abortCalled = false;
	const session = createMockSession(() => { abortCalled = true; return Promise.resolve(); });
	
	const promise = abortChildSession(state, session);
	await promise;
	
	expect(abortCalled, "abort was called").toBe(true);
});

test("abortChildSession promise rejects when abort rejects", async () => {
	const state = createState();
	const abortError = new Error("abort rejected");
	const session = createMockSession(() => Promise.reject(abortError));
	
	const promise = abortChildSession(state, session);
	
	await expect(promise).rejects.toBe(abortError);
});
