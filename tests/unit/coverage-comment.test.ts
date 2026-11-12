import { expect, test } from "vitest";
import { expectPrefix } from "../assertions.js";

const { COVERAGE_COMMENT_MARKER_PREFIX, buildCoverageComment, decideCoverageComment, findCoverageComment, parseCoverageCommentSha, upsertCoverageComment } = await import(
	new URL("../../scripts/coverage-comment.mjs", import.meta.url).href
);

const ROOT = "/work/repo";
const RUN_URL = "https://github.com/owner/repo/actions/runs/7";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const MARKER = `${COVERAGE_COMMENT_MARKER_PREFIX} sha=${SHA} -->`;

function metrics(covered: number, total: number, pct: number) {
	return { total, covered, skipped: 0, pct };
}

function entry(covered: number, total: number, pct: number) {
	return { lines: metrics(covered, total, pct), statements: metrics(covered, total, pct), functions: metrics(1, 2, 50), branches: metrics(3, 4, 75) };
}

const SUMMARY = {
	total: entry(30, 40, 75),
	[`${ROOT}/spawn/index.ts`]: entry(10, 20, 50),
	[`${ROOT}/index.ts`]: entry(20, 20, 100),
};

interface Call {
	method: string;
	params: Record<string, unknown>;
}

interface Comment {
	id: number;
	user: { login: string };
	body: string;
}

function fakeGithub(comments: Comment[]) {
	const calls: Call[] = [];
	const listComments = () => {
		throw new Error("listComments is reached only through paginate");
	};
	return {
		calls,
		github: {
			paginate: async (method: unknown, params: Record<string, unknown>) => {
				expect(method).toBe(listComments);
				calls.push({ method: "paginate", params });
				return comments;
			},
			rest: {
				issues: {
					listComments,
					updateComment: async (params: Record<string, unknown>) => calls.push({ method: "updateComment", params }),
					createComment: async (params: Record<string, unknown>) => calls.push({ method: "createComment", params }),
				},
			},
		},
	};
}

const TARGET = { owner: "owner", repo: "repo", issueNumber: 12 };
const BODY = `${MARKER}\nnew body`;

test.each([
	{ name: "a summary is shown even when an earlier attempt's comment names the commit", summary: SUMMARY, testResult: "success", runAttempt: "2", existingSha: SHA, kind: "summary" },
	{ name: "a later attempt without a summary keeps the comment that names the commit", summary: null, testResult: "success", runAttempt: "2", existingSha: SHA, kind: "keep" },
	{ name: "a first attempt without a summary reports no coverage when the tests failed, whatever commit the comment names", summary: null, testResult: "failure", runAttempt: "1", existingSha: SHA, kind: "no-report" },
	{ name: "a later attempt reports no coverage when the comment names another commit and the tests failed", summary: null, testResult: "failure", runAttempt: "2", existingSha: OTHER_SHA, kind: "no-report" },
])("decideCoverageComment: $name", ({ summary, testResult, runAttempt, existingSha, kind }) => {
	expect(decideCoverageComment({ summary, testResult, runAttempt, existingSha, sha: SHA })).toStrictEqual({ kind });
});

test.each([
	{ name: "a first attempt whose comment names the commit", runAttempt: "1", existingSha: SHA },
	{ name: "a later attempt whose comment names another commit", runAttempt: "2", existingSha: OTHER_SHA },
	{ name: "a later attempt without a comment", runAttempt: "2", existingSha: null },
])("decideCoverageComment rejects a missing summary after successful tests in $name", ({ runAttempt, existingSha }) => {
	expect(() => decideCoverageComment({ summary: null, testResult: "success", runAttempt, existingSha, sha: SHA })).toThrow(/no coverage summary although the test job succeeded/);
});

test.each([{ runAttempt: "0" }, { runAttempt: "01" }, { runAttempt: "1.5" }, { runAttempt: "" }, { runAttempt: undefined }])(
	"decideCoverageComment rejects the run attempt $runAttempt",
	({ runAttempt }) => {
		expect(() => decideCoverageComment({ summary: SUMMARY, testResult: "success", runAttempt, existingSha: null, sha: SHA })).toThrow(/is not a positive integer/);
	},
);

test("parseCoverageCommentSha returns the commit a built comment's marker names", () => {
	const body = buildCoverageComment({ summary: null, root: ROOT, runUrl: RUN_URL, sha: SHA, runAttempt: "1" });

	expect(parseCoverageCommentSha(body)).toBe(SHA);
});

test.each([{ firstLine: `${COVERAGE_COMMENT_MARKER_PREFIX} -->` }, { firstLine: `${COVERAGE_COMMENT_MARKER_PREFIX} sha=0123abc -->` }])(
	"parseCoverageCommentSha rejects the marker $firstLine",
	({ firstLine }) => {
		expect(() => parseCoverageCommentSha(`${firstLine}\nbody`)).toThrow(/names no 40-character hex SHA/);
	},
);

