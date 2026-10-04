import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { buildDebugPrompt, detectError } from "@/modules/ai/lib/debugger";
import { native } from "@/modules/ai/lib/native";
import { redactSensitive } from "@/modules/ai/lib/redact";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  type ApiResult,
  METHODS,
  type Method,
  buildFailurePrompt,
  buildRequest,
  prettyBody,
  type BuiltRequest,
} from "./lib/api";
import {
  EXTERNAL_AGENTS,
  buildPipelinePrompt,
  launchCommand,
} from "./lib/agents";
import {
  DOCKER_LIST,
  containerCommand,
  parseContainers,
  parseImages,
  parseNetworks,
  parseVolumes,
  type ContainerAction,
  type DockerContainer,
} from "./lib/docker";
import {
  GH,
  buildReviewPrompt,
  parseIssues,
  parsePrs,
  parseRuns,
  type Issue,
  type Pr,
  type Run,
} from "./lib/github";
import {
  PROBE_FILES,
  analyzeProject,
  isSafeSetupCommand,
  type ProjectAnalysis,
  type Step,
} from "./lib/project";
import {
  type DbKind,
  type Table,
  buildQueryCommand,
  classifySql,
  describeSql,
  listTablesSql,
  parseResult,
  previewRowsSql,
  validateMysqlTarget,
} from "./lib/sql";
import { type NewTerminalTab, runInNewTab } from "./lib/terminalTab";

export type PanelProps = {
  cwd: string | null;
  newTab: NewTerminalTab;
  close: () => void;
};

const Out = ({ text }: { text: string }) => (
  <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
    {text || "(no output)"}
  </pre>
);
const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-[12px]">
    {children}
  </div>
);
const Btn = (p: React.ComponentProps<typeof Button>) => (
  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" {...p} />
);
const errText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

function sendToAi(prompt: string, close: () => void) {
  useChatStore.getState().focusInput(prompt);
  close();
  toast("Prompt ready in the AI panel — review and press Enter");
}

async function sh(cmd: string, cwd: string | null, timeout = 60) {
  return native.runCommand(cmd, cwd, timeout);
}

// ───────────── Project (setup) + Health ─────────────

async function loadAnalysis(cwd: string): Promise<ProjectAnalysis> {
  const read = async (n: string) => {
    try {
      const r = await native.readFile(`${cwd}/${n}`);
      return r.kind === "text" ? r.content : null;
    } catch {
      return null;
    }
  };
  const texts = await Promise.all(PROBE_FILES.map(read));
  const files = new Set<string>(
    PROBE_FILES.filter((_, i) => texts[i] !== null),
  );
  if ((await read("tsconfig.json")) !== null) files.add("tsconfig.json");
  const idx = (n: string) =>
    texts[PROBE_FILES.indexOf(n as (typeof PROBE_FILES)[number])];
  let packageJson: ProjectAnalysisInput["packageJson"] = null;
  try {
    packageJson = JSON.parse(idx("package.json") ?? "null");
  } catch {}
  const nm = await sh(
    "test -d node_modules && echo yes || echo no",
    cwd,
    10,
  ).catch(() => null);
  const composeName = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ].find((n) => files.has(n));
  return analyzeProject({
    files,
    packageJson,
    envExample: idx(".env.example"),
    hasNodeModules: nm?.stdout.trim() === "yes",
    composeText: composeName ? idx(composeName) : null,
  });
}
type ProjectAnalysisInput = Parameters<typeof analyzeProject>[0];

type StepState = "idle" | "running" | "ok" | "fail";
type StepResult = { state: StepState; output: string; code: number | null };

function useAnalysis(cwd: string | null) {
  const [a, setA] = useState<ProjectAnalysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setA(null);
    setErr(null);
    if (!cwd) return;
    loadAnalysis(cwd)
      .then(setA)
      .catch((e) => setErr(errText(e)));
  }, [cwd]);
  return { a, err };
}

const MARK: Record<StepState, string> = {
  idle: "·",
  running: "…",
  ok: "✓",
  fail: "✗",
};

