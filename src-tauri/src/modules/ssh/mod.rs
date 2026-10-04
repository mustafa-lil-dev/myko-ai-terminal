//! SSH support built on the system OpenSSH client.
//!
//! Myko never sees private keys or passwords: authentication, `known_hosts`,
//! agents and `~/.ssh/config` are all handled by `ssh` itself. Non-interactive
//! operations (exec / file access / port forwards) run with `BatchMode=yes` and
//! `StrictHostKeyChecking=yes`, so they only work for key/agent-authenticated
//! hosts whose host key is already trusted. Password logins and first-time
//! host-key verification happen in a normal terminal tab (see
//! `ssh_terminal_command`), where the user answers ssh's own prompts.
//!
//! The frontend only ever passes a host *id*; every ssh argument is built here
//! from validated fields, so a hostname such as `-oProxyCommand=...` can never
//! reach the ssh command line.
//!
//! This module is self-contained: removing `pub mod ssh;`, the `.manage(...)`
//! call and the handler entries in `lib.rs` disables SSH entirely.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shared_child::SharedChild;

pub mod commands;

const MAX_EXEC_OUTPUT: usize = 1024 * 1024;
pub const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;

// ───────────────────────── hosts ─────────────────────────

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum HostSource {
    /// Defined by the user inside Myko.
    #[default]
    Saved,
    /// Discovered in `~/.ssh/config` (read-only; ssh resolves its settings).
    Config,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SshHost {
    pub id: String,
    pub label: String,
    /// Hostname, IP address or ssh_config alias.
    pub target: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// Path to a private key file. The key contents are never read by Myko.
    pub identity_file: Option<String>,
    pub remote_dir: Option<String>,
    #[serde(default)]
    pub source: HostSource,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SshHostInput {
    pub id: Option<String>,
    pub label: String,
    pub target: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub remote_dir: Option<String>,
}

fn has_control(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

/// Hostnames, IPs and aliases. Must not start with `-` (option injection).
pub fn valid_target(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
}

pub fn valid_user(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn valid_path_text(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && !has_control(s) && !s.contains('"')
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn validate_input(input: SshHostInput) -> Result<SshHostInput, String> {
    let label = input.label.trim().to_string();
    if label.is_empty() || label.len() > 64 || has_control(&label) {
        return Err("invalid label".into());
    }
    let target = input.target.trim().to_string();
    if !valid_target(&target) {
        return Err("invalid host: use a hostname, IP address or ssh_config alias".into());
    }
    let user = clean_opt(input.user);
    if let Some(u) = &user {
        if !valid_user(u) {
            return Err("invalid user".into());
        }
    }
    if input.port == Some(0) {
        return Err("invalid port".into());
    }
    let identity_file = clean_opt(input.identity_file);
    if let Some(p) = &identity_file {
        if !valid_path_text(p) {
            return Err("invalid identity file path".into());
        }
    }
    let remote_dir = clean_opt(input.remote_dir);
    if let Some(p) = &remote_dir {
        if !valid_path_text(p) {
            return Err("invalid remote directory".into());
        }
    }
    Ok(SshHostInput {
        id: input.id,
        label,
        target,
        user,
        port: input.port,
        identity_file,
        remote_dir,
    })
}

fn slug(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "host".into()
    } else {
        s
    }
}

/// Aliases from `~/.ssh/config` `Host` lines (wildcards and negations skipped).
pub fn parse_ssh_config(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let Some(key) = it.next() else { continue };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for alias in it {
            if alias.starts_with('#') {
                break;
            }
            if alias.contains(['*', '?', '!']) || !valid_target(alias) {
                continue;
            }
            if !out.iter().any(|a| a == alias) {
                out.push(alias.to_string());
            }
        }
    }
    out
}

pub fn load_saved(path: &Path) -> Vec<SshHost> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let hosts: Vec<SshHost> = serde_json::from_str(&raw).unwrap_or_default();
    // Re-validate on load: the file lives in a user-writable directory.
    hosts
        .into_iter()
        .filter(|h| {
            h.id.starts_with("saved:")
                && valid_target(&h.target)
                && h.user.as_deref().map_or(true, valid_user)
                && h.port != Some(0)
                && h.identity_file.as_deref().map_or(true, valid_path_text)
                && h.remote_dir.as_deref().map_or(true, valid_path_text)
        })
        .map(|mut h| {
            h.source = HostSource::Saved;
            h
        })
        .collect()
}

fn store_saved(path: &Path, hosts: &[SshHost]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(hosts).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

static STORE_LOCK: Mutex<()> = Mutex::new(());

pub fn list_hosts(store: &Path, ssh_config: Option<&Path>) -> Vec<SshHost> {
    let mut hosts = load_saved(store);
    if let Some(cfg) = ssh_config {
        if let Ok(text) = std::fs::read_to_string(cfg) {
            for alias in parse_ssh_config(&text) {
                hosts.push(SshHost {
                    id: format!("config:{alias}"),
                    label: alias.clone(),
                    target: alias,
                    user: None,
                    port: None,
                    identity_file: None,
                    remote_dir: None,
                    source: HostSource::Config,
                });
            }
        }
    }
    hosts
}

pub fn save_host(store: &Path, input: SshHostInput) -> Result<SshHost, String> {
    let input = validate_input(input)?;
    let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut hosts = load_saved(store);
    let id = match &input.id {
        Some(id) if id.starts_with("saved:") => {
            if !hosts.iter().any(|h| &h.id == id) {
                return Err("unknown host".into());
            }
            id.clone()
        }
        Some(_) => return Err("only saved hosts can be edited".into()),
        None => {
            let base = slug(&input.label);
            let mut n = 1;
            loop {
                let candidate = if n == 1 {
                    format!("saved:{base}")
                } else {
                    format!("saved:{base}-{n}")
                };
                if !hosts.iter().any(|h| h.id == candidate) {
                    break candidate;
                }
                n += 1;
            }
        }
    };
    let host = SshHost {
        id: id.clone(),
        label: input.label,
        target: input.target,
        user: input.user,
        port: input.port,
        identity_file: input.identity_file,
        remote_dir: input.remote_dir,
        source: HostSource::Saved,
    };
    match hosts.iter_mut().find(|h| h.id == id) {
        Some(slot) => *slot = host.clone(),
        None => hosts.push(host.clone()),
    }
    store_saved(store, &hosts)?;
    Ok(host)
}

pub fn delete_host(store: &Path, id: &str) -> Result<(), String> {
    let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut hosts = load_saved(store);
    let before = hosts.len();
    hosts.retain(|h| h.id != id);
    if hosts.len() == before {
        return Ok(());
    }
    store_saved(store, &hosts)
}

pub fn find_host(
    store: &Path,
    ssh_config: Option<&Path>,
    id: &str,
) -> Result<SshHost, String> {
    list_hosts(store, ssh_config)
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| "unknown SSH host".to_string())
}

// ───────────────────────── argument building ─────────────────────────

/// POSIX single-quote escaping for a remote shell.
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A remote path argument that keeps a leading `~` expandable.
pub fn remote_path_arg(p: &str) -> String {
    if p == "~" {
        "~".into()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("~/{}", shq(rest))
    } else {
        shq(p)
    }
}

/// ssh arguments up to and including the target. `interactive` is for a
/// terminal tab (ssh may prompt); otherwise the call is non-interactive and
/// hardened.
pub fn ssh_args(host: &SshHost, interactive: bool) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut opt = |o: &str| {
        a.push("-o".into());
        a.push(o.into());
    };
    if !interactive {
        opt("BatchMode=yes");
        opt("ConnectTimeout=10");
        opt("StrictHostKeyChecking=yes");
        opt("ForwardAgent=no");
        opt("ForwardX11=no");
    }
    opt("ServerAliveInterval=15");
    opt("ServerAliveCountMax=3");
    if let Some(p) = host.port {
        a.push("-p".into());
        a.push(p.to_string());
    }
    if let Some(u) = &host.user {
        a.push("-l".into());
        a.push(u.clone());
    }
    if let Some(i) = &host.identity_file {
        a.push("-i".into());
        a.push(i.clone());
        a.push("-o".into());
        a.push("IdentitiesOnly=yes".into());
    }
    a.push("--".into());
    a.push(host.target.clone());
    a
}

fn quote_for_typing(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '%' | '+' | '=' | ':' | ',' | '.' | '/' | '-' | '\\'));
    if plain {
        s.to_string()
    } else if cfg!(windows) {
        format!("\"{s}\"")
    } else {
        shq(s)
    }
}

