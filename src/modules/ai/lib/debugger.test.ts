import { describe, expect, it } from "vitest";
import { buildDebugPrompt, detectError } from "./debugger";

describe("detectError", () => {
  it("ignores successful commands", () => {
    expect(detectError("error TS1: x", 0)).toBeNull();
    expect(detectError("boom", null)).toBeNull();
  });

  it("parses TypeScript errors with file and line", () => {
    const e = detectError(
      "src/UserProfile.tsx(48,12): error TS2339: Property 'x' does not exist",
      2,
    );
    expect(e?.kind).toBe("typescript");
    expect(e?.file).toBe("src/UserProfile.tsx");
    expect(e?.line).toBe(48);
  });

  it("parses Rust errors", () => {
    const e = detectError(
      "error[E0425]: cannot find value `x`\n --> src/main.rs:10:5",
      101,
    );
    expect(e?.kind).toBe("rust");
    expect(e?.file).toBe("src/main.rs");
    expect(e?.line).toBe(10);
  });

  it("parses Node stack frames", () => {
    const e = detectError(
      "TypeError: Cannot read properties of undefined\n    at render (/app/src/UserProfile.tsx:48:12)",
      1,
    );
    expect(e?.kind).toBe("node");
    expect(e?.file).toBe("/app/src/UserProfile.tsx");
    expect(e?.line).toBe(48);
  });

  it("falls back to the last output line", () => {
    const e = detectError("starting\nsomething odd happened\n", 3);
    expect(e?.kind).toBe("generic");
    expect(e?.summary).toBe("something odd happened");
  });

  it("strips ANSI escapes", () => {
    const e = detectError("\x1b[31merror TS2322: bad\x1b[0m", 1);
    expect(e?.summary).toBe("error TS2322: bad");
  });
});

describe("buildDebugPrompt", () => {
  const base = {
    command: "pnpm build",
    cwd: "/p",
    exitCode: 1,
    output: "API_KEY=abc123supersecret\nerror TS2322: bad",
    error: detectError("error TS2322: bad", 1),
  };

  it("redacts secrets in output", () => {
    const p = buildDebugPrompt({ ...base, action: "fix" });
    expect(p).not.toContain("abc123supersecret");
    expect(p).toContain("<REDACTED>");
  });

  it("fix routes through approval-gated tools; explain does not edit", () => {
    expect(buildDebugPrompt({ ...base, action: "fix" })).toContain(
      "edit/multi_edit",
    );
    expect(buildDebugPrompt({ ...base, action: "explain" })).toContain(
      "Do not modify",
    );
  });
});
