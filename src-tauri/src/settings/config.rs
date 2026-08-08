//! The persisted settings model.
//!
//! Every field has a default, and an unknown or corrupt file falls back to
//! those rather than refusing to start: settings are preferences, and losing
//! them must never cost the user their sessions.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Notification kinds the user can silence individually.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// Context crossing the urgent threshold.
    pub context: bool,
    /// The agent reporting its quota nearly used.
    pub usage: bool,
    /// An account that is no longer signed in.
    pub auth: bool,
    /// A turn that failed.
    pub errors: bool,
    /// A newer Kora being available.
    pub updates: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            context: true,
            usage: true,
            auth: true,
            errors: true,
            updates: true,
        }
    }
}

/// Everything the Settings panel writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Theme id. One ships today; the field exists so a second needs no
    /// migration.
    pub theme: String,
    /// Transcript font size in px.
    pub font_size: f32,
    /// Monospace family. Empty means Kora's bundled JetBrains Mono.
    pub font_family: String,
    /// `comfortable` or `compact`.
    pub density: String,
    /// The accent glow behind the focused agent's colour.
    pub glow: bool,
    /// Whether the status bar is shown at all.
    pub status_bar: bool,
    /// Agent a new session starts under.
    pub default_agent: String,
    /// Model a new session starts under, when the agent offers it.
    pub default_model: Option<String>,
    /// Ask the agent to compact itself when context crosses the urgent
    /// threshold, instead of only suggesting it (Phase 4).
    pub auto_compact: bool,
    pub notifications: NotificationSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "kora-dark".into(),
            font_size: 13.0,
            font_family: String::new(),
            density: "comfortable".into(),
            glow: true,
            status_bar: true,
            default_agent: "claude".into(),
            default_model: None,
            auto_compact: false,
            notifications: NotificationSettings::default(),
        }
    }
}

impl Settings {
    /// Clamps anything that would break the UI if taken literally.
    ///
    /// The webview can send whatever it likes, so a 4000px font or an unknown
    /// density is corrected here rather than rendered.
    pub fn sanitized(mut self) -> Self {
        self.font_size = self.font_size.clamp(9.0, 24.0);
        if self.density != "compact" {
            self.density = "comfortable".into();
        }
        if self.theme.trim().is_empty() {
            self.theme = "kora-dark".into();
        }
        // A font family reaches CSS, so keep it to something name-shaped.
        if self.font_family.len() > 64
            || self
                .font_family
                .contains(|c: char| !(c.is_alphanumeric() || " -_,'\"".contains(c)))
        {
            self.font_family = String::new();
        }
        if self.default_agent.trim().is_empty() {
            self.default_agent = "claude".into();
        }
        self
    }
}

/// Reads and writes the settings file.
#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    current: Arc<Mutex<Settings>>,
}

impl SettingsStore {
    /// `root` is Kora's data directory.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let path = root.join("settings.json");
        let current = Self::load(&path).unwrap_or_default();
        Self {
            path,
            current: Arc::new(Mutex::new(current)),
        }
    }

    fn load(path: &Path) -> Option<Settings> {
        let raw = std::fs::read_to_string(path).ok()?;
        // `#[serde(default)]` means a file written by an older build, or one
        // missing fields, still loads — with defaults for what it lacks.
        serde_json::from_str::<Settings>(&raw)
            .ok()
            .map(Settings::sanitized)
    }

    pub async fn get(&self) -> Settings {
        self.current.lock().await.clone()
    }

    /// Replaces the settings and writes them out.
    pub async fn set(&self, settings: Settings) -> Result<Settings, String> {
        let settings = settings.sanitized();
        {
            let mut current = self.current.lock().await;
            *current = settings.clone();
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("kora-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn defaults_apply_when_there_is_no_file_yet() {
        let root = tmp_root();
        let store = SettingsStore::new(&root);
        let s = store.get().await;

        assert_eq!(s.theme, "kora-dark");
        assert_eq!(s.default_agent, "claude");
        assert!(!s.auto_compact, "auto-compact is opt-in");
        assert!(s.notifications.context);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn settings_survive_a_restart() {
        let root = tmp_root();
        {
            let store = SettingsStore::new(&root);
            let mut s = store.get().await;
            s.density = "compact".into();
            s.font_size = 15.0;
            s.auto_compact = true;
            store.set(s).await.unwrap();
        }
        let reopened = SettingsStore::new(&root).get().await;
        assert_eq!(reopened.density, "compact");
        assert_eq!(reopened.font_size, 15.0);
        assert!(reopened.auto_compact);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_file_from_an_older_build_still_loads() {
        let root = tmp_root();
        std::fs::write(root.join("settings.json"), br#"{"theme":"kora-dark"}"#).unwrap();

        let s = SettingsStore::new(&root).get().await;
        assert_eq!(s.theme, "kora-dark");
        // Everything the file did not mention comes from the defaults.
        assert_eq!(s.font_size, 13.0);
        assert!(s.status_bar);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_corrupt_file_does_not_stop_kora_from_starting() {
        let root = tmp_root();
        std::fs::write(root.join("settings.json"), b"{ not json").unwrap();

        let store = SettingsStore::new(&root);
        assert_eq!(store.get().await, Settings::default());
        // And it recovers: the next write replaces the broken file.
        let mut s = store.get().await;
        s.glow = false;
        store.set(s).await.unwrap();
        assert!(!SettingsStore::new(&root).get().await.glow);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn values_that_would_break_the_ui_are_clamped_not_rendered() {
        let root = tmp_root();
        let store = SettingsStore::new(&root);
        let mut s = store.get().await;
        s.font_size = 4000.0;
        s.density = "enormous".into();
        s.theme = "  ".into();
        s.default_agent = String::new();

        let saved = store.set(s).await.unwrap();
        assert_eq!(saved.font_size, 24.0);
        assert_eq!(saved.density, "comfortable");
        assert_eq!(saved.theme, "kora-dark");
        assert_eq!(saved.default_agent, "claude");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_font_family_carrying_css_is_refused() {
        let root = tmp_root();
        let store = SettingsStore::new(&root);
        let mut s = store.get().await;
        // This value reaches a CSS custom property.
        s.font_family = "Menlo; } body { display: none } .x {".into();

        let saved = store.set(s).await.unwrap();
        assert_eq!(saved.font_family, "", "anything not name-shaped is dropped");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_settings_file_is_not_a_second_place_for_secrets() {
        let root = tmp_root();
        let store = SettingsStore::new(&root);
        store.set(store.get().await).await.unwrap();

        let raw = std::fs::read_to_string(root.join("settings.json")).unwrap();
        // The struct is the whole persisted shape. If a token-shaped field ever
        // appears, this is the test that has to change first.
        for secret_shaped in ["token", "secret", "password", "apikey", "credential", "sk-"] {
            assert!(
                !raw.to_lowercase().contains(secret_shaped),
                "settings must never hold {secret_shaped}: {raw}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