/// The command line to type into a local terminal tab to open an interactive
/// session. The user answers any password / host-key prompts in that terminal.
pub fn terminal_command(host: &SshHost) -> String {
    let mut parts = vec!["ssh".to_string()];
    parts.extend(ssh_args(host, true).iter().map(|a| quote_for_typing(a)));
    if let Some(dir) = &host.remote_dir {
        // Start in the remote working directory with an interactive login shell.
        parts.insert(1, "-t".into());
        parts.push(quote_for_typing(&format!(
            "cd {} && exec \"${{SHELL:-/bin/sh}}\" -l",
            remote_path_arg(dir)
        )));
    }
    parts.join(" ")
}

// ───────────────────────── execution ─────────────────────────

#[derive(Debug, Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

struct RawOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<i32>,
    timed_out: bool,
    truncated: bool,
}

fn drain(r: &mut impl Read, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(buf.len());
                if room >= n {
                    buf.extend_from_slice(&chunk[..n]);
                } else {
                    buf.extend_from_slice(&chunk[..room]);
                    truncated = true; // keep draining so ssh never blocks
                }
            }
        }
    }
    (buf, truncated)
}

fn run_raw(
    host: &SshHost,
    remote_cmd: &str,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    out_cap: usize,
) -> Result<RawOutput, String> {
    let mut cmd = Command::new("ssh");
    cmd.args(ssh_args(host, false)).arg(remote_cmd);
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "OpenSSH client (`ssh`) was not found on PATH".to_string()
        } else {
            e.to_string()
        }
    })?);
    let mut out = child.take_stdout().ok_or("no stdout pipe")?;
    let mut err = child.take_stderr().ok_or("no stderr pipe")?;
    let out_h = thread::spawn(move || drain(&mut out, out_cap));
    let err_h = thread::spawn(move || drain(&mut err, 64 * 1024));
    if let Some(data) = stdin {
        if let Some(mut w) = child.take_stdin() {
            thread::spawn(move || {
                let _ = w.write_all(&data);
                // dropping `w` closes stdin → remote `cat` sees EOF
            });
        }
    }

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });
    let (exit_code, timed_out) = match rx.recv_timeout(timeout) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("ssh wait thread disconnected".into())
        }
    };
    let (stdout, t1) = out_h.join().unwrap_or((Vec::new(), false));
    let (stderr, t2) = err_h.join().unwrap_or((Vec::new(), false));
    Ok(RawOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
        truncated: t1 || t2,
    })
}

