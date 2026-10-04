import { tool } from "ai";
import { z } from "zod";
import { sshNative } from "@/modules/ssh/lib/native";
import { redactSensitive } from "../lib/redact";
import {
  checkReadable,
  checkShellCommand,
  checkWritable,
} from "../lib/security";
import type { ToolContext } from "./context";

const MAX_RETURN_CHARS = 200_000;

function cap(s: string): string {
  return s.length > MAX_RETURN_CHARS
    ? `${s.slice(0, MAX_RETURN_CHARS)}\n[... truncated ...]`
    : s;
}

/**
 * Remote (SSH) tools. They address hosts by id only — the Rust side builds the
 * ssh command line, so the model can never inject ssh options. Anything that
 * runs code or changes a remote file asks for approval, and every tool reuses
 * the local path / command safety checks.
 */
export function buildRemoteTools(_ctx: ToolContext) {
  return {
    remote_hosts: tool({
      description:
        "List configured SSH hosts (id, label, target, default remote_dir). Use the `id` with the other remote_* tools. Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const hosts = await sshNative.listHosts();
          return {
            hosts: hosts.map((h) => ({
              id: h.id,
              label: h.label,
              target: h.target,
              user: h.user,
              port: h.port,
              remote_dir: h.remote_dir,
            })),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    remote_run: tool({
      description:
        "Run a shell command on a remote SSH host (also use it for remote git, `ps`, `docker ps`, `tail` of logs). Uses key/agent auth only and a trusted host key. Output is truncated. Never run interactive programs. Asks for user approval.",
      inputSchema: z.object({
        host_id: z.string(),
        command: z.string(),
        cwd: z.string().optional(),
        timeout_secs: z.number().int().min(1).max(300).optional(),
      }),
      needsApproval: true,
      execute: async ({ host_id, command, cwd, timeout_secs }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        try {
          const r = await sshNative.exec(host_id, command, cwd, timeout_secs);
          return {
            host_id,
            command,
            stdout: redactSensitive(cap(r.stdout)),
            stderr: redactSensitive(cap(r.stderr)),
            exit_code: r.exit_code,
            timed_out: r.timed_out,
            truncated: r.truncated,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    remote_list_dir: tool({
      description:
        "List a directory on a remote SSH host (directories first). Requires GNU find on the host. Auto-executes.",
      inputSchema: z.object({ host_id: z.string(), path: z.string() }),
      execute: async ({ host_id, path }) => {
        try {
          const entries = await sshNative.listDir(host_id, path);
          return { host_id, path, entries };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    remote_read_file: tool({
      description:
        "Read a text file from a remote SSH host (max 2 MB). Refuses secret paths such as .env, .ssh/ and credentials. Auto-executes.",
      inputSchema: z.object({ host_id: z.string(), path: z.string() }),
      execute: async ({ host_id, path }) => {
        const safety = checkReadable(path);
        if (!safety.ok) return { error: safety.reason, path };
        try {
          const r = await sshNative.readFile(host_id, path);
          if (r.kind === "binary")
            return { error: "binary file refused", path };
          if (r.kind === "toolarge")
            return { error: `file too large (${r.size} bytes)`, path };
          return { host_id, path, content: redactSensitive(r.content) };
        } catch (e) {
          return { error: String(e), path };
        }
      },
    }),

    remote_write_file: tool({
      description:
        "Write (overwrite) a file on a remote SSH host with the full new content. Refuses secret paths. Read the file first when changing an existing one. Asks for user approval.",
      inputSchema: z.object({
        host_id: z.string(),
        path: z.string(),
        content: z.string(),
      }),
      needsApproval: true,
      execute: async ({ host_id, path, content }) => {
        const safety = checkWritable(path);
        if (!safety.ok) return { error: safety.reason, path };
        try {
          await sshNative.writeFile(host_id, path, content);
          return { ok: true, host_id, path, bytesWritten: content.length };
        } catch (e) {
          return { error: String(e), path };
        }
      },
    }),
  } as const;
}