test("buildCoverageComment tabulates the totals and lists each file relative to the root in sorted order", () => {
	const body = buildCoverageComment({ summary: SUMMARY, root: ROOT, runUrl: RUN_URL, sha: SHA, runAttempt: "1" });

	expect(body).toContain("| Total | 75% (30/40) | 75% (30/40) | 50% (1/2) | 75% (3/4) |");
	const fileRows = body.split("\n").filter((line: string) => line.startsWith("| `"));
	expect(fileRows).toStrictEqual([
		"| `index.ts` | 100% (20/20) | 100% (20/20) | 50% (1/2) | 75% (3/4) |",
		"| `spawn/index.ts` | 50% (10/20) | 50% (10/20) | 50% (1/2) | 75% (3/4) |",
	]);
});

test("buildCoverageComment starts the summary with the commit's marker and names the commit and attempt", () => {
	const body = buildCoverageComment({ summary: SUMMARY, root: ROOT, runUrl: RUN_URL, sha: SHA, runAttempt: "3" });

	expectPrefix(body, `${MARKER}\n`);
	expect(body).toContain(`Commit ${SHA}, attempt 3 of the [workflow run](${RUN_URL})`);
});

test("buildCoverageComment without a summary says the run produced no coverage report, names no cause and links the run", () => {
	const body = buildCoverageComment({ summary: null, root: ROOT, runUrl: RUN_URL, sha: SHA, runAttempt: "2" });

	expectPrefix(body, `${MARKER}\n`);
	expect(body.split("\n")).toContain("This run produced no coverage report.");
	expect(body).not.toContain("because");
	expect(body).toContain(`Commit ${SHA}, attempt 2 of the [workflow run](${RUN_URL})`);
	expect(body).not.toContain("| Total |");
});

test("buildCoverageComment rejects a commit that is not a 40-character hex SHA", () => {
	expect(() => buildCoverageComment({ summary: null, root: ROOT, runUrl: RUN_URL, sha: "0123abc", runAttempt: "1" })).toThrow(/is not a 40-character hex SHA/);
});

test("buildCoverageComment rejects a file entry outside the root", () => {
	const summary = { total: SUMMARY.total, "/elsewhere/index.ts": entry(1, 1, 100) };

	expect(() => buildCoverageComment({ summary, root: ROOT, runUrl: RUN_URL, sha: SHA, runAttempt: "1" })).toThrow(/is not an absolute path under/);
});

test("buildCoverageComment rejects an entry without numeric metrics", () => {
	const summary = { total: { ...SUMMARY.total, branches: { total: 0, covered: 0, skipped: 0, pct: "Unknown" } } };

	expect(() => buildCoverageComment({ summary, root: ROOT, runUrl: RUN_URL, sha: SHA, runAttempt: "1" })).toThrow(/"total" has no numeric branches/);
});

test("findCoverageComment returns the bot's marked comment, not a user's comment carrying the marker", async () => {
	const botComment = { id: 3, user: { login: "github-actions[bot]" }, body: `${MARKER}\nold body` };
	const { github, calls } = fakeGithub([
		{ id: 1, user: { login: "someone" }, body: `${MARKER}\nquoted` },
		{ id: 2, user: { login: "github-actions[bot]" }, body: "unrelated bot comment" },
		botComment,
	]);

	expect(await findCoverageComment({ github, ...TARGET })).toBe(botComment);
	expect(calls).toStrictEqual([{ method: "paginate", params: { owner: "owner", repo: "repo", issue_number: 12, per_page: 100 } }]);
});

test("findCoverageComment returns null when no bot comment carries the marker", async () => {
	const { github } = fakeGithub([{ id: 1, user: { login: "someone" }, body: `${MARKER}\nquoted` }]);

	expect(await findCoverageComment({ github, ...TARGET })).toBeNull();
});

test("upsertCoverageComment updates the found comment", async () => {
	const { github, calls } = fakeGithub([]);

	const action = await upsertCoverageComment({ github, ...TARGET, existing: { id: 3 }, body: BODY });

	expect(action).toBe("updated");
	expect(calls).toStrictEqual([{ method: "updateComment", params: { owner: "owner", repo: "repo", comment_id: 3, body: BODY } }]);
});

test("upsertCoverageComment creates a comment when none was found", async () => {
	const { github, calls } = fakeGithub([]);

	const action = await upsertCoverageComment({ github, ...TARGET, existing: null, body: BODY });

	expect(action).toBe("created");
	expect(calls).toStrictEqual([{ method: "createComment", params: { owner: "owner", repo: "repo", issue_number: 12, body: BODY } }]);
});
