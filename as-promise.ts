/**
 * Calls `body` and returns its result as a promise, turning a synchronous throw
 * into a rejection with the same error. Handlers declared to return a promise
 * use it to keep that contract: pi's shortcut dispatch chains `.catch` on the
 * returned promise, which a synchronous throw escapes, and tests assert
 * failures with `expect(handler()).rejects`.
 */
export function asPromise<T>(body: () => T | PromiseLike<T>): Promise<T> {
	return new Promise((resolve) => { resolve(body()); });
}