/// Maps well-known ssh connection failures to an actionable message.
pub fn classify_ssh_error(exit_code: Option<i32>, stderr: &str) -> Option<String> {
    if exit_code != Some(255) {
        return None;
    }
    let s = stderr.to_ascii_lowercase();
    if s.contains("host key verification failed") || s.contains("no matching host key") {
        return Some("Host key is not trusted yet. Open an SSH terminal to this host once and verify its fingerprint, then retry.".into());
    }
    if s.contains("permission denied") {
        return Some("Authentication failed. Non-interactive access needs key or agent authentication; password logins work only in an SSH terminal.".into());
    }
    if s.contains("could not resolve hostname") {
        return Some("Could not resolve the hostname.".into());
    }
    if s.contains("connection refused") || s.contains("timed out") || s.contains("no route to host") {
        return Some("Could not connect to the host.".into());
    }
    None
}

fn clamp_timeout(secs: Option<u64>) -> Duration {
    Duration::from_secs(secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS))
}

pub fn exec(
    host: &SshHost,
    command: &str,
    cwd: Option<&str>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("empty command".into());
    }
    let dir = cwd.map(str::trim).filter(|s| !s.is_empty()).or(host.remote_dir.as_deref());
    let remote = match dir {
        Some(d) => {
            if !valid_path_text(d) {
                return Err("invalid remote directory".into());
            }
            format!("cd {} && {}", remote_path_arg(d), command)
        }
        None => command.to_string(),
    };
    let raw = run_raw(host, &remote, None, clamp_timeout(timeout_secs), MAX_EXEC_OUTPUT)?;
    let stderr = String::from_utf8_lossy(&raw.stderr).into_owned();
    if let Some(msg) = classify_ssh_error(raw.exit_code, &stderr) {
        return Err(msg);
    }
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&raw.stdout).into_owned(),
        stderr,
        exit_code: raw.exit_code,
        timed_out: raw.timed_out,
        truncated: raw.truncated,
    })
}

