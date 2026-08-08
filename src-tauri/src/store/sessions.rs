//! Session persistence.
//!
//! Transcripts are stored as opaque JSON lines: the frontend owns the line
//! shape, and this layer only needs them to come back in order. That keeps the
//! transcript format free to evolve (Phase 5 adds rich content) without a
//! schema migration.

use serde::{Deserialize, Serialize};

use super::{now, Db};

/// Session metadata, without its transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    pub agent_id: String,
    pub account_id: Option<String>,
    pub model_id: Option<String>,
    pub cwd: Option<String>,
    /// The agent's own conversation id, so a restored session can resume.
    pub agent_uuid: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A session and its transcript, as exported/imported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionExport {
    /// Format marker, so a future change can be detected rather than guessed.
    pub kora_session: u32,
    pub meta: SessionMeta,
    /// Transcript lines, each an opaque JSON value owned by the frontend.
    pub lines: Vec<serde_json::Value>,
}

/// Current export format version.
pub const FORMAT: u32 = 1;

/// Creates or updates a session's metadata.
pub async fn upsert(db: &Db, meta: SessionMeta) -> Result<(), String> {
    db.with(move |c| {
        c.execute(
            "INSERT INTO sessions (id, name, agent_id, account_id, model_id, cwd, agent_uuid, pinned, archived, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, agent_id=excluded.agent_id, account_id=excluded.account_id,
                model_id=excluded.model_id, cwd=excluded.cwd, agent_uuid=excluded.agent_uuid,
                pinned=excluded.pinned, archived=excluded.archived, updated_at=excluded.updated_at",
            rusqlite::params![
                meta.id, meta.name, meta.agent_id, meta.account_id, meta.model_id, meta.cwd,
                meta.agent_uuid, meta.pinned as i64, meta.archived as i64,
                meta.created_at, meta.updated_at,
            ],
        )?;
        Ok(())
    })
    .await
}

/// Replaces a session's transcript wholesale.
///
/// Simpler and safer than incremental appends: the frontend already holds the
/// authoritative line list, and a rewrite cannot drift out of order.
pub async fn save_lines(db: &Db, session_id: &str, lines: &[serde_json::Value]) -> Result<(), String> {
    let session_id = session_id.to_string();
    let payloads: Vec<String> = lines.iter().map(|l| l.to_string()).collect();

    db.with(move |c| {
        c.execute("DELETE FROM lines WHERE session_id = ?1", [&session_id])?;
        {
            let mut stmt =
                c.prepare("INSERT INTO lines (session_id, seq, payload) VALUES (?1, ?2, ?3)")?;
            for (i, payload) in payloads.iter().enumerate() {
                stmt.execute(rusqlite::params![session_id, i as i64, payload])?;
            }
        }
        c.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            rusqlite::params![session_id, now()],
        )?;
        Ok(())
    })
    .await
}

