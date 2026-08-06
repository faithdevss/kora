//! Kora backend.
//!
//! Owns agent processes and nothing else: no network, no credential storage
//! (Phase 3), no filesystem access beyond checking that a workspace exists and
//! whether it carries the agent's own config files.

pub mod adapters;
pub mod commands;
pub mod proc;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent};

use proc::manager::{SessionEvent, SessionManager, EVENT_NAME};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Every agent event reaches the frontend through this one channel.
            let handle = app.handle().clone();
            let manager = Arc::new(SessionManager::new(Arc::new(move |event: SessionEvent| {
                let _ = handle.emit(EVENT_NAME, event);
            })));
            app.manage(manager);
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building kora")
        .run(|app, event| {
            // Quitting must not leave agent processes behind.
            if let RunEvent::Exit = event {
                if let Some(manager) = app.try_state::<Arc<SessionManager>>() {
                    let manager = manager.inner().clone();
                    tauri::async_runtime::block_on(manager.kill_all());
                }
            }
        });
}
