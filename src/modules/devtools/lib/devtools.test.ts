import { describe, expect, it } from "vitest";
import {
  buildFailurePrompt,
  buildRequest,
  prettyBody,
  redactHeaders,
} from "./api";
import { buildPipelinePrompt, launchCommand } from "./agents";
import { containerCommand, parseContainers } from "./docker";
import {
  buildReviewPrompt,
  ciState,
  parseIssues,
  parsePrs,
  parseRuns,
  GH,
} from "./github";
import { analyzeProject, isSafeSetupCommand, parseEnvKeys } from "./project";
import { shq } from "./shq";
import {
  buildQueryCommand,
  classifySql,
  describeSql,
  parseResult,
} from "./sql";

describe("project detection", () => {
  it("detects a pnpm TypeScript Vite project and its own scripts", () => {
    const a = analyzeProject({
      files: new Set([
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        ".env.example",
        "Dockerfile",
      ]),
      packageJson: {
        scripts: {
          dev: "vite",
          "check-types": "tsc",
          lint: "biome lint",
          test: "vitest run",
          build: "vite build",
        },
        devDependencies: { vite: "1", typescript: "5" },
      },
      envExample: "DATABASE_URL=postgres://x\nSECRET=\n",
      hasNodeModules: false,
    });
    expect(a.packageManager).toBe("pnpm");
    expect(a.framework).toBe("Vite");
    expect(a.languages).toEqual(["TypeScript"]);
    expect(a.devCommand).toBe("pnpm run dev");
    expect(a.setup.map((s) => s.command)).toEqual([
      "cp -n .env.example .env",
      "pnpm install",
    ]);
    expect(a.checks.map((c) => c.command)).toContain("pnpm run check-types");
    expect(a.databases).toEqual(["PostgreSQL"]);
    expect(a.docker).toBe(true);
  });

  it("skips install when node_modules exists and env already created", () => {
    const a = analyzeProject({
      files: new Set([
        "package.json",
        "package-lock.json",
        ".env",
        ".env.example",
      ]),
      packageJson: { scripts: { start: "node ." } },
      hasNodeModules: true,
    });
    expect(a.setup).toEqual([]);
    expect(a.packageManager).toBe("npm");
    expect(a.devCommand).toBe("npm run start");
    expect(a.needsEnv).toBe(false);
  });

  it("detects Rust, Python and Go without assuming node", () => {
    expect(
      analyzeProject({ files: new Set(["Cargo.toml"]) }).checks.map(
        (c) => c.command,
      ),
    ).toEqual(["cargo check", "cargo test", "cargo build"]);
    expect(
      analyzeProject({ files: new Set(["requirements.txt"]) }).setup[0].command,
    ).toContain("pip install -r requirements.txt");
    expect(analyzeProject({ files: new Set(["go.mod"]) }).languages).toEqual([
      "Go",
    ]);
  });

  it("offers compose services only when a database is referenced", () => {
    const a = analyzeProject({
      files: new Set(["docker-compose.yml"]),
      composeText: "services:\n  db:\n    image: postgres:16",
    });
    expect(a.setup[a.setup.length - 1]?.command).toBe("docker compose up -d");
    expect(
      analyzeProject({
        files: new Set(["docker-compose.yml"]),
        composeText: "services:\n web:",
      }).setup,
    ).toEqual([]);
  });

  it("parses env keys and rejects destructive setup commands", () => {
    expect(parseEnvKeys("# c\nA=1\nexport B=2\n bad line")).toEqual(["A", "B"]);
    expect(isSafeSetupCommand("pnpm install")).toBe(true);
    expect(isSafeSetupCommand("rm -rf node_modules")).toBe(false);
    expect(isSafeSetupCommand("prisma migrate reset")).toBe(false);
  });
});

