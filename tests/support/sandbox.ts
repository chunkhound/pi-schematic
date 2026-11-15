// What the OS sandbox and pi's bash tool report for a write the sandbox blocked.

/** The denial phrase each platform's OS sandbox puts in a blocked write's error. */
export const SANDBOX_DENIAL_PHRASES: Partial<Record<NodeJS.Platform, string>> = {
	darwin: "Operation not permitted",
	linux: "Read-only file system",
};

/** Build a result shaped like pi's bash tool result for a command that exited with code 1. */
export function bashResult(output: string, isError = true) {
	return {
		content: [{ type: "text" as const, text: `${output}\n\nCommand exited with code 1` }],
		structuredContent: { output, truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
		isError,
	};
}