// ───────────────────────── remote files ─────────────────────────

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteRead {
    Text { content: String, size: u64 },
    Binary { size: u64 },
    Toolarge { size: u64, limit: u64 },
}

#[derive(Debug, Serialize, PartialEq)]
pub struct RemoteEntry {
    pub name: String,
    /// "file" | "dir" | "symlink"
    pub kind: String,
    pub size: u64,
    pub mtime: i64,
}

fn check_remote_path(p: &str) -> Result<(), String> {
    if !valid_path_text(p) {
        return Err("invalid remote path".into());
    }
    Ok(())
}

fn run_checked(
    host: &SshHost,
    remote: &str,
    stdin: Option<Vec<u8>>,
    out_cap: usize,
) -> Result<RawOutput, String> {
    let raw = run_raw(host, remote, stdin, clamp_timeout(None), out_cap)?;
    let stderr = String::from_utf8_lossy(&raw.stderr);
    if let Some(msg) = classify_ssh_error(raw.exit_code, &stderr) {
        return Err(msg);
    }
    if raw.timed_out {
        return Err("remote command timed out".into());
    }
    if raw.exit_code != Some(0) {
        let msg = stderr.trim();
        return Err(if msg.is_empty() {
            format!("remote command failed ({:?})", raw.exit_code)
        } else {
            msg.to_string()
        });
    }
    Ok(raw)
}

pub fn parse_find_listing(stdout: &str) -> Vec<RemoteEntry> {
    let mut v: Vec<RemoteEntry> = stdout
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(4, '\t');
            let ty = f.next()?;
            let size = f.next()?.parse::<u64>().ok()?;
            let mtime = f.next()?.split('.').next()?.parse::<i64>().ok()?;
            let name = f.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let kind = match ty {
                "d" => "dir",
                "l" => "symlink",
                _ => "file",
            };
            Some(RemoteEntry { name, kind: kind.into(), size, mtime })
        })
        .collect();
    v.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    v
}

/// Requires GNU `find` (`-printf`) on the remote host.
pub fn list_dir(host: &SshHost, path: &str) -> Result<Vec<RemoteEntry>, String> {
    check_remote_path(path)?;
    let cmd = format!(
        "cd {} 2>/dev/null || {{ echo 'cannot open directory' >&2; exit 2; }}; LC_ALL=C find . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'",
        remote_path_arg(path)
    );
    let raw = run_checked(host, &cmd, None, MAX_EXEC_OUTPUT)?;
    Ok(parse_find_listing(&String::from_utf8_lossy(&raw.stdout)))
}

pub fn parse_read_output(stdout: &[u8], limit: usize) -> Result<RemoteRead, String> {
    let nl = stdout
        .iter()
        .position(|b| *b == b'\n')
        .ok_or("unexpected remote output")?;
    let size: u64 = std::str::from_utf8(&stdout[..nl])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .ok_or("unexpected remote output")?;
    if size as usize > limit {
        return Ok(RemoteRead::Toolarge { size, limit: limit as u64 });
    }
    let body = &stdout[nl + 1..];
    if body.contains(&0) {
        return Ok(RemoteRead::Binary { size });
    }
    match String::from_utf8(body.to_vec()) {
        Ok(content) => Ok(RemoteRead::Text { content, size }),
        Err(_) => Ok(RemoteRead::Binary { size }),
    }
}

pub fn read_file(host: &SshHost, path: &str) -> Result<RemoteRead, String> {
    check_remote_path(path)?;
    let cmd = format!(
        "f={}; [ -f \"$f\" ] || {{ echo 'not a regular file' >&2; exit 2; }}; sz=$(wc -c < \"$f\" | tr -d ' '); echo \"$sz\"; if [ \"$sz\" -le {} ]; then cat -- \"$f\"; fi",
        remote_path_arg(path),
        MAX_READ_BYTES
    );
    let raw = run_checked(host, &cmd, None, MAX_READ_BYTES + 64)?;
    parse_read_output(&raw.stdout, MAX_READ_BYTES)
}