/// Every session, newest activity first, pinned ahead of the rest.
pub async fn list(db: &Db, include_archived: bool) -> Result<Vec<SessionMeta>, String> {
    db.with(move |c| {
        let sql = if include_archived {
            "SELECT id,name,agent_id,account_id,model_id,cwd,agent_uuid,pinned,archived,created_at,updated_at
             FROM sessions ORDER BY pinned DESC, updated_at DESC"
        } else {
            "SELECT id,name,agent_id,account_id,model_id,cwd,agent_uuid,pinned,archived,created_at,updated_at
             FROM sessions WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC"
        };
        let mut stmt = c.prepare(sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SessionMeta {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    agent_id: r.get(2)?,
                    account_id: r.get(3)?,
                    model_id: r.get(4)?,
                    cwd: r.get(5)?,
                    agent_uuid: r.get(6)?,
                    pinned: r.get::<_, i64>(7)? != 0,
                    archived: r.get::<_, i64>(8)? != 0,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .await
}

/// A session's transcript, in order.
pub async fn lines(db: &Db, session_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let session_id = session_id.to_string();
    db.with(move |c| {
        let mut stmt =
            c.prepare("SELECT payload FROM lines WHERE session_id = ?1 ORDER BY seq")?;
        let rows = stmt
            .query_map([&session_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter_map(|p| serde_json::from_str(&p).ok())
            .collect())
    })
    .await
}

pub async fn delete(db: &Db, session_id: &str) -> Result<(), String> {
    let session_id = session_id.to_string();
    db.with(move |c| {
        c.execute("DELETE FROM lines WHERE session_id = ?1", [&session_id])?;
        c.execute("DELETE FROM sessions WHERE id = ?1", [&session_id])?;
        Ok(())
    })
    .await
}

pub async fn set_flags(
    db: &Db,
    session_id: &str,
    pinned: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    let session_id = session_id.to_string();
    db.with(move |c| {
        if let Some(p) = pinned {
            c.execute(
                "UPDATE sessions SET pinned = ?2, updated_at = ?3 WHERE id = ?1",
                rusqlite::params![session_id, p as i64, now()],
            )?;
        }
        if let Some(a) = archived {
            c.execute(
                "UPDATE sessions SET archived = ?2, updated_at = ?3 WHERE id = ?1",
                rusqlite::params![session_id, a as i64, now()],
            )?;
        }
        Ok(())
    })
    .await
}

pub async fn rename(db: &Db, session_id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("session name is empty".into());
    }
    let (session_id, name) = (session_id.to_string(), name.to_string());
    db.with(move |c| {
        c.execute(
            "UPDATE sessions SET name = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![session_id, name, now()],
        )?;
        Ok(())
    })
    .await
}

/// Everything needed to recreate a session elsewhere.
pub async fn export(db: &Db, session_id: &str) -> Result<SessionExport, String> {
    let meta = list(db, true)
        .await?
        .into_iter()
        .find(|m| m.id == session_id)
        .ok_or_else(|| "no such session".to_string())?;
    Ok(SessionExport {
        kora_session: FORMAT,
        meta,
        lines: lines(db, session_id).await?,
    })
}

/// Imports an exported session under a fresh id, so it never collides with a
/// session already present.
pub async fn import(db: &Db, mut export: SessionExport) -> Result<SessionMeta, String> {
    if export.kora_session != FORMAT {
        return Err(format!(
            "unsupported session format {} (this build reads {FORMAT})",
            export.kora_session
        ));
    }
    export.meta.id = uuid::Uuid::new_v4().to_string();
    export.meta.updated_at = now();
    // The agent's conversation id belongs to the machine that made it.
    export.meta.agent_uuid = None;

    upsert(db, export.meta.clone()).await?;
    save_lines(db, &export.meta.id, &export.lines).await?;
    Ok(export.meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(id: &str, name: &str) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            name: name.into(),
            agent_id: "claude".into(),
            account_id: Some("a1".into()),
            model_id: Some("sonnet".into()),
            cwd: Some("/work".into()),
            agent_uuid: Some("uuid-1".into()),
            pinned: false,
            archived: false,
            created_at: now(),
            updated_at: now(),
        }
    }

    #[tokio::test]
    async fn a_session_and_its_transcript_round_trip() {
        let db = Db::in_memory().unwrap();
        upsert(&db, meta("s1", "auth work")).await.unwrap();
        let transcript = vec![
            json!({"key":"l1","t":"banner"}),
            json!({"key":"l2","t":"cmd","text":"why is CI flaky?"}),
        ];
        save_lines(&db, "s1", &transcript).await.unwrap();

        assert_eq!(lines(&db, "s1").await.unwrap(), transcript);
        let all = list(&db, false).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "auth work");
        assert_eq!(all[0].agent_uuid.as_deref(), Some("uuid-1"));
    }

    #[tokio::test]
    async fn saving_lines_replaces_rather_than_appends() {
        let db = Db::in_memory().unwrap();
        upsert(&db, meta("s1", "s")).await.unwrap();
        save_lines(&db, "s1", &[json!({"a":1}), json!({"a":2})]).await.unwrap();
        save_lines(&db, "s1", &[json!({"a":3})]).await.unwrap();
        assert_eq!(lines(&db, "s1").await.unwrap(), vec![json!({"a":3})]);
    }

    #[tokio::test]
    async fn sessions_survive_reopening_the_database() {
        let dir = std::env::temp_dir().join(format!("kora-sess-{}", uuid::Uuid::new_v4()));
        {
            let db = Db::open(&dir).unwrap();
            upsert(&db, meta("s1", "kept")).await.unwrap();
            save_lines(&db, "s1", &[json!({"t":"banner"})]).await.unwrap();
        }
        let db = Db::open(&dir).unwrap();
        assert_eq!(list(&db, false).await.unwrap()[0].name, "kept");
        assert_eq!(lines(&db, "s1").await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pinned_sessions_sort_first_and_archived_ones_hide() {
        let db = Db::in_memory().unwrap();
        upsert(&db, meta("s1", "one")).await.unwrap();
        upsert(&db, meta("s2", "two")).await.unwrap();
        upsert(&db, meta("s3", "three")).await.unwrap();

        set_flags(&db, "s2", Some(true), None).await.unwrap();
        set_flags(&db, "s3", None, Some(true)).await.unwrap();

        let visible = list(&db, false).await.unwrap();
        assert_eq!(visible[0].id, "s2", "pinned first");
        assert_eq!(visible.len(), 2, "archived hidden");
        assert_eq!(list(&db, true).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn renaming_and_deleting_behave() {
        let db = Db::in_memory().unwrap();
        upsert(&db, meta("s1", "before")).await.unwrap();
        save_lines(&db, "s1", &[json!({"t":"banner"})]).await.unwrap();

        rename(&db, "s1", "after").await.unwrap();
        assert_eq!(list(&db, false).await.unwrap()[0].name, "after");
        assert!(rename(&db, "s1", "  ").await.is_err());

        delete(&db, "s1").await.unwrap();
        assert!(list(&db, true).await.unwrap().is_empty());
        assert!(lines(&db, "s1").await.unwrap().is_empty(), "transcript goes too");
    }

    #[tokio::test]
    async fn an_export_imports_into_a_fresh_database_under_a_new_id() {
        let source = Db::in_memory().unwrap();
        upsert(&source, meta("s1", "portable")).await.unwrap();
        save_lines(&source, "s1", &[json!({"t":"cmd","text":"hello"})])
            .await
            .unwrap();

        let exported = export(&source, "s1").await.unwrap();
        let wire = serde_json::to_string(&exported).unwrap();

        // A different install entirely.
        let target = Db::in_memory().unwrap();
        let parsed: SessionExport = serde_json::from_str(&wire).unwrap();
        let imported = import(&target, parsed).await.unwrap();

        assert_ne!(imported.id, "s1", "a fresh id avoids collisions");
        assert_eq!(imported.name, "portable");
        assert_eq!(
            imported.agent_uuid, None,
            "the agent's conversation id does not travel between machines"
        );
        assert_eq!(
            lines(&target, &imported.id).await.unwrap(),
            vec![json!({"t":"cmd","text":"hello"})]
        );
    }

    #[tokio::test]
    async fn importing_an_id_that_already_exists_does_not_clobber_it() {
        let db = Db::in_memory().unwrap();
        upsert(&db, meta("s1", "original")).await.unwrap();
        save_lines(&db, "s1", &[json!({"t":"a"})]).await.unwrap();

        let exported = export(&db, "s1").await.unwrap();
        import(&db, exported).await.unwrap();

        let all = list(&db, true).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(lines(&db, "s1").await.unwrap(), vec![json!({"t":"a"})]);
    }

    #[tokio::test]
    async fn an_unknown_export_format_is_refused_rather_than_guessed() {
        let db = Db::in_memory().unwrap();
        let bad = SessionExport {
            kora_session: 999,
            meta: meta("s1", "future"),
            lines: vec![],
        };
        let err = import(&db, bad).await.unwrap_err();
        assert!(err.contains("unsupported session format 999"));
    }

    #[tokio::test]
    async fn exporting_an_unknown_session_is_an_error() {
        let db = Db::in_memory().unwrap();
        assert!(export(&db, "nope").await.is_err());
    }
}
