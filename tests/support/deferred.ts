/** A promise and the function that resolves it, for a test that decides when a wait ends. */
export function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
