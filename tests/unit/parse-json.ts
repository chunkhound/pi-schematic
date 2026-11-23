// Typed JSON parsing for tests that read repository files or child process output.

import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** `text` parsed as JSON; throws, naming `what` and the first mismatch, unless the value matches `schema`. */
export function parseJson<const T extends TSchema>(schema: T, text: string, what: string): Static<T> {
	const value: unknown = JSON.parse(text);
	if (!Value.Check(schema, value)) {
		throw new Error(`${what} does not have the expected shape: ${JSON.stringify(Value.Errors(schema, value)[0])}`);
	}
	return value;
}
