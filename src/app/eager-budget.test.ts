import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const srcAlias = join(root, "src");
const HEAVY = ["@ai-sdk", "ai", "streamdown", "@codemirror", "@uiw"];

const STATIC_IMPORT =
  /(?:^|\n)\s*import\s+(?!type[\s{])(?:[^"';]*?from\s*)?["']([^"']+)["']/g;
const STATIC_EXPORT_FROM =
  /(?:^|\n)\s*export\s+(?!type[\s{])[^"';]*?from\s*["']([^"']+)["']/g;

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;

  if (spec.startsWith("@/")) base = join(srcAlias, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;

  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs"];
  for (const ext of exts) {
    const p = ext ? base + ext : base;
    if (ext && existsSync(p) && statSync(p).isFile()) return p;
    if (!ext) {
      const idx = join(base, "index.ts");
      if (existsSync(idx) && statSync(idx).isFile()) return idx;
    }
  }

  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const p = join(base, `index${ext}`);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }

  return null;
}

function staticSpecs(code: string): string[] {
  const specs = new Set<string>();
  for (const re of [STATIC_IMPORT, STATIC_EXPORT_FROM]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code))) specs.add(match[1]);
  }
  return [...specs];
}

function pkgOf(spec: string, watch: string[]): string | undefined {
  return watch.find((w) => spec === w || spec.startsWith(`${w}/`));
}

function traceEager(entry: string, watch = HEAVY): { hits: Map<string, { spec: string; file: string }> } {
  const entryFile = resolve(root, entry);
  const seen = new Set<string>();
  const queue = [entryFile];
  const hits = new Map<string, { spec: string; file: string }>();

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    let code: string;
    try {
      code = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const spec of staticSpecs(code)) {
      const local = resolveLocal(spec, file);
      if (local) {
        queue.push(local);
        continue;
      }

      const pkg = pkgOf(spec, watch);
      if (pkg && !hits.has(pkg)) {
        hits.set(pkg, { spec, file: file.replace(`${root}/`, "") });
      }
    }
  }

  return { hits };
}

// Locks the startup-bundle invariant: the heavy editor / AI / markdown stacks
// must stay out of the eager graph of both window entries so they load only
// when the user opens those surfaces. A static import that re-introduces any of
// these (e.g. a barrel re-export of chat runtime, or a `cn`-style util getting
// absorbed into a feature chunk) will fail here. xterm and motion are
// intentionally eager (terminal-first shell) and are not asserted against.
function heavyEagerHits(entry: string): string[] {
  const { hits } = traceEager(entry, HEAVY);
  return [...hits.entries()].map(([pkg, info]) => `${pkg} <- ${info.file}`);
}

describe("startup bundle budget", () => {
  it("main window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/main.tsx")).toEqual([]);
  });

  it("settings window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/settings/main.tsx")).toEqual([]);
  });
});
