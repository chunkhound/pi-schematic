import { isAbsolute, relative, sep } from "node:path";

// The prefix finds the comment; the full marker also names the commit the comment describes.
export const COVERAGE_COMMENT_MARKER_PREFIX = "<!-- pi-schematic-coverage";

const BOT_LOGIN = "github-actions[bot]";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MARKER_PATTERN = /^<!-- pi-schematic-coverage sha=([0-9a-f]{40}) -->$/;
const METRICS = ["lines", "statements", "functions", "branches"];

function metricsOf(name, entry) {
  for (const metric of METRICS) {
    const value = entry?.[metric];
    if (typeof value?.total !== "number" || typeof value.covered !== "number" || typeof value.pct !== "number") {
      throw new Error(`coverage summary: ${JSON.stringify(name)} has no numeric ${metric} total, covered and pct`);
    }
  }
  return entry;
}

function metricRow(label, entry) {
  return `| ${label} | ${METRICS.map((metric) => `${entry[metric].pct}% (${entry[metric].covered}/${entry[metric].total})`).join(" | ")} |`;
}

// An empty metric counts as 100%, as the summary's own pct does.
function exactPct({ covered, total }) {
  return total > 0 ? (100 * covered) / total : 100;
}

function formatChange(points) {
  const rounded = Math.round(points * 100) / 100;
  if (rounded === 0) {
    return "±0.00";
  }
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

function changeRow(head, base) {
  return `| Change | ${METRICS.map((metric) => formatChange(exactPct(head[metric]) - exactPct(base[metric]))).join(" | ")} |`;
}

function parseBase(base) {
  const keys = base !== null && typeof base === "object" ? Object.keys(base).sort().join(",") : null;
  if (keys !== "sha,total" && keys !== "reason,sha") {
    throw new Error(`base ${JSON.stringify(base)} is neither { sha, total } nor { sha, reason }`);
  }
  if (typeof base.sha !== "string" || !SHA_PATTERN.test(base.sha)) {
    throw new Error(`base commit ${JSON.stringify(base.sha)} is not a 40-character hex SHA`);
  }
  if ("reason" in base && (typeof base.reason !== "string" || base.reason.trim() === "" || base.reason.includes("\n"))) {
    throw new Error(`base reason ${JSON.stringify(base.reason)} is not a non-empty single line`);
  }
  return "total" in base ? { sha: base.sha, total: metricsOf("base total", base.total) } : base;
}

function tableHead(label) {
  return [`| ${[label, ...METRICS].join(" | ")} |`, `|${" --- |".repeat(METRICS.length + 1)}`];
}

function parseRunAttempt(runAttempt) {
  if (typeof runAttempt !== "string" || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error(`run attempt ${JSON.stringify(runAttempt)} is not a positive integer`);
  }
  return Number(runAttempt);
}

function markerFor(sha) {
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw new Error(`commit ${JSON.stringify(sha)} is not a 40-character hex SHA`);
  }
  return `${COVERAGE_COMMENT_MARKER_PREFIX} sha=${sha} -->`;
}

/** Returns the commit SHA that the marker on the first line of a coverage comment's body names. */
export function parseCoverageCommentSha(body) {
  const firstLine = body.split("\n", 1)[0];
  const match = MARKER_PATTERN.exec(firstLine);
  if (match === null) {
    throw new Error(`coverage comment marker ${JSON.stringify(firstLine)} names no 40-character hex SHA`);
  }
  return match[1];
}

/**
 * Decides whether the coverage comment shows the summary, says the run produced no report, or stays as it is.
 * Every attempt of a run builds the same commit, so a comment naming that commit still describes it when a
 * later attempt re-ran only other lanes and downloaded no report of its own.
 */
export function decideCoverageComment({ summary, testResult, runAttempt, existingSha, sha }) {
  const attempt = parseRunAttempt(runAttempt);
  if (summary !== null) {
    return { kind: "summary" };
  }
  if (attempt > 1 && existingSha === sha) {
    return { kind: "keep" };
  }
  if (testResult !== "success") {
    return { kind: "no-report" };
  }
  throw new Error(`attempt ${attempt} has no coverage summary although the test job succeeded, and no coverage comment names commit ${sha}`);
}

/**
 * Builds the comment body. `base` is `null` without a summary; with one it is `{ sha, total }`, the base
 * commit's coverage total, or `{ sha, reason }` when the base commit has no coverage.
 */
export function buildCoverageComment({ summary, base, root, runUrl, sha, runAttempt }) {
  const marker = markerFor(sha);
  const attempt = parseRunAttempt(runAttempt);
  if (summary === null) {
    if (base !== null) {
      throw new Error(`base ${JSON.stringify(base)} was given without a coverage summary`);
    }
    return [
      marker,
      "## Unit test coverage",
      "",
      "This run produced no coverage report.",
      "",
      `Commit ${sha}, attempt ${attempt} of the [workflow run](${runUrl}).`,
      "",
    ].join("\n");
  }

  const { total, ...files } = summary;
  const headTotal = metricsOf("total", total);
  const parsedBase = parseBase(base);
  const shortBaseSha = parsedBase.sha.slice(0, 7);
  const baseLines =
    "total" in parsedBase
      ? [metricRow(`Base (${shortBaseSha})`, parsedBase.total), changeRow(headTotal, parsedBase.total)]
      : ["", `No base coverage for ${shortBaseSha}: ${parsedBase.reason}.`];
  const fileRows = Object.entries(files)
    .map(([path, entry]) => {
      const relativePath = relative(root, path);
      if (!isAbsolute(path) || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error(`coverage summary: ${JSON.stringify(path)} is not an absolute path under ${JSON.stringify(root)}`);
      }
      return [relativePath.split(sep).join("/"), metricsOf(path, entry)];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, entry]) => metricRow(`\`${path}\``, entry));

  return [
    marker,
    "## Unit test coverage",
    "",
    ...tableHead(""),
    metricRow("Total", headTotal),
    ...baseLines,
    "",
    "<details>",
    `<summary>Coverage per file (${fileRows.length})</summary>`,
    "",
    ...tableHead("File"),
    ...fileRows,
    "",
    "</details>",
    "",
    `Commit ${sha}, attempt ${attempt} of the [workflow run](${runUrl}); the HTML report is in that attempt's coverage artifact.`,
    "",
  ].join("\n");
}

/** Returns the bot's coverage comment on the pull request, or `null` when it has none. */
export async function findCoverageComment({ github, owner, repo, issueNumber }) {
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: issueNumber, per_page: 100 });
  // Only the bot's own comment counts: anyone can post a comment that starts with the marker.
  return comments.find((comment) => comment.user?.login === BOT_LOGIN && comment.body?.startsWith(COVERAGE_COMMENT_MARKER_PREFIX)) ?? null;
}

/** Updates `existing`, the comment `findCoverageComment` returned, or creates the comment when it is `null`. */
export async function upsertCoverageComment({ github, owner, repo, issueNumber, existing, body }) {
  if (existing !== null) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return "updated";
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  return "created";
}
