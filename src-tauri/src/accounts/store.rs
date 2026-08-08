//! Persisted account list.
//!
//! A plain JSON file next to Kora's data, holding only non-secret identity.
//! Profile directories live beside it, one per account, and are created with
//! owner-only permissions since the agent writes its credentials inside them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::Account;
use crate::adapters::{adapter_for, AccountIdentity};

#[derive(Debug, Default, Serialize, Deserialize)]
struct Persisted {
    accounts: Vec<Account>,
    /// Active account id per agent id.
    #[serde(default)]
    active: HashMap<String, String>,
}

/// Reads and writes the account list.
#[derive(Clone)]
pub struct AccountStore {
    root: PathBuf,
    state: Arc<Mutex<Persisted>>,
}

impl AccountStore {
    /// `root` is Kora's data directory; accounts live in `root/accounts`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let state = Self::load(&root).unwrap_or_default();
        Self {
            root,
            state: Arc::new(Mutex::new(state)),
        }
    }

    fn index_path(root: &Path) -> PathBuf {
        root.join("accounts.json")
    }

    fn profiles_dir(root: &Path) -> PathBuf {
        root.join("accounts")
    }

    fn load(root: &Path) -> Option<Persisted> {
        let raw = std::fs::read_to_string(Self::index_path(root)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    async fn save(&self) -> Result<(), String> {
        let state = self.state.lock().await;
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*state).map_err(|e| e.to_string())?;
        std::fs::write(Self::index_path(&self.root), json).map_err(|e| e.to_string())
    }

    pub async fn list(&self, agent_id: &str) -> Vec<Account> {
        self.state
            .lock()
            .await
            .accounts
            .iter()
            .filter(|a| a.agent_id == agent_id)
            .cloned()
            .collect()
    }

    pub async fn get(&self, id: &str) -> Option<Account> {
        self.state
            .lock()
            .await
            .accounts
            .iter()
            .find(|a| a.id == id)
            .cloned()
    }

    /// The account a new session for `agent_id` should use.
    pub async fn active(&self, agent_id: &str) -> Option<Account> {
        let state = self.state.lock().await;
        let id = state.active.get(agent_id);
        match id {
            Some(id) => state.accounts.iter().find(|a| &a.id == id).cloned(),
            // No explicit choice yet: the first account for this agent.
            None => state.accounts.iter().find(|a| a.agent_id == agent_id).cloned(),
        }
    }

    pub async fn set_active(&self, agent_id: &str, account_id: &str) -> Result<(), String> {
        {
            let mut state = self.state.lock().await;
            if !state
                .accounts
                .iter()
                .any(|a| a.id == account_id && a.agent_id == agent_id)
            {
                return Err("no such account for this agent".into());
            }
            state
                .active
                .insert(agent_id.to_string(), account_id.to_string());
        }
        self.save().await
    }

    /// Creates an account and its profile directory. Does not sign it in.
    pub async fn add(&self, agent_id: &str, name: &str) -> Result<Account, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("account name is empty".into());
        }
        {
            let state = self.state.lock().await;
            if state
                .accounts
                .iter()
                .any(|a| a.agent_id == agent_id && a.name.eq_ignore_ascii_case(name))
            {
                return Err(format!("an account named {name} already exists"));
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let dir = Self::profiles_dir(&self.root).join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        // The agent writes its credentials in here, so keep it owner-only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }

        let account = Account {
            id,
            agent_id: agent_id.to_string(),
            name: name.to_string(),
            dir: dir.to_string_lossy().to_string(),
            identity: None,
        };
        {
            let mut state = self.state.lock().await;
            state.accounts.push(account.clone());
            state
                .active
                .entry(agent_id.to_string())
                .or_insert_with(|| account.id.clone());
        }
        self.save().await?;
        Ok(account)
    }

    pub async fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("account name is empty".into());
        }
        {
            let mut state = self.state.lock().await;
            let Some(account) = state.accounts.iter_mut().find(|a| a.id == id) else {
                return Err("no such account".into());
            };
            account.name = name.to_string();
        }
        self.save().await
    }

    /// Forgets an account and deletes its profile directory, credentials included.
    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let removed = {
            let mut state = self.state.lock().await;
            let Some(pos) = state.accounts.iter().position(|a| a.id == id) else {
                return Err("no such account".into());
            };
            let removed = state.accounts.remove(pos);
            state.active.retain(|_, v| v != id);
            removed
        };

        // Only ever inside our own profiles directory.
        let dir = PathBuf::from(&removed.dir);
        if dir.starts_with(Self::profiles_dir(&self.root)) {
            let _ = std::fs::remove_dir_all(&dir);
        }
        self.save().await
    }

    /// Asks the agent who is signed in to this account, and records the answer.
    ///
    /// Runs the agent's own `auth status`, so the credential stays with the
    /// agent — Kora only reads back non-secret identity.
    pub async fn refresh_identity(&self, id: &str) -> Result<Option<AccountIdentity>, String> {
        let Some(account) = self.get(id).await else {
            return Err("no such account".into());
        };
        let Some(adapter) = adapter_for(&account.agent_id) else {
            return Err("agent has no adapter".into());
        };
        let Some(argv) = adapter.auth_status_argv() else {
            return Ok(None);
        };

        let output = tokio::process::Command::new(adapter.program())
            .args(&argv)
            .envs(adapter.account_env(&account.dir))
            .output()
            .await
            .map_err(|e| format!("could not ask {} who is signed in: {e}", adapter.name()))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let identity = adapter.parse_auth_status(&stdout);

        {
            let mut state = self.state.lock().await;
            if let Some(a) = state.accounts.iter_mut().find(|a| a.id == id) {
                a.identity = identity.clone();
            }
        }
        self.save().await?;
        Ok(identity)
    }

    /// argv + env for an interactive login into this account's directory.
    pub async fn login_command(&self, id: &str) -> Result<(String, Vec<String>, Vec<(String, String)>), String> {
        let Some(account) = self.get(id).await else {
            return Err("no such account".into());
        };
        let Some(adapter) = adapter_for(&account.agent_id) else {
            return Err("agent has no adapter".into());
        };
        let argv = adapter
            .login_argv()
            .ok_or_else(|| format!("{} has no login command", adapter.name()))?;
        Ok((adapter.program(), argv, adapter.account_env(&account.dir)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("kora-accts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn adding_an_account_creates_an_owner_only_profile_dir() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        let a = store.add("claude", "personal").await.unwrap();

        assert!(Path::new(&a.dir).is_dir());
        assert!(a.identity.is_none(), "a new account is not signed in yet");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&a.dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "the agent stores credentials in here");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn accounts_survive_a_restart() {
        let root = tmp_root();
        {
            let store = AccountStore::new(&root);
            store.add("claude", "personal").await.unwrap();
            store.add("claude", "work").await.unwrap();
        }
        let reopened = AccountStore::new(&root);
        let names: Vec<String> = reopened
            .list("claude")
            .await
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, vec!["personal", "work"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_persisted_file_contains_nothing_secret() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        let a = store.add("claude", "personal").await.unwrap();
        {
            let mut state = store.state.lock().await;
            state.accounts[0].identity = Some(AccountIdentity {
                logged_in: true,
                auth_method: "claude.ai".into(),
                email: Some("me@example.com".into()),
                org_name: Some("Org".into()),
                subscription: Some("pro".into()),
            });
        }
        store.save().await.unwrap();

        let raw = std::fs::read_to_string(AccountStore::index_path(&root)).unwrap();
        assert!(raw.contains(&a.dir), "the profile path is what we persist");
        for secret_shaped in ["sk-", "token", "secret", "password", "apiKey", "credential"] {
            assert!(
                !raw.contains(secret_shaped),
                "account store must never hold {secret_shaped}: {raw}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_first_account_becomes_active_and_switching_sticks() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        let personal = store.add("claude", "personal").await.unwrap();
        let work = store.add("claude", "work").await.unwrap();

        assert_eq!(store.active("claude").await.unwrap().id, personal.id);
        store.set_active("claude", &work.id).await.unwrap();
        assert_eq!(store.active("claude").await.unwrap().id, work.id);

        let reopened = AccountStore::new(&root);
        assert_eq!(reopened.active("claude").await.unwrap().id, work.id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn accounts_are_scoped_to_their_agent() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        store.add("claude", "personal").await.unwrap();
        let other = store.add("codex", "personal").await.unwrap();

        assert_eq!(store.list("claude").await.len(), 1);
        assert!(store.set_active("claude", &other.id).await.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn duplicate_and_empty_names_are_refused() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        store.add("claude", "personal").await.unwrap();
        assert!(store.add("claude", "personal").await.is_err());
        assert!(store.add("claude", "PERSONAL").await.is_err());
        assert!(store.add("claude", "   ").await.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn removing_an_account_deletes_its_credentials_with_it() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        let a = store.add("claude", "personal").await.unwrap();
        std::fs::write(Path::new(&a.dir).join(".claude.json"), b"{}").unwrap();

        store.remove(&a.id).await.unwrap();
        assert!(!Path::new(&a.dir).exists(), "the profile dir goes too");
        assert!(store.list("claude").await.is_empty());
        assert!(store.active("claude").await.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn removing_never_deletes_outside_koras_own_profiles_dir() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        let a = store.add("claude", "personal").await.unwrap();

        // Point the record somewhere it has no business deleting.
        let outsider = tmp_root();
        std::fs::write(outsider.join("important.txt"), b"keep me").unwrap();
        {
            let mut state = store.state.lock().await;
            state.accounts[0].dir = outsider.to_string_lossy().to_string();
        }

        store.remove(&a.id).await.unwrap();
        assert!(outsider.join("important.txt").exists(), "must not delete it");

        let _ = std::fs::remove_dir_all(&outsider);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn renaming_keeps_the_directory_and_the_identity() {
        let root = tmp_root();
        let store = AccountStore::new(&root);
        let a = store.add("claude", "personal").await.unwrap();
        store.rename(&a.id, "home").await.unwrap();

        let after = store.get(&a.id).await.unwrap();
        assert_eq!(after.name, "home");
        assert_eq!(after.dir, a.dir);
        assert!(store.rename(&a.id, " ").await.is_err());
        assert!(store.rename("nope", "x").await.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_corrupt_index_does_not_stop_kora_from_starting() {
        let root = tmp_root();
        std::fs::write(AccountStore::index_path(&root), b"{ not json").unwrap();
        let store = AccountStore::new(&root);
        assert!(store.list("claude").await.is_empty());
        // And it recovers: adding still works and rewrites the file.
        store.add("claude", "personal").await.unwrap();
        assert_eq!(store.list("claude").await.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