describe("docker", () => {
  it("parses ps output", () => {
    const out = `{"ID":"abc","Names":"web","Image":"nginx","State":"running","Status":"Up 2h","Ports":"80/tcp"}\nnoise\n{"ID":"d","Names":"redis","Image":"redis","State":"exited","Status":"Exited","Ports":""}`;
    const c = parseContainers(out);
    expect(c.map((x) => [x.name, x.state])).toEqual([
      ["web", "running"],
      ["redis", "exited"],
    ]);
  });
  it("rejects injected container ids", () => {
    expect(() => containerCommand("stop", "web; rm -rf /")).toThrow();
    expect(() => containerCommand("logs", "$(id)")).toThrow();
    expect(containerCommand("restart", "web_1")).toBe("docker restart web_1");
    expect(containerCommand("logs", "abc123")).toContain("--tail 200 abc123");
  });
});

describe("sql safety", () => {
  const ro = (s: string) => classifySql(s).readOnly;
  it("allows plain reads", () => {
    for (const s of [
      "SELECT * FROM users",
      "select 1; select 2",
      "WITH a AS (SELECT 1) SELECT * FROM a",
      "EXPLAIN SELECT 1",
      "PRAGMA table_info(users)",
      "SHOW TABLES",
    ])
      expect(ro(s), s).toBe(true);
  });
  it("requires approval for anything that can change data", () => {
    for (const s of [
      "DROP TABLE users",
      "delete from t",
      "UPDATE t SET a=1",
      "INSERT INTO t VALUES (1)",
      "TRUNCATE t",
      "ALTER TABLE t ADD c int",
      "SELECT 1; DROP TABLE t",
      "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
      "EXPLAIN ANALYZE DELETE FROM t",
      "PRAGMA writable_schema = 1",
      "SELECT * INTO backup FROM t",
      "CREATE TABLE x(a int)",
      "ATTACH DATABASE 'x' AS y",
      "",
    ])
      expect(ro(s), s).toBe(false);
  });
  it("is not fooled by comments or string literals", () => {
    expect(ro("SELECT 'DROP TABLE x' AS s")).toBe(true);
    expect(ro("-- harmless\nSELECT 1")).toBe(true);
    expect(ro("/* x */ DELETE FROM t")).toBe(false);
    expect(ro("SELECT 1; /* ; */ DROP TABLE t")).toBe(false);
  });
  it("enforces read-only at the engine level and quotes safely", () => {
    expect(
      buildQueryCommand(
        { kind: "sqlite", target: "/tmp/a b.db" },
        "SELECT 1",
        false,
      ),
    ).toBe("sqlite3 -json -readonly '/tmp/a b.db' 'SELECT 1'");
    expect(
      buildQueryCommand(
        { kind: "sqlite", target: "/d.db" },
        "DELETE FROM t",
        true,
      ),
    ).not.toContain("-readonly");
    expect(
      buildQueryCommand(
        { kind: "postgres", target: "postgres://h/db" },
        "SELECT 1",
        false,
      ),
    ).toContain("default_transaction_read_only=on");
    expect(
      buildQueryCommand(
        { kind: "mysql", target: "-h x db" },
        "SELECT 1",
        false,
      ),
    ).toContain("READ ONLY");
    expect(
      buildQueryCommand(
        { kind: "sqlite", target: "/d.db" },
        "SELECT 'x'",
        false,
      ),
    ).toContain(`'SELECT '\\''x'\\'''`);
  });
  it("rejects bad identifiers and parses results", () => {
    expect(() => describeSql("sqlite", "t; DROP TABLE x")).toThrow();
    expect(parseResult("sqlite", `[{"id":1,"n":null}]`)).toEqual({
      columns: ["id", "n"],
      rows: [["1", "NULL"]],
    });
    expect(parseResult("postgres", 'a,b\n1,"x,y"\n').rows).toEqual([
      ["1", "x,y"],
    ]);
    expect(parseResult("mysql", "a\tb\n1\t2\n").rows).toEqual([["1", "2"]]);
  });
});

