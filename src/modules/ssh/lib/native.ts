import { invoke } from "@tauri-apps/api/core";

export type SshHost = {
  id: string;
  label: string;
  target: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  remote_dir: string | null;
  source: "saved" | "config";
};

export type SshHostInput = {
  id?: string | null;
  label: string;
  target: string;
  user?: string | null;
  port?: number | null;
  identity_file?: string | null;
  remote_dir?: string | null;
};

export type SshCommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export type SshEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type SshReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type SshForward = {
  id: number;
  host_id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
};

/**
 * Thin bindings over the Rust `ssh` module. The UI only ever handles host ids
 * and non-secret host settings: key files are referenced by path and never
 * read here, and passwords are typed into a terminal tab, not into React.
 */
export const sshNative = {
  listHosts: () => invoke<SshHost[]>("ssh_list_hosts"),
  saveHost: (host: SshHostInput) => invoke<SshHost>("ssh_save_host", { host }),
  deleteHost: (id: string) => invoke<void>("ssh_delete_host", { id }),
  terminalCommand: (id: string) =>
    invoke<string>("ssh_terminal_command", { id }),
  exec: (
    id: string,
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<SshCommandOutput>("ssh_exec", {
      id,
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
    }),
  listDir: (id: string, path: string) =>
    invoke<SshEntry[]>("ssh_list_dir", { id, path }),
  readFile: (id: string, path: string) =>
    invoke<SshReadResult>("ssh_read_file", { id, path }),
  writeFile: (id: string, path: string, content: string) =>
    invoke<void>("ssh_write_file", { id, path, content }),
  forwardStart: (
    id: string,
    localPort: number,
    remotePort: number,
    remoteHost?: string,
  ) =>
    invoke<SshForward>("ssh_forward_start", {
      id,
      localPort,
      remoteHost: remoteHost ?? null,
      remotePort,
    }),
  forwardStop: (id: number) => invoke<void>("ssh_forward_stop", { id }),
  forwardList: () => invoke<SshForward[]>("ssh_forward_list"),
};
