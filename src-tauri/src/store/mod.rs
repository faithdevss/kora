//! Local persistence: session transcripts and usage history.
//!
//! One SQLite file under Kora's data directory. It holds conversation content
//! and token counts — never credentials, which stay with the agent (see
//! `accounts`). Phase 5's conversation search reads the same tables.

pub mod pricing;
pub mod sessions;
pub mod usage;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::Connection;
use tokio::sync::Mutex;

/// Shared handle to the local database.
///
/// A single connection behind a mutex: writes are small and infrequent (a line
/// append, a usage row per turn), and this keeps schema migration trivially
/// serialised.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    /// Opens (creating if needed) the database under `root`.
    pub fn open(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        Self::open_at(&root.join("kora.sqlite3"))
    }

    /// Opens a specific file. `:memory:` works, which is what tests use.
    pub fn open_at(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate_blocking()?;
        Ok(db)
    }

    pub fn in_memory() -> Result<Self, String> {
        Self::open_at(Path::new(":memory:"))
    }

    fn migrate_blocking(&self) -> Result<(), String> {
        let conn = self.conn.try_lock().map_err(|e| e.to_string())?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                agent_id    TEXT NOT NULL,
                account_id  TEXT,
                model_id    TEXT,
                cwd         TEXT,
                agent_uuid  TEXT,
                pinned      INTEGER NOT NULL DEFAULT 0,
                archived    INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS lines (
                session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                seq         INTEGER NOT NULL,
                payload     TEXT NOT NULL,
                PRIMARY KEY (session_id, seq)
            );

            -- One row per turn, so any window can be summed after the fact.
            CREATE TABLE IF NOT EXISTS usage (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                at            INTEGER NOT NULL,
                agent_id      TEXT NOT NULL,
                account_id    TEXT,
                model         TEXT,
                input_tokens  INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read    INTEGER NOT NULL DEFAULT 0,
                cache_write   INTEGER NOT NULL DEFAULT 0,
                cost_usd      REAL
            );

            CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
            CREATE INDEX IF NOT EXISTS usage_account ON usage(account_id, at);
            "#,
        )
        .map_err(|e| e.to_string())
    }

    /// Runs a closure with the connection.
    pub async fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, String> {
        let conn = self.conn.lock().await;
        f(&conn).map_err(|e| e.to_string())
    }
}

/// Kora's data directory, created on demand.
pub fn data_dir() -> PathBuf {
    let base = std::env::var("KORA_DATA_DIR").ok().map(PathBuf::from);
    base.unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("dev.faithdevs.kora")
    })
}

/// Seconds since the epoch.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_fresh_database_has_its_schema() {
        let db = Db::in_memory().unwrap();
        let tables: Vec<String> = db
            .with(|c| {
                let mut stmt =
                    c.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .unwrap();
        for expected in ["lines", "sessions", "usage"] {
            assert!(tables.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[tokio::test]
    async fn opening_twice_is_safe() {
        let dir = std::env::temp_dir().join(format!("kora-db-{}", uuid::Uuid::new_v4()));
        Db::open(&dir).unwrap();
        Db::open(&dir).unwrap(); // migrations are idempotent
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_data_dir_is_overridable_for_tests_and_sandboxes() {
        std::env::set_var("KORA_DATA_DIR", "/tmp/kora-test-dir");
        assert_eq!(data_dir(), PathBuf::from("/tmp/kora-test-dir"));
        std::env::remove_var("KORA_DATA_DIR");
        assert!(data_dir().ends_with("dev.faithdevs.kora"));
    }
}