export function ProjectPanel({ cwd, newTab }: PanelProps) {
  const { a, err } = useAnalysis(cwd);
  const [res, setRes] = useState<Record<string, StepResult>>({});
  const [busy, setBusy] = useState(false);
  if (!cwd)
    return (
      <p className="text-[12px] text-muted-foreground">
        Open a project folder first.
      </p>
    );
  if (err) return <p className="text-[12px] text-destructive">{err}</p>;
  if (!a)
    return (
      <p className="text-[12px] text-muted-foreground">Inspecting project…</p>
    );

  const steps = a.setup.filter((s) => isSafeSetupCommand(s.command));
  const runAll = async () => {
    setBusy(true);
    for (const s of steps) {
      setRes((r) => ({
        ...r,
        [s.id]: { state: "running", output: "", code: null },
      }));
      try {
        const o = await sh(s.command, cwd, 900);
        const ok = o.exit_code === 0;
        setRes((r) => ({
          ...r,
          [s.id]: {
            state: ok ? "ok" : "fail",
            output: `${o.stdout}\n${o.stderr}`.trim(),
            code: o.exit_code,
          },
        }));
        if (!ok) break;
      } catch (e) {
        setRes((r) => ({
          ...r,
          [s.id]: { state: "fail", output: errText(e), code: null },
        }));
        break;
      }
    }
    setBusy(false);
  };

  const fact = (k: string, v: string) => (
    <Row>
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </Row>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        {fact("Language", a.languages.join(", ") || "unknown")}
        {fact("Package manager", a.packageManager ?? "none detected")}
        {fact("Framework", a.framework ?? "—")}
        {fact("Database", a.databases.join(", ") || "—")}
        {fact("Docker", a.docker ? "yes" : "no")}
        {fact(".env", a.needsEnv ? "missing (.env.example found)" : "ok")}
        {fact("Dev command", a.devCommand ?? "—")}
      </div>
      {steps.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Nothing to set up — dependencies and environment look ready.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            These commands will run in order (nothing destructive):
          </span>
          {steps.map((s) => (
            <StepRow key={s.id} step={s} r={res[s.id]} />
          ))}
          <Btn disabled={busy} onClick={() => void runAll()}>
            {busy ? "Setting up…" : "Setup Project"}
          </Btn>
        </div>
      )}
      {a.devCommand ? (
        <Btn
          onClick={() =>
            void runInNewTab(a.devCommand ?? "", "dev server", cwd, newTab)
          }
        >
          Start dev server
        </Btn>
      ) : null}
    </div>
  );
}

function StepRow({ step, r }: { step: Step; r?: StepResult }) {
  return (
    <div className="flex flex-col gap-1">
      <Row>
        <span>
          {MARK[r?.state ?? "idle"]} {step.label}
        </span>
        <code className="font-mono text-[10.5px] text-muted-foreground">
          {step.command}
        </code>
      </Row>
      {r?.state === "fail" ? <Out text={r.output} /> : null}
    </div>
  );
}

