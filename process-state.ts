/**
 * Process-wide storage for mutable state shared by module copies.
 *
 * WHY: jiti loads modules with moduleCache:false (see workflow/coordinator.ts),
 * so one module can be instantiated twice per process. `Symbol.for` registers
 * ONE key shared by every copy, so each copy's lookup returns the same stored
 * value. Plain module-level `const`/`let` would fork per copy and split state.
 */

/**
 * Read the value registered under key; create it on first access.
 * Every call performs a fresh globalThis lookup, so all module copies share it.
 */
export function registeredState<T>(key: string, create: () => T): T {
	const holder = globalThis as Record<symbol, unknown>;
	const slot = Symbol.for(key);
	return (holder[slot] ??= create()) as T;
}
