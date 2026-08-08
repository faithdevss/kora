//! Accounts.
//!
//! An account is a directory the wrapped CLI authenticates into — for Claude
//! Code, a `CLAUDE_CONFIG_DIR`. Kora creates the directory, runs the agent's own
//! login against it, and afterwards asks the agent who lives there.
//!
//! **Kora never holds a credential.** Everything persisted here is non-secret
//! identity the agent reported back: a name, a path, an email, an org, a
//! subscription type. There is no key to leak, log, or migrate — see
//! `plan/phase-3-accounts-usage.md` → "Spike Results" for why this replaced the
//! originally-planned keychain integration.

pub mod store;

use serde::{Deserialize, Serialize};

use crate::adapters::AccountIdentity;

/// One account: a profile directory plus whatever the agent says about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    /// Which agent this account belongs to.
    pub agent_id: String,
    /// User-facing name, e.g. "personal". Editable.
    pub name: String,
    /// Absolute path to the profile directory. Owned by Kora, written by the agent.
    pub dir: String,
    /// Identity last read from the agent. `None` until first probed.
    #[serde(default)]
    pub identity: Option<AccountIdentity>,
}

impl Account {
    /// What to show in a list where the mockup showed a masked key.
    ///
    /// There is deliberately no key to mask: this returns the account's real
    /// identity instead, which is both more useful and impossible to leak.
    pub fn subtitle(&self) -> String {
        match &self.identity {
            None => "not signed in yet".to_string(),
            Some(id) if !id.logged_in => "signed out — run /accounts login".to_string(),
            Some(id) => {
                let who = id.email.clone().unwrap_or_else(|| "signed in".to_string());
                match (&id.subscription, &id.org_name) {
                    (Some(plan), _) => format!("{who}  ·  Claude {plan}"),
                    (None, Some(org)) => format!("{who}  ·  {org}"),
                    (None, None) => who,
                }
            }
        }
    }

    /// The plan label the UI shows, and cost honesty depends on.
    pub fn plan(&self) -> String {
        match &self.identity {
            Some(id) if id.is_subscription() => id
                .subscription
                .clone()
                .map(|s| format!("Claude {s}"))
                .unwrap_or_else(|| "subscription".to_string()),
            Some(id) if id.logged_in => format!("{} account", id.auth_method),
            _ => "not signed in".to_string(),
        }
    }

    /// Whether a dollar figure derived from tokens would misrepresent spend.
    pub fn is_subscription(&self) -> bool {
        self.identity.as_ref().is_some_and(AccountIdentity::is_subscription)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(identity: Option<AccountIdentity>) -> Account {
        Account {
            id: "a1".into(),
            agent_id: "claude".into(),
            name: "personal".into(),
            dir: "/tmp/x".into(),
            identity,
        }
    }

    #[test]
    fn an_unprobed_account_says_so_rather_than_inventing_a_plan() {
        let a = acct(None);
        assert_eq!(a.subtitle(), "not signed in yet");
        assert_eq!(a.plan(), "not signed in");
        assert!(!a.is_subscription());
    }

    #[test]
    fn a_subscription_account_is_recognised_from_either_signal() {
        let by_type = acct(Some(AccountIdentity {
            logged_in: true,
            auth_method: "claude.ai".into(),
            email: Some("me@example.com".into()),
            org_name: Some("My Org".into()),
            subscription: Some("pro".into()),
        }));
        assert!(by_type.is_subscription());
        assert_eq!(by_type.plan(), "Claude pro");
        assert!(by_type.subtitle().contains("me@example.com"));
        assert!(by_type.subtitle().contains("Claude pro"));
    }

    #[test]
    fn an_api_key_account_is_not_treated_as_a_subscription() {
        let a = acct(Some(AccountIdentity {
            logged_in: true,
            auth_method: "apiKey".into(),
            email: None,
            org_name: Some("Acme".into()),
            subscription: None,
        }));
        assert!(!a.is_subscription());
        assert_eq!(a.plan(), "apiKey account");
    }

    #[test]
    fn a_signed_out_account_is_marked_and_offers_the_fix() {
        let a = acct(Some(AccountIdentity {
            logged_in: false,
            auth_method: "none".into(),
            ..Default::default()
        }));
        assert!(a.subtitle().contains("/accounts login"));
    }

    #[test]
    fn nothing_secret_is_representable_on_an_account() {
        // The struct is the whole persisted shape; if a token field ever appears
        // here, this test is the place that should have to change.
        let json = serde_json::to_string(&acct(Some(AccountIdentity {
            logged_in: true,
            auth_method: "claude.ai".into(),
            email: Some("me@example.com".into()),
            org_name: None,
            subscription: Some("pro".into()),
        })))
        .unwrap();
        for secret_shaped in ["token", "key", "secret", "password", "credential"] {
            assert!(
                !json.to_lowercase().contains(secret_shaped),
                "account JSON must not carry anything {secret_shaped}-shaped: {json}"
            );
        }
    }
}