export function HealthPanel({ cwd, close }: PanelProps) {
  const { a, err } = useAnalysis(cwd);
  const [res, setRes] = useState<Record<string, StepResult>>({});
  const [busy, setBusy] = useState(false);
  if (!cwd)
    return (
      <p className="text-[12px] text-muted-foreground">
        Open a project folder first.
      </p>
    );
  if (err) return <p className="text-[12px] text-destructive">{err}</p>;
  if (!a)
    return (
      <p className="text-[12px] text-muted-foreground">Detecting checks…</p>
    );
  if (a.checks.length === 0)
    return (
      <p className="text-[12px] text-muted-foreground">
        No checks detected for this project.
      </p>
    );

  const runOne = async (c: Step) => {
    setRes((r) => ({
      ...r,
      [c.id]: { state: "running", output: "", code: null },
    }));
    try {
      const o = await sh(c.command, cwd, 900);
      const out = `${o.stdout}\n${o.stderr}`.trim();
      setRes((r) => ({
        ...r,
        [c.id]: {
          state: o.exit_code === 0 ? "ok" : "fail",
          output: out,
          code: o.exit_code,
        },
      }));
    } catch (e) {
      setRes((r) => ({
        ...r,
        [c.id]: { state: "fail", output: errText(e), code: null },
      }));
    }
  };
  const runAll = async () => {
    setBusy(true);
    for (const c of a.checks) await runOne(c);
    setBusy(false);
  };
  const fix = (c: Step, r: StepResult, action: "explain" | "fix") =>
    sendToAi(
      buildDebugPrompt({
        action,
        command: c.command,
        cwd,
        exitCode: r.code,
        output: r.output,
        error: detectError(r.output, r.code ?? 1),
      }),
      close,
    );

  return (
    <div className="flex flex-col gap-2">
      <Btn disabled={busy} onClick={() => void runAll()}>
        {busy ? "Running checks…" : "Run all checks"}
      </Btn>
      {a.checks.map((c) => {
        const r = res[c.id];
        return (
          <div key={c.id} className="flex flex-col gap-1">
            <Row>
              <span>
                {MARK[r?.state ?? "idle"]} {c.label}
              </span>
              <span className="flex items-center gap-2">
                <code className="font-mono text-[10.5px] text-muted-foreground">
                  {c.command}
                </code>
                <Btn
                  disabled={r?.state === "running"}
                  onClick={() => void runOne(c)}
                >
                  Run
                </Btn>
              </span>
            </Row>
            {r?.state === "fail" ? (
              <>
                <Out text={r.output.slice(-6000)} />
                <div className="flex gap-2">
                  <Btn onClick={() => fix(c, r, "explain")}>Explain</Btn>
                  <Btn onClick={() => fix(c, r, "fix")}>
                    Fix (shows diff first)
                  </Btn>
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Docker ─────────────

export function DockerPanel({ cwd, newTab, close }: PanelProps) {
  const [kind, setKind] = useState<
    "containers" | "images" | "volumes" | "networks"
  >("containers");
  const [raw, setRaw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const o = await sh(DOCKER_LIST[kind], cwd, 20);
      if (o.exit_code !== 0)
        throw new Error(
          o.stderr.trim() || "docker failed (is the daemon running?)",
        );
      setRaw(o.stdout);
    } catch (e) {
      setRaw("");
      setErr(errText(e));
    }
  }, [kind, cwd]);
  useEffect(() => void load(), [load]);

  const act = async (action: ContainerAction, c: DockerContainer) => {
    try {
      const o = await sh(containerCommand(action, c.id), cwd, 60);
      if (o.exit_code !== 0)
        toast.error(o.stderr.trim() || `docker ${action} failed`);
      await load();
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const showLogs = async (c: DockerContainer) => {
    const o = await sh(containerCommand("logs", c.id), cwd, 20).catch((e) => ({
      stdout: errText(e),
      stderr: "",
    }));
    setLogs({ id: c.id, text: `${o.stdout}${o.stderr}` });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        {(["containers", "images", "volumes", "networks"] as const).map((k) => (
          <Btn
            key={k}
            variant={k === kind ? "default" : "outline"}
            onClick={() => setKind(k)}
          >
            {k}
          </Btn>
        ))}
        <Btn onClick={() => void load()}>Refresh</Btn>
      </div>
      {err ? <p className="text-[12px] text-destructive">{err}</p> : null}
      {kind === "containers" &&
        parseContainers(raw).map((c) => (
          <div key={c.id} className="flex flex-col gap-1">
            <Row>
              <span className="min-w-0 truncate">
                {c.state === "running" ? "🟢" : "🔴"} {c.name}{" "}
                <span className="text-muted-foreground">
                  {c.image} · {c.status}
                  {c.ports ? ` · ${c.ports}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                {c.state === "running" ? (
                  <Btn onClick={() => void act("stop", c)}>Stop</Btn>
                ) : (
                  <Btn onClick={() => void act("start", c)}>Start</Btn>
                )}
                <Btn onClick={() => void act("restart", c)}>Restart</Btn>
                <Btn onClick={() => void showLogs(c)}>Logs</Btn>
                <Btn
                  onClick={() =>
                    void runInNewTab(
                      containerCommand("shell", c.id),
                      `docker · ${c.name}`,
                      cwd,
                      newTab,
                    )
                  }
                >
                  Shell
                </Btn>
              </span>
            </Row>
            {logs?.id === c.id ? (
              <>
                <Out text={logs.text.slice(-8000)} />
                <Btn
                  onClick={() =>
                    sendToAi(
                      buildDebugPrompt({
                        action: "explain",
                        command: `docker logs ${c.name}`,
                        cwd: cwd ?? "",
                        exitCode: 1,
                        output: logs.text,
                        error: detectError(logs.text, 1),
                      }),
                      close,
                    )
                  }
                >
                  Explain this container error
                </Btn>
              </>
            ) : null}
          </div>
        ))}
      {kind === "images" &&
        parseImages(raw).map((i) => (
          <Row key={i.id + i.tag}>
            <span>
              {i.repo}:{i.tag}
            </span>
            <span className="text-muted-foreground">{i.size}</span>
          </Row>
        ))}
      {kind === "volumes" &&
        parseVolumes(raw).map((v) => (
          <Row key={v.name}>
            <span className="truncate">{v.name}</span>
            <span className="text-muted-foreground">{v.driver}</span>
          </Row>
        ))}
      {kind === "networks" &&
        parseNetworks(raw).map((n) => (
          <Row key={n.id}>
            <span>{n.name}</span>
            <span className="text-muted-foreground">{n.driver}</span>
          </Row>
        ))}
    </div>
  );
}

// ───────────── Database ─────────────

export function DatabasePanel({ cwd, close }: PanelProps) {
  const [kind, setKind] = useState<DbKind>("sqlite");
  const [target, setTarget] = useState("");
  const [tables, setTables] = useState<string[] | null>(null);
  const [sql, setSql] = useState("");
  const [table, setTable] = useState<Table | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    sql: string;
    reason: string;
  } | null>(null);

  const exec = async (q: string, allowWrite: boolean): Promise<Table> => {
    if (kind === "mysql" && !validateMysqlTarget(target))
      throw new Error("Invalid connection flags");
    if (!target.trim()) throw new Error("Enter a connection target first");
    const o = await sh(
      buildQueryCommand({ kind, target: target.trim() }, q, allowWrite),
      cwd,
      60,
    );
    if (o.exit_code !== 0) throw new Error(o.stderr.trim() || "query failed");
    return parseResult(kind, o.stdout);
  };
  const guard = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const connect = () =>
    guard(async () => {
      const t = await exec(listTablesSql(kind), false);
      setTables(t.rows.map((r) => r[0]));
      setTable(null);
    });
  const run = (q: string) =>
    guard(async () => {
      const c = classifySql(q);
      if (!c.readOnly) {
        setPending({ sql: q, reason: c.reason ?? "may modify data" });
        return;
      }
      setTable(await exec(q, false));
    });
  const approve = () =>
    guard(async () => {
      if (!pending) return;
      const q = pending.sql;
      setPending(null);
      setTable(await exec(q, true));
      toast.success("Statement executed");
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        {(["sqlite", "postgres", "mysql"] as const).map((k) => (
          <Btn
            key={k}
            variant={k === kind ? "default" : "outline"}
            onClick={() => {
              setKind(k);
              setTables(null);
            }}
          >
            {k}
          </Btn>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          spellCheck={false}
          placeholder={
            kind === "sqlite"
              ? "/path/to/app.db"
              : kind === "postgres"
                ? "postgres://user@host/db (password via ~/.pgpass)"
                : "-h host -u user dbname (password via ~/.my.cnf)"
          }
        />
        <Btn onClick={() => void connect()}>Connect</Btn>
      </div>
      <p className="text-[10.5px] text-muted-foreground">
        Passwords are never entered or stored here — use your client's own
        config. Queries run read-only unless you approve a change.
      </p>
      {err ? <p className="text-[12px] text-destructive">{err}</p> : null}
      {tables ? (
        <div className="flex flex-wrap gap-1">
          {tables.map((t) => (
            <Btn
              key={t}
              onClick={() =>
                void guard(async () => {
                  setTable(await exec(previewRowsSql(t), false));
                  setSql(previewRowsSql(t));
                })
              }
            >
              {t}
            </Btn>
          ))}
          {tables[0] ? (
            <Btn
              onClick={() =>
                void guard(async () =>
                  setTable(await exec(describeSql(kind, tables[0]), false)),
                )
              }
            >
              columns of {tables[0]}
            </Btn>
          ) : null}
        </div>
      ) : null}
      <Textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        placeholder="SELECT * FROM …"
        className="min-h-20 font-mono text-[11px]"
        spellCheck={false}
      />
      <div className="flex gap-2">
        <Btn onClick={() => void run(sql)}>Run</Btn>
        <Btn
          onClick={() =>
            sendToAi(
              `Write a ${kind} SQL query for: ${sql || "(describe what you want here)"}. Return only the SQL in a code block and do not run it.`,
              close,
            )
          }
        >
          Ask AI for SQL
        </Btn>
      </div>
      {pending ? (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/50 p-2">
          <span className="text-[12px] text-destructive">
            This statement {pending.reason}. Review it, then approve.
          </span>
          <Out text={pending.sql} />
          <div className="flex gap-2">
            <Btn onClick={() => void approve()}>Approve & run</Btn>
            <Btn onClick={() => setPending(null)}>Cancel</Btn>
          </div>
        </div>
      ) : null}
      {table ? (
        <div className="max-h-64 overflow-auto rounded-md border border-border/60">
          <table className="w-full text-left font-mono text-[10.5px]">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className="px-2 py-1">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-t border-border/40">
                  {r.map((v, j) => (
                    <td key={j} className="max-w-60 truncate px-2 py-0.5">
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ───────────── API tester ─────────────

type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};

export function ApiPanel({ close }: PanelProps) {
  const [method, setMethod] = useState<Method>("GET");
  const [url, setUrl] = useState("http://localhost:3000/");
  const [headers, setHeaders] = useState("");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [res, setRes] = useState<ApiResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [built, setBuilt] = useState<BuiltRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setErr(null);
    setRes(null);
    let req: BuiltRequest;
    try {
      req = buildRequest({ method, url, headers, query, body });
    } catch (e) {
      setErr(errText(e));
      return;
    }
    setBuilt(req);
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await invoke<HttpResponse>("ai_http_request", {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        allowPrivateNetwork: true,
      });
      const text = new TextDecoder().decode(new Uint8Array(r.body));
      setRes({
        status: r.status,
        headers: r.headers,
        body: text,
        ms: Math.round(performance.now() - t0),
        bytes: r.body.length,
      });
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };
  const failed = err !== null || (res !== null && res.status >= 400);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
          value={method}
          onChange={(e) => setMethod(e.target.value as Method)}
        >
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
        />
        <Btn disabled={busy} onClick={() => void send()}>
          {busy ? "Sending…" : "Send"}
        </Btn>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Textarea
          value={headers}
          onChange={(e) => setHeaders(e.target.value)}
          placeholder={"Headers\nAuthorization: Bearer …"}
          className="min-h-16 font-mono text-[11px]"
          spellCheck={false}
        />
        <Textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={"Query params\nkey=value"}
          className="min-h-16 font-mono text-[11px]"
          spellCheck={false}
        />
      </div>
      {method !== "GET" ? (
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='JSON body {"a":1}'
          className="min-h-20 font-mono text-[11px]"
          spellCheck={false}
        />
      ) : null}
      {err ? <p className="text-[12px] text-destructive">{err}</p> : null}
      {res ? (
        <>
          <div className="text-[12px]">
            <b>{res.status}</b> · {res.ms} ms · {res.bytes} bytes
          </div>
          <Out text={prettyBody(res.body, res.headers)} />
        </>
      ) : null}
      {failed && built ? (
        <Btn
          onClick={() =>
            sendToAi(
              buildFailurePrompt(built, res, err, redactSensitive),
              close,
            )
          }
        >
          Ask Myko why this request failed
        </Btn>
      ) : null}
    </div>
  );
}

// ───────────── GitHub ─────────────

export function GithubPanel({ cwd, close }: PanelProps) {
  const [prs, setPrs] = useState<Pr[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [releases, setReleases] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ pr: Pr; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [p, i, r, rel] = await Promise.all(
        [GH.prs, GH.issues, GH.runs, GH.releases].map((c) =>
          sh(c, cwd, 30).catch((e) => ({
            stdout: "",
            stderr: errText(e),
            exit_code: 1,
          })),
        ),
      );
      if (!alive) return;
      if (p.exit_code !== 0 && i.exit_code !== 0)
        setErr(
          p.stderr.trim() ||
            "gh failed — install the GitHub CLI and run `gh auth login`",
        );
      setPrs(parsePrs(p.stdout));
      setIssues(parseIssues(i.stdout));
      setRuns(parseRuns(r.stdout));
      setReleases(rel.stdout.trim());
    })();
    return () => {
      alive = false;
    };
  }, [cwd]);

  const openDiff = async (pr: Pr) => {
    const o = await sh(GH.prDiff(pr.number), cwd, 60).catch((e) => ({
      stdout: errText(e),
      stderr: "",
      exit_code: 1,
    }));
    setDiff({ pr, text: o.stdout || o.stderr });
  };
  const head = (t: string) => (
    <span className="mt-2 text-[11px] font-medium text-muted-foreground">
      {t}
    </span>
  );
  const ciMark = {
    passing: "✓",
    failing: "✗",
    pending: "…",
    none: "·",
  } as const;

  return (
    <div className="flex flex-col gap-1.5">
      {err ? <p className="text-[12px] text-destructive">{err}</p> : null}
      {head("Pull requests")}
      {prs.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">None open.</p>
      ) : null}
      {prs.map((p) => (
        <Row key={p.number}>
          <span className="min-w-0 truncate">
            #{p.number} {p.title}{" "}
            <span className="text-muted-foreground">
              {p.author} · {p.branch}
              {p.draft ? " · draft" : ""} · CI {ciMark[p.ci]}
            </span>
          </span>
          <Btn onClick={() => void openDiff(p)}>Diff</Btn>
        </Row>
      ))}
      {diff ? (
        <>
          <Out text={diff.text.slice(0, 20000)} />
          <Btn
            onClick={() =>
              sendToAi(buildReviewPrompt(diff.pr, diff.text), close)
            }
          >
            AI Review
          </Btn>
        </>
      ) : null}
      {head("Issues")}
      {issues.map((i) => (
        <Row key={i.number}>
          <span className="truncate">
            #{i.number} {i.title}
          </span>
          <span className="text-muted-foreground">{i.labels.join(", ")}</span>
        </Row>
      ))}
      {head("Actions")}
      {runs.map((r) => (
        <Row key={r.id}>
          <span className="truncate">
            {r.conclusion === "success" ? "✓" : r.conclusion ? "✗" : "…"}{" "}
            {r.workflow} · {r.title}
          </span>
          <span className="text-muted-foreground">{r.branch}</span>
        </Row>
      ))}
      {releases ? (
        <>
          {head("Releases")}
          <Out text={releases} />
        </>
      ) : null}
    </div>
  );
}

// ───────────── Agents ─────────────

export function AgentsPanel({ cwd, newTab, close }: PanelProps) {
  const [agent, setAgent] = useState(EXTERNAL_AGENTS[0].id);
  const [task, setTask] = useState("");
  const launch = async () => {
    try {
      const line = launchCommand(agent, task);
      await runInNewTab(
        line,
        EXTERNAL_AGENTS.find((a) => a.id === agent)?.label ?? agent,
        cwd,
        newTab,
      );
      close();
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="Describe the task, e.g. Fix the authentication bug"
        className="min-h-24 text-[12px]"
      />
      <div className="flex flex-wrap gap-1.5">
        {EXTERNAL_AGENTS.map((a) => (
          <Btn
            key={a.id}
            variant={a.id === agent ? "default" : "outline"}
            onClick={() => setAgent(a.id)}
          >
            {a.label}
          </Btn>
        ))}
      </div>
      <div className="flex gap-2">
        <Btn disabled={!task.trim()} onClick={() => void launch()}>
          Launch in terminal
        </Btn>
        <Btn
          disabled={!task.trim()}
          onClick={() => sendToAi(buildPipelinePrompt(task), close)}
        >
          Run Planner → Code → Test → Review
        </Btn>
      </div>
      <p className="text-[10.5px] text-muted-foreground">
        External agents use their own CLI login — Myko stores no credentials.
        The pipeline uses Myko's agent; all edits and commands still need your
        approval.
      </p>
    </div>
  );
}