pub fn write_file(host: &SshHost, path: &str, content: &str) -> Result<(), String> {
    check_remote_path(path)?;
    if path.ends_with('/') {
        return Err("path is a directory".into());
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err("content too large".into());
    }
    let cmd = format!("f={}; cat > \"$f\"", remote_path_arg(path));
    run_checked(host, &cmd, Some(content.as_bytes().to_vec()), 4096)?;
    Ok(())
}

// ───────────────────────── port forwarding ─────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct ForwardInfo {
    pub id: u32,
    pub host_id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

struct Forward {
    child: Child,
    info: ForwardInfo,
}

pub struct SshState {
    forwards: Mutex<HashMap<u32, Forward>>,
    next_id: AtomicU32,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            forwards: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl Drop for SshState {
    fn drop(&mut self) {
        if let Ok(mut m) = self.forwards.lock() {
            for (_, f) in m.iter_mut() {
                let _ = f.child.kill();
                let _ = f.child.wait();
            }
        }
    }
}

/// Spawns the `ssh -N -L` process and waits briefly to catch fast failures.
/// Blocking (sleeps ~1s); call from a blocking context.
pub fn spawn_forward(
    host: &SshHost,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
) -> Result<Child, String> {
    if local_port == 0 || remote_port == 0 {
        return Err("invalid port".into());
    }
    if !valid_target(remote_host) {
        return Err("invalid remote host".into());
    }
    let args = ssh_args(host, false);
    let sep = args
        .iter()
        .position(|a| a == "--")
        .ok_or("internal: missing -- separator")?;
    let mut cmd = Command::new("ssh");
    cmd.args(&args[..sep])
        .arg("-N")
        .args(["-o", "ExitOnForwardFailure=yes"])
        .arg("-L")
        .arg(format!("127.0.0.1:{local_port}:{remote_host}:{remote_port}"))
        .args(&args[sep..]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    crate::modules::proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "OpenSSH client (`ssh`) was not found on PATH".to_string()
        } else {
            e.to_string()
        }
    })?;
    thread::sleep(Duration::from_millis(1200));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!(
            "port forward failed to start (ssh exited with {:?}); the host must use key/agent auth with a trusted host key, and the local port must be free",
            status.code()
        ));
    }
    Ok(child)
}

