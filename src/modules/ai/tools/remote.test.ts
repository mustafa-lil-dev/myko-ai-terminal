import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  listHosts: vi.fn(),
  exec: vi.fn(),
  listDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@/modules/ssh/lib/native", () => ({ sshNative: native }));

import type { ToolContext } from "./context";
import { buildRemoteTools } from "./remote";

const tools = buildRemoteTools({} as ToolContext);
// biome-ignore lint/suspicious/noExplicitAny: test helper for tool execute()
const run = (t: any, input: unknown) => t.execute(input, {});

describe("remote tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires approval for exec and write, not for reads", () => {
    expect(tools.remote_run.needsApproval).toBe(true);
    expect(tools.remote_write_file.needsApproval).toBe(true);
    expect("needsApproval" in tools.remote_read_file).toBe(false);
    expect("needsApproval" in tools.remote_list_dir).toBe(false);
  });

  it("refuses secret paths before touching the network", async () => {
    for (const path of ["/srv/app/.env", "/home/u/.ssh/id_ed25519"]) {
      const r = await run(tools.remote_read_file, { host_id: "saved:a", path });
      expect(r.error).toMatch(/Refused/);
    }
    const w = await run(tools.remote_write_file, {
      host_id: "saved:a",
      path: "/home/u/.ssh/authorized_keys",
      content: "x",
    });
    expect(w.error).toMatch(/Refused/);
    expect(native.readFile).not.toHaveBeenCalled();
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("redacts secrets in command output and file content", async () => {
    native.exec.mockResolvedValue({
      stdout: "API_KEY=supersecretvalue123\nok",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      truncated: false,
    });
    const r = await run(tools.remote_run, {
      host_id: "saved:a",
      command: "env",
    });
    expect(r.stdout).not.toContain("supersecretvalue123");

    native.readFile.mockResolvedValue({
      kind: "text",
      content: "token: sk-ant-abcdefghijklmnopqrstuvwxyz012345",
      size: 10,
    });
    const f = await run(tools.remote_read_file, {
      host_id: "saved:a",
      path: "/srv/app/config.yml",
    });
    expect(f.content).toContain("<REDACTED");
  });

  it("surfaces backend errors instead of throwing", async () => {
    native.exec.mockRejectedValue("Host key is not trusted yet.");
    const r = await run(tools.remote_run, {
      host_id: "saved:a",
      command: "ls",
    });
    expect(r.error).toContain("not trusted");
  });
});
