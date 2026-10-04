import { redactSensitive } from "@/modules/ai/lib/redact";

/** GitHub access goes through the user's own `gh` CLI login: Myko never sees a token. */
export const GH = {
  prs: "gh pr list --limit 20 --json number,title,state,author,headRefName,isDraft,statusCheckRollup",
  issues: "gh issue list --limit 20 --json number,title,state,author,labels",
  runs: "gh run list --limit 10 --json databaseId,displayTitle,status,conclusion,headBranch,workflowName",
  releases: "gh release list --limit 10",
  repo: "gh repo view --json nameWithOwner,description,url,defaultBranchRef,visibility",
  prDiff: (n: number) => `gh pr diff ${assertNum(n)}`,
  prFiles: (n: number) =>
    `gh pr view ${assertNum(n)} --json files,statusCheckRollup,title,body`,
} as const;

function assertNum(n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error("invalid number");
  return n;
}

export type Pr = {
  number: number;
  title: string;
  state: string;
  author: string;
  branch: string;
  draft: boolean;
  ci: "passing" | "failing" | "pending" | "none";
};
export type Issue = {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
};
export type Run = {
  id: number;
  title: string;
  status: string;
  conclusion: string;
  branch: string;
  workflow: string;
};

type Json = Record<string, unknown>;
function arr(out: string): Json[] {
  try {
    const v = JSON.parse(out);
    return Array.isArray(v) ? (v as Json[]) : [];
  } catch {
    return [];
  }
}
const login = (a: unknown) => String((a as Json | null)?.login ?? "");

export function ciState(rollup: unknown): Pr["ci"] {
  const list = Array.isArray(rollup) ? (rollup as Json[]) : [];
  if (list.length === 0) return "none";
  let pending = false;
  for (const c of list) {
    const concl = String(c.conclusion ?? c.state ?? "").toUpperCase();
    const status = String(c.status ?? "").toUpperCase();
    if (
      [
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
      ].includes(concl)
    )
      return "failing";
    if (
      (status && status !== "COMPLETED") ||
      concl === "PENDING" ||
      concl === ""
    )
      pending = true;
  }
  return pending ? "pending" : "passing";
}

export const parsePrs = (out: string): Pr[] =>
  arr(out).map((r) => ({
    number: Number(r.number),
    title: String(r.title ?? ""),
    state: String(r.state ?? ""),
    author: login(r.author),
    branch: String(r.headRefName ?? ""),
    draft: Boolean(r.isDraft),
    ci: ciState(r.statusCheckRollup),
  }));
export const parseIssues = (out: string): Issue[] =>
  arr(out).map((r) => ({
    number: Number(r.number),
    title: String(r.title ?? ""),
    state: String(r.state ?? ""),
    author: login(r.author),
    labels: Array.isArray(r.labels)
      ? (r.labels as Json[]).map((l) => String(l.name ?? ""))
      : [],
  }));
export const parseRuns = (out: string): Run[] =>
  arr(out).map((r) => ({
    id: Number(r.databaseId),
    title: String(r.displayTitle ?? ""),
    status: String(r.status ?? ""),
    conclusion: String(r.conclusion ?? ""),
    branch: String(r.headBranch ?? ""),
    workflow: String(r.workflowName ?? ""),
  }));

const MAX_DIFF = 60_000;

/** Read-only review prompt. The AI may not merge or push; it only reports. */
export function buildReviewPrompt(
  pr: { number: number; title: string },
  diff: string,
): string {
  const d = redactSensitive(
    diff.length > MAX_DIFF
      ? `${diff.slice(0, MAX_DIFF)}\n[... diff truncated ...]`
      : diff,
  );
  return `<myko-pr-review number="${pr.number}">
Title: ${pr.title}

<diff>
${d}
</diff>
</myko-pr-review>

Review this pull request. Report only real findings, grouped as: Bugs, Security issues, Missing tests, Performance problems, Questionable code. For each give file, approximate line, why it matters and a suggested fix. If a group has none, say "none found". Do not modify files, merge, approve or push anything.`;
}
