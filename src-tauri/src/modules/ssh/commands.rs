//! Tauri command wrappers. Blocking ssh work runs on the blocking pool.

use std::path::PathBuf;

use tauri::Manager;

use super::{
    CommandOutput, ForwardInfo, RemoteEntry, RemoteRead, SshHost, SshHostInput, SshState,
};

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("ssh_hosts.json"))
}

fn ssh_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

fn host_for(app: &tauri::AppHandle, id: &str) -> Result<SshHost, String> {
    super::find_host(&store_path(app)?, ssh_config_path().as_deref(), id)
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn ssh_list_hosts(app: tauri::AppHandle) -> Result<Vec<SshHost>, String> {
    Ok(super::list_hosts(&store_path(&app)?, ssh_config_path().as_deref()))
}

#[tauri::command]
pub fn ssh_save_host(app: tauri::AppHandle, host: SshHostInput) -> Result<SshHost, String> {
    super::save_host(&store_path(&app)?, host)
}

#[tauri::command]
pub fn ssh_delete_host(app: tauri::AppHandle, id: String) -> Result<(), String> {
    super::delete_host(&store_path(&app)?, &id)
}

/// Line to type into a local terminal tab to open an interactive session.
#[tauri::command]
pub fn ssh_terminal_command(app: tauri::AppHandle, id: String) -> Result<String, String> {
    Ok(super::terminal_command(&host_for(&app, &id)?))
}

#[tauri::command]
pub async fn ssh_exec(
    app: tauri::AppHandle,
    id: String,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    let host = host_for(&app, &id)?;
    blocking(move || super::exec(&host, &command, cwd.as_deref(), timeout_secs)).await
}

#[tauri::command]
pub async fn ssh_list_dir(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<Vec<RemoteEntry>, String> {
    let host = host_for(&app, &id)?;
    blocking(move || super::list_dir(&host, &path)).await
}

#[tauri::command]
pub async fn ssh_read_file(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<RemoteRead, String> {
    let host = host_for(&app, &id)?;
    blocking(move || super::read_file(&host, &path)).await
}

#[tauri::command]
pub async fn ssh_write_file(
    app: tauri::AppHandle,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let host = host_for(&app, &id)?;
    blocking(move || super::write_file(&host, &path, &content)).await
}

#[tauri::command]
pub async fn ssh_forward_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    id: String,
    local_port: u16,
    remote_host: Option<String>,
    remote_port: u16,
) -> Result<ForwardInfo, String> {
    let host = host_for(&app, &id)?;
    let remote_host = remote_host.unwrap_or_else(|| "localhost".into());
    let h = host.clone();
    let rh = remote_host.clone();
    let child =
        blocking(move || super::spawn_forward(&h, local_port, &rh, remote_port)).await?;
    state.register_forward(child, &host.id, local_port, &remote_host, remote_port)
}

#[tauri::command]
pub fn ssh_forward_stop(state: tauri::State<'_, SshState>, id: u32) {
    state.stop_forward(id);
}

#[tauri::command]
pub fn ssh_forward_list(state: tauri::State<'_, SshState>) -> Vec<ForwardInfo> {
    state.list_forwards()
}