describe("github", () => {
  it("parses PRs with CI state", () => {
    const out = JSON.stringify([
      {
        number: 1,
        title: "A",
        state: "OPEN",
        author: { login: "me" },
        headRefName: "f",
        isDraft: false,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      {
        number: 2,
        title: "B",
        state: "OPEN",
        author: { login: "x" },
        headRefName: "g",
        isDraft: true,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      },
    ]);
    const prs = parsePrs(out);
    expect(prs.map((p) => p.ci)).toEqual(["passing", "failing"]);
    expect(prs[0].author).toBe("me");
    expect(ciState([])).toBe("none");
    expect(ciState([{ status: "IN_PROGRESS" }])).toBe("pending");
    expect(parsePrs("not json")).toEqual([]);
  });
  it("parses issues and runs", () => {
    expect(
      parseIssues(
        JSON.stringify([
          {
            number: 3,
            title: "t",
            state: "OPEN",
            author: { login: "a" },
            labels: [{ name: "bug" }],
          },
        ]),
      )[0].labels,
    ).toEqual(["bug"]);
    expect(
      parseRuns(
        JSON.stringify([
          {
            databaseId: 9,
            displayTitle: "CI",
            status: "completed",
            conclusion: "success",
            headBranch: "main",
            workflowName: "ci",
          },
        ]),
      )[0].id,
    ).toBe(9);
  });
  it("validates PR numbers and builds a read-only, redacted review prompt", () => {
    expect(() => GH.prDiff(0)).toThrow();
    expect(GH.prDiff(12)).toBe("gh pr diff 12");
    const p = buildReviewPrompt(
      { number: 1, title: "T" },
      "+API_KEY=abcdef123456secretvalue",
    );
    expect(p).not.toContain("abcdef123456secretvalue");
    expect(p).toContain("Do not modify files, merge, approve or push");
  });
});

describe("api tester", () => {
  const base = {
    method: "POST" as const,
    url: "http://localhost:3000/api",
    headers: "X-A: 1\n# c",
    query: "q=1\nq=2",
    body: '{"a":1}',
  };
  it("builds URL, headers and JSON body", () => {
    const r = buildRequest(base);
    expect(r.url).toBe("http://localhost:3000/api?q=1&q=2");
    expect(r.headers["Content-Type"]).toBe("application/json");
    expect(r.headers["X-A"]).toBe("1");
    expect(r.body).not.toBeNull();
  });
  it("validates input", () => {
    expect(() => buildRequest({ ...base, url: "nope" })).toThrow(/Invalid URL/);
    expect(() => buildRequest({ ...base, url: "file:///etc/passwd" })).toThrow(
      /http/,
    );
    expect(() => buildRequest({ ...base, body: "{bad" })).toThrow(/JSON/);
    expect(buildRequest({ ...base, method: "GET" }).body).toBeNull();
  });
  it("redacts credentials before anything goes to the AI", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer x",
        "X-Api-Key": "k",
        Accept: "a",
      }),
    ).toEqual({
      Authorization: "<REDACTED>",
      "X-Api-Key": "<REDACTED>",
      Accept: "a",
    });
    const p = buildFailurePrompt(
      buildRequest({ ...base, headers: "Authorization: Bearer topsecret" }),
      {
        status: 500,
        headers: { "set-cookie": "s=1" },
        body: "boom",
        ms: 5,
        bytes: 4,
      },
      null,
      (s) => s,
    );
    expect(p).not.toContain("topsecret");
    expect(p).not.toContain("s=1");
    expect(p).toContain("500");
  });
  it("pretty prints JSON", () => {
    expect(prettyBody('{"a":1}', { "Content-Type": "application/json" })).toBe(
      '{\n  "a": 1\n}',
    );
  });
});

describe("external agents", () => {
  it("quotes the task so it cannot break out of the shell", () => {
    const c = launchCommand("claude", "fix it'; rm -rf / #");
    expect(c).toBe(`claude ${shq("fix it'; rm -rf / #")}`);
    expect(launchCommand("aider", "x")).toBe("aider --message 'x'");
    expect(() => launchCommand("nope", "x")).toThrow();
    expect(() => launchCommand("claude", "  ")).toThrow();
  });
  it("pipeline prompt keeps edits on approval-gated tools", () => {
    const p = buildPipelinePrompt("Fix auth bug");
    expect(p).toContain("run_subagent");
    expect(p).toContain("edit/multi_edit");
    expect(p).toContain("PLAN");
    expect(p).toContain("REVIEW");
  });
});
