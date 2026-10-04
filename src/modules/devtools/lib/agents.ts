import { shq } from "./shq";

export type ExternalAgent = {
  id: string;
  label: string;
  bin: string;
  /** Builds the shell line that starts the agent with the task. */
  command: (task: string) => string;
};

/**
 * External coding-agent CLIs, launched in a terminal tab so they use the
 * user's own login/API configuration. Myko never handles their credentials.
 * Flags are best-effort for each CLI's documented prompt argument; edit if a
 * CLI changes.
 */
export const EXTERNAL_AGENTS: readonly ExternalAgent[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    command: (t) => `claude ${shq(t)}`,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    command: (t) => `gemini -i ${shq(t)}`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    command: (t) => `codex ${shq(t)}`,
  },
  {
    id: "aider",
    label: "Aider",
    bin: "aider",
    command: (t) => `aider --message ${shq(t)}`,
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    command: (t) => `opencode --prompt ${shq(t)}`,
  },
];

export function findExternalAgent(id: string): ExternalAgent | undefined {
  return EXTERNAL_AGENTS.find((a) => a.id === id);
}

export function launchCommand(id: string, task: string): string {
  const a = findExternalAgent(id);
  if (!a) throw new Error("unknown agent");
  const t = task.trim();
  if (!t) throw new Error("empty task");
  if (/[\0\r]/.test(t)) throw new Error("invalid task text");
  return a.command(t.replace(/\n/g, " "));
}

/**
 * Prompt for Myko's own agent: Planner → Coder → Tests → Review. Planning and
 * review use read-only subagents; code edits and commands still go through the
 * normal approval-gated tools.
 */
export function buildPipelinePrompt(task: string): string {
  return `<myko-pipeline>
Task: ${task.trim()}
</myko-pipeline>

Run this as a four-stage pipeline and report after each stage.
1. PLAN — call run_subagent (type "explore") to map the relevant files, then write a short numbered plan: files to change, risks, and how to validate. Wait for my go-ahead if the plan touches more than 5 files.
2. CODE — implement the plan with edit/multi_edit. Each change is shown to me for approval; keep changes minimal and never touch .env or secret files.
3. TEST — detect the project's own typecheck, lint, test and build commands (package.json scripts, Cargo.toml, pyproject.toml, Makefile) and run them with run_command. Fix failures caused by your changes.
4. REVIEW — call run_subagent (type "code-review") on the final diff and summarize its findings. Be honest about anything still failing.`;
}
