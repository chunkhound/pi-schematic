// Stand-ins for class instances: one that throws on every member the test did not provide, and
// one that only carries the class's prototype.

/**
 * An object whose prototype is `prototype` and whose own members are `members`. Reading any other
 * member declared on `prototype` or on a prototype it inherits from (up to, not including,
 * `Object.prototype`), or one of the instance `fields` the class's type declares, throws
 * `failure(member)`. Copying, comparing or awaiting it does not throw. The members are defined,
 * not assigned, so an accessor the class declares for the same name is not run.
 */
export function guardedInstance<T extends object>(prototype: T, members: Partial<T>, fields: readonly string[], failure: (member: string) => Error): T {
	const descriptors = Object.fromEntries(
		Object.entries(members).map(([name, value]): [string, PropertyDescriptor] => [name, { value, writable: true, enumerable: true, configurable: true }]),
	);
	const target: unknown = Object.create(prototype, descriptors);
	if (!hasPrototype(target, prototype)) {
		throw new Error("Object.create did not produce an object with the given prototype.");
	}
	const declared = new Set(fields);
	let level: unknown = prototype;
	while (typeof level === "object" && level !== null && level !== Object.prototype) {
		for (const name of Object.getOwnPropertyNames(level)) {
			declared.add(name);
		}
		level = Object.getPrototypeOf(level);
	}
	declared.delete("constructor");
	return new Proxy(target, {
		get(object, property, receiver) {
			if (typeof property === "string" && declared.has(property) && !Object.hasOwn(members, property)) {
				throw failure(property);
			}
			const value: unknown = Reflect.get(object, property, receiver);
			return value;
		},
	});
}

/**
 * An object whose prototype is `prototype`, with `members` as own properties, so it
 * passes `instanceof` checks for the class. Every member left out is the class's own
 * and usually fails, because the object never ran the constructor.
 */
export function stubInstance<T extends object>(prototype: T, members: Partial<T>): T {
	const target: unknown = Object.create(prototype);
	if (!hasPrototype(target, prototype)) {
		throw new Error("Object.create did not produce an object with the given prototype.");
	}
	return Object.assign(target, members);
}

function hasPrototype<T extends object>(value: unknown, prototype: T): value is T {
	return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === prototype;
}
