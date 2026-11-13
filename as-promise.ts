/**
 * Runs a synchronous body and returns its result as a promise, turning a throw
 * into a rejection with the same error: callers and tests of promise-returning
 * handlers rely on a rejected promise, never a synchronous throw.
 */
export function asPromise<T>(body: () => T): Promise<T> {
	return new Promise((resolve) => { resolve(body()); });
}
