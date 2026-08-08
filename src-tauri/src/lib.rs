//! Kora backend.
//!
//! Owns agent processes and nothing else: no network, no credential storage
//! (Phase 3), no filesystem access beyond checking that a workspace exists and
//! whether it carries the agent's own config files.

pub mod accounts;
pub mod adapters;
pub mod commands;
pub mod files;
pub mod integrations;
pub mod proc;
pub mod settings;
pub mod store;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent};

use accounts::store::AccountStore;
use settings::config::SettingsStore;
use proc::manager::{SessionEvent, SessionManager, EVENT_NAME};
use store::Db;

/// Prints how long the window took to appear, when `KORA_TIMING=1`.
///
/// Startup is measured, not asserted: the docs' aspirational "<100ms" belongs
/// to a pure-TUI stack, and the honest thing is to publish what this one does.
fn report_timing(label: &str, since: std::time::Instant) {
    if std::env::var("KORA_TIMING").is_ok_and(|v| v == "1") {
        eprintln!("kora-timing {label}: {}ms", since.elapsed().as_millis());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(started: std::time::Instant) {
    tauri::Builder::default()
        .setup(move |app| {
            // Every agent event reaches the frontend through this one channel.
            let handle = app.handle().clone();
            let manager = Arc::new(SessionManager::new(Arc::new(move |event: SessionEvent| {
                let _ = handle.emit(EVENT_NAME, event);
            })));
            app.manage(manager);

            // Local persistence and the account list. A failure here is not
            // fatal: Kora still runs, it just cannot remember anything.
            let root = store::data_dir();
            match Db::open(&root) {
                Ok(db) => {
                    app.manage(db);
                }
                Err(e) => {
                    eprintln!("kora: local store unavailable ({e}); history will not persist");
                }
            }
            app.manage(Arc::new(AccountStore::new(&root)));
            app.manage(Arc::new(SettingsStore::new(&root)));
            report_timing("setup", started);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent_spawn,
            commands::agent_respawn,
            commands::agent_write,
            commands::agent_permission,
            commands::agent_interrupt,
            commands::agent_kill,
            commands::agent_is_connected,
            commands::workspace_dir,
            commands::accounts_list,
            commands::accounts_active,
            commands::accounts_add,
            commands::accounts_rename,
            commands::accounts_remove,
            commands::accounts_switch,
            commands::accounts_refresh,
            commands::accounts_login_command,
            commands::sessions_list,
            commands::sessions_save,
            commands::sessions_lines,
            commands::sessions_delete,
            commands::sessions_rename,
            commands::sessions_set_flags,
            commands::sessions_export,
            commands::sessions_export_file,
            commands::sessions_import,
            commands::sessions_import_file,
            commands::usage_week,
            commands::usage_record,
            commands::sessions_search,
            commands::file_ingest,
            commands::file_ingest_bytes,
            commands::file_open_in_editor,
            commands::file_save,
            commands::agent_capabilities,
            commands::settings_get,
            commands::settings_set,
            commands::version_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building kora")
        .run(move |app, event| {
            if let RunEvent::Ready = event {
                report_timing("window-ready", started);
            }
            // Quitting must not leave agent processes behind.
            if let RunEvent::Exit = event {
                if let Some(manager) = app.try_state::<Arc<SessionManager>>() {
                    let manager = manager.inner().clone();
                    tauri::async_runtime::block_on(manager.kill_all());
                }
            }
        });
}
