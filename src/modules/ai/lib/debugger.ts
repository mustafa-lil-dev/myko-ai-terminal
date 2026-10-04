import { capAttachOutput } from "@/modules/terminal/block/lib/outputCap";
import { redactSensitive } from "./redact";

export type DebugAction = "explain" | "cause" | "fix" | "plan";

export type DetectedError = {
  kind:
    | "typescript"
    | "rust"
    | "python"
    | "node"
    | "test"
    | "build"
    | "generic";
  summary: string;
  file: string | null;
  line: number | null;
};

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const FILE_LINE_RES: RegExp[] = [
  // TypeScript: src/a.ts(12,5): error TS2322 / src/a.ts:12:5 - error TS...
  /([^\s()'"]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte))[(:](\d+)(?:[,:]\d+)?\)?:?\s*-?\s*error/i,
  // Rust: --> src/main.rs:10:5
  /-->\s+([^\s:]+\.rs):(\d+)/,
  // Python: File "x.py", line 12
  /File "([^"]+\.py)", line (\d+)/,
  // Node/browser stack frame: at fn (/path/File.tsx:48:12) or at /path/x.js:1:2
  /\bat\s+(?:[^\s(]+\s+\()?((?:\/|[A-Za-z]:[\\/])[^\s():]+\.[A-Za-z]+):(\d+):\d+\)?/,
  // Go / generic: ./main.go:12:3:
  /(\.{0,2}\/?[^\s:]+\.(?:go|py|rb|php|java|kt|c|cc|cpp|h)):(\d+)(?::\d+)?:/,
];

const ERROR_LINE_RES: Array<{ kind: DetectedError["kind"]; re: RegExp }> = [
  { kind: "typescript", re: /error TS\d+:.+/ },
  { kind: "rust", re: /^error(?:\[E\d+\])?: .+/m },
  { kind: "node", re: /^\s*(?:Uncaught\s+)?(?:\w*Error)(?:: .+)?$/m },
  { kind: "test", re: /^\s*(?:FAIL|✕|×|failures:|test result: FAILED).*/m },
  {
    kind: "build",
    re: /(?:Build failed|failed to compile|npm ERR!|ERR_PNPM).*/i,
  },
];

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Inspects the output of a *failed* command and extracts a short summary and
 * the most likely file:line. Returns null when nothing recognizable is found
 * and the exit code gives no useful signal.
 */
export function detectError(
  output: string,
  exitCode: number | null,
): DetectedError | null {
  if (exitCode === 0 || exitCode === null) return null;
  const text = stripAnsi(output);
  let kind: DetectedError["kind"] = "generic";
  let summary = "";
  for (const { kind: k, re } of ERROR_LINE_RES) {
    const m = text.match(re);
    if (m) {
      kind = k;
      summary = m[0].trim();
      break;
    }
  }
  if (kind === "node" && /Traceback \(most recent call last\)/.test(text))
    kind = "python";
  if (!summary) {
    const lines = text.split("\n").map((l) => l.trim());
    summary = [...lines].reverse().find((l) => l.length > 0) ?? "";
    if (!summary) summary = `Command exited with code ${exitCode}`;
  }
  let file: string | null = null;
  let line: number | null = null;
  for (const re of FILE_LINE_RES) {
    const m = text.match(re);
    if (m) {
      file = m[1];
      line = Number(m[2]);
      break;
    }
  }
  return { kind, summary: summary.slice(0, 200), file, line };
}

const VALIDATION_HINT =
  "Detect the project's own commands from package.json scripts / Cargo.toml / pyproject.toml / Makefile (do not assume), then run the relevant typecheck, lint, tests and build with run_command.";

export type BuildPromptInput = {
  action: DebugAction;
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
  error: DetectedError | null;
};

/**
 * Builds the chat prompt for a debug action. Output is redacted and capped
 * before it leaves the terminal. File edits and commands run through the
 * existing approval-gated tools, so nothing is applied without consent.
 */
export function buildDebugPrompt(input: BuildPromptInput): string {
  const { action, command, cwd, exitCode, error } = input;
  const out = redactSensitive(capAttachOutput(stripAnsi(input.output)));
  const where = error?.file
    ? `${error.file}${error.line ? `:${error.line}` : ""}`
    : "unknown";
  const head = `<myko-debug action="${action}">
Command: ${redactSensitive(command)}
Working directory: ${cwd || "unknown"}
Exit code: ${exitCode ?? "unknown"}
Detected: ${error ? `${error.kind} — ${error.summary}` : "no recognizable error"}
Likely location: ${where}

<output>
${out}
</output>
</myko-debug>`;

  switch (action) {
    case "explain":
      return `${head}

Explain this error in plain language: what it means and what usually causes it. Do not modify anything. Only read files if needed to be specific.`;
    case "cause":
      return `${head}

Find the root cause. Read the file at the likely location (and its direct imports or callers if needed) with read_file, using grep/glob sparingly. Report the exact cause, the file and line, and why it happens. Do not edit anything.`;
    case "fix":
      return `${head}

Fix this error.
1. Locate the relevant files from the error and read them with read_file (never .env or secret files).
2. Diagnose the root cause.
3. Make the smallest correct change using edit/multi_edit; each edit is shown to the user for approval, so do not batch unrelated changes.
4. After edits are approved, validate. ${VALIDATION_HINT}
5. Re-run the failing command if it is safe, then report the result honestly, including anything still failing.`;
    case "plan":
      return `${head}

Create a step-by-step plan to fix this error. Read the relevant files first. List the files to change, the change in each, risks, and how to validate. Do not edit anything yet.`;
  }
}
