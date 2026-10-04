/**
 * Project detection → setup steps and health checks. Pure: callers supply the
 * root file names and parsed manifests, so nothing here touches the disk.
 * Commands are derived from the project's own scripts/manifests, never assumed.
 */

export type PackageManager =
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "cargo"
  | "pip"
  | "poetry"
  | "uv"
  | "go";

export type ProjectFacts = {
  /** Root file names that exist. */
  files: Set<string>;
  packageJson?: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  /** Contents of .env.example (keys only are used). */
  envExample?: string | null;
  /** Whether node_modules/ exists (Node projects). */
  hasNodeModules?: boolean;
  composeText?: string | null;
};

export type Step = { id: string; label: string; command: string };
export type Check = Step;

export type ProjectAnalysis = {
  languages: string[];
  packageManager: PackageManager | null;
  framework: string | null;
  databases: string[];
  docker: boolean;
  needsEnv: boolean;
  envKeys: string[];
  devCommand: string | null;
  setup: Step[];
  checks: Check[];
};

const NODE_LOCKS: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

export const PROBE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "package-lock.json",
  "Cargo.toml",
  "requirements.txt",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "go.mod",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".env",
  ".env.example",
  "Makefile",
  "README.md",
] as const;

const FRAMEWORKS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["@remix-run/react", "Remix"],
  ["vite", "Vite"],
  ["react-scripts", "Create React App"],
  ["@angular/core", "Angular"],
  ["vue", "Vue"],
  ["react", "React"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["@tauri-apps/api", "Tauri"],
];

const DB_HINTS: Array<[RegExp, string]> = [
  [/postgres|pg(?:vector)?\b|psycopg|asyncpg/i, "PostgreSQL"],
  [/mysql|mariadb/i, "MySQL"],
  [/mongo/i, "MongoDB"],
  [/redis/i, "Redis"],
  [/sqlite/i, "SQLite"],
];

function run(pm: PackageManager, script: string): string {
  if (pm === "npm") return `npm run ${script}`;
  if (pm === "yarn") return `yarn ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `${pm} run ${script}`;
}

function pick(scripts: Record<string, string>, names: string[]): string | null {
  return names.find((n) => typeof scripts[n] === "string") ?? null;
}

export function parseEnvKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

export function analyzeProject(f: ProjectFacts): ProjectAnalysis {
  const has = (n: string) => f.files.has(n);
  const languages: string[] = [];
  const setup: Step[] = [];
  const checks: Check[] = [];
  let pm: PackageManager | null = null;
  let framework: string | null = null;
  let devCommand: string | null = null;
  const depText: string[] = [];

  if (has("package.json")) {
    const pkg = f.packageJson ?? {};
    const scripts = pkg.scripts ?? {};
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    languages.push(
      has("tsconfig.json") || "typescript" in deps
        ? "TypeScript"
        : "JavaScript",
    );
    pm = NODE_LOCKS.find(([lock]) => has(lock))?.[1] ?? "npm";
    framework = FRAMEWORKS.find(([dep]) => dep in deps)?.[1] ?? null;
    depText.push(...Object.keys(deps));
    if (!f.hasNodeModules)
      setup.push({
        id: "install",
        label: "Install dependencies",
        command: `${pm} install`,
      });
    const dev = pick(scripts, ["dev", "start", "serve"]);
    if (dev) devCommand = run(pm, dev);
    const tc = pick(scripts, ["typecheck", "check-types", "type-check", "tsc"]);
    const lint = pick(scripts, ["lint", "check"]);
    const test = pick(scripts, ["test", "test:unit"]);
    const build = pick(scripts, ["build"]);
    if (tc) checks.push({ id: "types", label: "Types", command: run(pm, tc) });
    else if (has("tsconfig.json"))
      checks.push({ id: "types", label: "Types", command: "npx tsc --noEmit" });
    if (lint)
      checks.push({ id: "lint", label: "Lint", command: run(pm, lint) });
    if (test)
      checks.push({ id: "test", label: "Tests", command: run(pm, test) });
    if (build)
      checks.push({ id: "build", label: "Build", command: run(pm, build) });
    checks.push({
      id: "audit",
      label: "Dependencies (audit)",
      command:
        pm === "pnpm"
          ? "pnpm audit --audit-level high"
          : pm === "yarn"
            ? "yarn npm audit --severity high"
            : pm === "bun"
              ? "bun audit"
              : "npm audit --audit-level=high",
    });
  }
  if (has("Cargo.toml")) {
    languages.push("Rust");
    pm ??= "cargo";
    if (!devCommand) devCommand = "cargo run";
    checks.push({
      id: "rust-check",
      label: "Cargo check",
      command: "cargo check",
    });
    checks.push({
      id: "rust-test",
      label: "Cargo tests",
      command: "cargo test",
    });
    checks.push({
      id: "rust-build",
      label: "Cargo build",
      command: "cargo build",
    });
  }
  if (has("pyproject.toml") || has("requirements.txt")) {
    languages.push("Python");
    const py = has("uv.lock") ? "uv" : has("poetry.lock") ? "poetry" : "pip";
    pm ??= py;
    if (py === "uv")
      setup.push({
        id: "py-install",
        label: "Sync Python dependencies",
        command: "uv sync",
      });
    else if (py === "poetry")
      setup.push({
        id: "py-install",
        label: "Install Python dependencies",
        command: "poetry install",
      });
    else if (has("requirements.txt"))
      setup.push({
        id: "py-install",
        label: "Install Python dependencies",
        command: "python3 -m pip install -r requirements.txt",
      });
    checks.push({
      id: "py-test",
      label: "Tests",
      command: "python3 -m pytest -q",
    });
  }
  if (has("go.mod")) {
    languages.push("Go");
    pm ??= "go";
    if (!devCommand) devCommand = "go run .";
    setup.push({
      id: "go-mod",
      label: "Download Go modules",
      command: "go mod download",
    });
    checks.push({ id: "go-vet", label: "Go vet", command: "go vet ./..." });
    checks.push({ id: "go-test", label: "Go tests", command: "go test ./..." });
    checks.push({
      id: "go-build",
      label: "Go build",
      command: "go build ./...",
    });
  }

  const compose = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ].find(has);
  const docker = has("Dockerfile") || !!compose;
  const envKeys = parseEnvKeys(f.envExample);
  const needsEnv = has(".env.example") && !has(".env");
  if (needsEnv)
    setup.unshift({
      id: "env",
      label: "Create .env from .env.example",
      command: "cp -n .env.example .env",
    });
  if (compose && f.composeText) {
    const svc = DB_HINTS.filter(([re]) => re.test(f.composeText ?? "")).map(
      ([, n]) => n,
    );
    depText.push(...svc);
  }
  const hay = [...depText, ...envKeys, f.envExample ?? ""].join(" ");
  const databases = [
    ...new Set(DB_HINTS.filter(([re]) => re.test(hay)).map(([, n]) => n)),
  ];
  if (compose && databases.length > 0)
    setup.push({
      id: "services",
      label: "Start services (docker compose up -d)",
      command: "docker compose up -d",
    });

  return {
    languages,
    packageManager: pm,
    framework,
    databases,
    docker,
    needsEnv,
    envKeys,
    devCommand,
    setup,
    checks,
  };
}

/** Commands that must never be offered as one-click steps. */
const DESTRUCTIVE =
  /\b(rm\s+-rf|drop\s+(database|table)|truncate|--force|reset\s+--hard|migrate\s+reset|db\s+push\s+--force)\b/i;
export function isSafeSetupCommand(cmd: string): boolean {
  return !DESTRUCTIVE.test(cmd);
}
