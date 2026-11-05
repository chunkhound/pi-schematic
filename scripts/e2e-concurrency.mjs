// WHY: e2e files spawn real pi CLI processes. Match both POSIX and Windows
// separators, and match the suite directory itself, so direct invocations
// cannot skip the cap.
const E2E_SUITE = /(?:^|\/)tests\/e2e(?:\/|$)/;

export function needsE2eConcurrency(patterns) {
	return patterns.some((pattern) => E2E_SUITE.test(pattern.replaceAll("\\", "/")));
}
