//! Kora backend.
//!
//! Phase 1 is UI-only: this boots the webview and registers nothing else.
//! No commands, no process spawning, no network, no keychain access —
//! those arrive in Phase 2 (`adapters/`, `pty/`) and Phase 3 (accounts).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running kora");
}