impl SshState {
    pub fn register_forward(
        &self,
        child: Child,
        host_id: &str,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<ForwardInfo, String> {
        let info = ForwardInfo {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            host_id: host_id.to_string(),
            local_port,
            remote_host: remote_host.to_string(),
            remote_port,
        };
        self.forwards
            .lock()
            .map_err(|e| e.to_string())?
            .insert(info.id, Forward { child, info: info.clone() });
        Ok(info)
    }

    pub fn stop_forward(&self, id: u32) {
        if let Some(mut f) = self.forwards.lock().ok().and_then(|mut m| m.remove(&id)) {
            let _ = f.child.kill();
            let _ = f.child.wait();
        }
    }

    /// Lists live forwards; forwards whose ssh process died are dropped.
    pub fn list_forwards(&self) -> Vec<ForwardInfo> {
        let Ok(mut m) = self.forwards.lock() else {
            return Vec::new();
        };
        m.retain(|_, f| matches!(f.child.try_wait(), Ok(None)));
        let mut v: Vec<ForwardInfo> = m.values().map(|f| f.info.clone()).collect();
        v.sort_by_key(|i| i.id);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> SshHost {
        SshHost {
            id: "saved:x".into(),
            label: "x".into(),
            target: "example.com".into(),
            user: Some("deploy".into()),
            port: Some(2222),
            identity_file: Some("/home/me/.ssh/id key".into()),
            remote_dir: None,
            source: HostSource::Saved,
        }
    }

    #[test]
    fn target_rejects_option_injection_and_junk() {
        for bad in ["", "-oProxyCommand=x", "a b", "a;b", "a$(x)", "a/b", "-x"] {
            assert!(!valid_target(bad), "{bad}");
        }
        for ok in ["example.com", "10.0.0.1", "my-host_1", "::1"] {
            assert!(valid_target(ok), "{ok}");
        }
        assert!(!valid_user("-l"));
        assert!(!valid_user("a b"));
    }

    #[test]
    fn quoting() {
        assert_eq!(shq("it's"), "'it'\\''s'");
        assert_eq!(remote_path_arg("~"), "~");
        assert_eq!(remote_path_arg("~/my dir"), "~/'my dir'");
        assert_eq!(remote_path_arg("/var/www; rm -rf /"), "'/var/www; rm -rf /'");
    }

    #[test]
    fn args_are_hardened_and_target_is_last_after_separator() {
        let a = ssh_args(&host(), false);
        assert!(a.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(a.windows(2).any(|w| w == ["-o", "StrictHostKeyChecking=yes"]));
        assert_eq!(a[a.len() - 2], "--");
        assert_eq!(a[a.len() - 1], "example.com");
        let i = ssh_args(&host(), true);
        assert!(!i.iter().any(|x| x == "BatchMode=yes"));
    }

    #[test]
    fn terminal_command_quotes_and_never_embeds_secrets() {
        let c = terminal_command(&host());
        assert!(c.starts_with("ssh "));
        assert!(c.ends_with("-- example.com"));
        if !cfg!(windows) {
            assert!(c.contains("'/home/me/.ssh/id key'"));
        }
        let mut h = host();
        h.remote_dir = Some("/srv/app".into());
        let c = terminal_command(&h);
        assert!(c.starts_with("ssh -t "));
        assert!(c.contains("cd "));
    }

    #[test]
    fn ssh_config_parsing() {
        let cfg = "Host prod staging\n  HostName 1.2.3.4\nHost *\n  User x\nhost  dev # c\nHost !bad ok-1 -oX\n";
        assert_eq!(parse_ssh_config(cfg), vec!["prod", "staging", "dev", "ok-1"]);
    }

    #[test]
    fn find_listing_sorts_dirs_first() {
        let out = "f\t10\t1700000000.5\tb.txt\nd\t4096\t1700000001.0\tsrc\nl\t3\t1700000002.0\tlink\nbogus\n";
        let v = parse_find_listing(out);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].name, "src");
        assert_eq!(v[0].kind, "dir");
        assert_eq!(v[1].name, "b.txt");
        assert_eq!(v[2].kind, "symlink");
    }

    #[test]
    fn read_output_parsing() {
        assert_eq!(
            parse_read_output(b"5\nhello", 100).unwrap(),
            RemoteRead::Text { content: "hello".into(), size: 5 }
        );
        assert_eq!(
            parse_read_output(b"3\n\0ab", 100).unwrap(),
            RemoteRead::Binary { size: 3 }
        );
        assert_eq!(
            parse_read_output(b"500\n", 100).unwrap(),
            RemoteRead::Toolarge { size: 500, limit: 100 }
        );
        assert!(parse_read_output(b"garbage", 100).is_err());
    }

    #[test]
    fn error_classification() {
        let m = classify_ssh_error(Some(255), "Host key verification failed.").unwrap();
        assert!(m.contains("fingerprint"));
        assert!(classify_ssh_error(Some(255), "Permission denied (publickey).").is_some());
        assert!(classify_ssh_error(Some(1), "Permission denied").is_none());
        assert!(classify_ssh_error(Some(255), "weird").is_none());
    }

    #[test]
    fn host_store_roundtrip_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("ssh_hosts.json");
        let input = |label: &str, target: &str| SshHostInput {
            id: None,
            label: label.into(),
            target: target.into(),
            user: Some("me".into()),
            port: Some(22),
            identity_file: None,
            remote_dir: Some("/srv".into()),
        };
        assert!(save_host(&store, input("Bad", "-oProxyCommand=x")).is_err());
        let a = save_host(&store, input("Prod", "prod.example.com")).unwrap();
        let b = save_host(&store, input("Prod", "prod2.example.com")).unwrap();
        assert_eq!(a.id, "saved:prod");
        assert_eq!(b.id, "saved:prod-2");
        let mut edit = input("Prod renamed", "prod.example.com");
        edit.id = Some(a.id.clone());
        assert_eq!(save_host(&store, edit).unwrap().label, "Prod renamed");
        assert_eq!(list_hosts(&store, None).len(), 2);
        delete_host(&store, &a.id).unwrap();
        assert_eq!(list_hosts(&store, None).len(), 1);
        // Tampered file entries with bad targets are dropped on load.
        std::fs::write(
            &store,
            r#"[{"id":"saved:evil","label":"e","target":"-oProxyCommand=x","user":null,"port":null,"identity_file":null,"remote_dir":null,"source":"saved"}]"#,
        )
        .unwrap();
        assert!(list_hosts(&store, None).is_empty());
    }
}
