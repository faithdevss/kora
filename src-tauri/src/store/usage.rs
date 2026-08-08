//! Usage history.
//!
//! One row per turn, so any window can be summed afterwards and the totals
//! survive a restart. Token counts are the agent's own, never estimates.

use serde::{Deserialize, Serialize};

use super::{now, Db};
use crate::adapters::Usage;

/// One turn's usage, as recorded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub agent_id: String,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// What the agent said it cost, when it says.
    pub cost_usd: Option<f64>,
}

/// Totals over a window.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Totals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Summed only from turns that carried a cost; `None` when none did.
    pub cost_usd: Option<f64>,
    /// What these tokens would cost at list API prices, for models we have a
    /// price for. On a subscription account this is **not** spend — the UI must
    /// label it as an API-equivalent estimate (acceptance criterion 8).
    pub estimated_cost_usd: Option<f64>,
    pub turns: u64,
}

impl Totals {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_read + self.cache_write
    }
}

/// Seven days in seconds.
pub const WEEK: i64 = 7 * 24 * 60 * 60;

/// Records a turn. Turns with no tokens at all (a local CLI command) are
/// skipped, so they neither inflate counts nor create noise.
pub async fn record(
    db: &Db,
    agent_id: &str,
    account_id: Option<&str>,
    model: Option<&str>,
    usage: &Usage,
) -> Result<bool, String> {
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_read_tokens == 0
        && usage.cache_creation_tokens == 0
    {
        return Ok(false);
    }

    let agent_id = agent_id.to_string();
    let account_id = account_id.map(str::to_string);
    let model = model.map(str::to_string);
    let usage = *usage;

    db.with(move |c| {
        c.execute(
            "INSERT INTO usage (at, agent_id, account_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                now(),
                agent_id,
                account_id,
                model,
                usage.input_tokens as i64,
                usage.output_tokens as i64,
                usage.cache_read_tokens as i64,
                usage.cache_creation_tokens as i64,
                usage.total_cost_usd,
            ],
        )?;
        Ok(())
    })
    .await?;
    Ok(true)
}

/// Totals for one account since `since` (unix seconds).
///
/// Summed per model, so the API-equivalent estimate can be priced with each
/// model's own rate rather than one blended guess.
pub async fn totals_since(db: &Db, account_id: Option<&str>, since: i64) -> Result<Totals, String> {
    let account_id = account_id.map(str::to_string);

    db.with(move |c| {
        let sql = "SELECT model, COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                          COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0),
                          SUM(cost_usd), COUNT(*)
                   FROM usage WHERE at >= ?1";
        let group = " GROUP BY model";
        let map = |row: &rusqlite::Row| -> Result<PerModel, rusqlite::Error> {
            Ok(PerModel {
                model: row.get::<_, Option<String>>(0)?,
                input: row.get::<_, i64>(1)? as u64,
                output: row.get::<_, i64>(2)? as u64,
                cache_read: row.get::<_, i64>(3)? as u64,
                cache_write: row.get::<_, i64>(4)? as u64,
                cost: row.get::<_, Option<f64>>(5)?,
                turns: row.get::<_, i64>(6)? as u64,
            })
        };

        let rows: Vec<PerModel> = match &account_id {
            Some(id) => {
                let mut stmt = c.prepare(&format!("{sql} AND account_id = ?2{group}"))?;
                let rows = stmt
                    .query_map(rusqlite::params![since, id], map)?
                    .collect::<Result<_, _>>()?;
                rows
            }
            None => {
                let mut stmt = c.prepare(&format!("{sql}{group}"))?;
                let rows = stmt
                    .query_map(rusqlite::params![since], map)?
                    .collect::<Result<_, _>>()?;
                rows
            }
        };
        Ok(fold(rows))
    })
    .await
}

/// One model's slice of a window, before folding.
struct PerModel {
    model: Option<String>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cost: Option<f64>,
    turns: u64,
}

fn fold(rows: Vec<PerModel>) -> Totals {
    let mut t = Totals::default();
    for r in rows {
        t.input_tokens += r.input;
        t.output_tokens += r.output;
        t.cache_read += r.cache_read;
        t.cache_write += r.cache_write;
        t.turns += r.turns;
        if let Some(c) = r.cost {
            t.cost_usd = Some(t.cost_usd.unwrap_or(0.0) + c);
        }
        // Priced only where we have a rate; an unknown model contributes
        // nothing rather than a made-up number.
        if let Some(price) = r.model.as_deref().and_then(super::pricing::for_model) {
            let est = price.cost(r.input, r.output, r.cache_read, r.cache_write);
            t.estimated_cost_usd = Some(t.estimated_cost_usd.unwrap_or(0.0) + est);
        }
    }
    t
}

/// Rolling seven-day totals — what the WEEK meter falls back to for agents that
/// report no quota of their own.
pub async fn week(db: &Db, account_id: Option<&str>) -> Result<Totals, String> {
    totals_since(db, account_id, now() - WEEK).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64, cost: Option<f64>) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            total_cost_usd: cost,
            context_window: None,
        }
    }

    #[tokio::test]
    async fn totals_accumulate_across_turns() {
        let db = Db::in_memory().unwrap();
        record(&db, "claude", Some("a1"), Some("sonnet"), &usage(10, 20, Some(0.01)))
            .await
            .unwrap();
        record(&db, "claude", Some("a1"), Some("sonnet"), &usage(5, 7, Some(0.02)))
            .await
            .unwrap();

        let t = week(&db, Some("a1")).await.unwrap();
        assert_eq!(t.input_tokens, 15);
        assert_eq!(t.output_tokens, 27);
        assert_eq!(t.turns, 2);
        assert!((t.cost_usd.unwrap() - 0.03).abs() < 1e-9);
        assert_eq!(t.total_tokens(), 42);
    }

    #[tokio::test]
    async fn totals_are_scoped_per_account() {
        let db = Db::in_memory().unwrap();
        record(&db, "claude", Some("a1"), None, &usage(10, 0, None)).await.unwrap();
        record(&db, "claude", Some("a2"), None, &usage(99, 0, None)).await.unwrap();

        assert_eq!(week(&db, Some("a1")).await.unwrap().input_tokens, 10);
        assert_eq!(week(&db, Some("a2")).await.unwrap().input_tokens, 99);
        // Unscoped sums everything.
        assert_eq!(week(&db, None).await.unwrap().input_tokens, 109);
    }

    #[tokio::test]
    async fn a_zero_token_turn_is_not_recorded() {
        let db = Db::in_memory().unwrap();
        // What a local CLI command like /cost reports.
        let recorded = record(&db, "claude", Some("a1"), None, &usage(0, 0, Some(0.0)))
            .await
            .unwrap();
        assert!(!recorded);
        assert_eq!(week(&db, Some("a1")).await.unwrap().turns, 0);
    }

    #[tokio::test]
    async fn cost_is_absent_rather_than_zero_when_nothing_reported_it() {
        let db = Db::in_memory().unwrap();
        record(&db, "claude", Some("a1"), None, &usage(10, 20, None)).await.unwrap();
        let t = week(&db, Some("a1")).await.unwrap();
        assert_eq!(t.cost_usd, None, "no reported cost must not read as $0.00");
        assert_eq!(t.turns, 1);
    }

    #[tokio::test]
    async fn tokens_are_priced_per_model_for_the_api_equivalent_estimate() {
        let db = Db::in_memory().unwrap();
        // 1M sonnet input ($3) + 1M opus output ($75).
        record(&db, "claude", Some("a1"), Some("sonnet"), &usage(1_000_000, 0, None))
            .await
            .unwrap();
        record(&db, "claude", Some("a1"), Some("claude-opus-5"), &usage(0, 1_000_000, None))
            .await
            .unwrap();

        let t = week(&db, Some("a1")).await.unwrap();
        assert!((t.estimated_cost_usd.unwrap() - 78.0).abs() < 1e-6);
        assert_eq!(t.cost_usd, None, "nothing reported a real cost");
    }

    #[tokio::test]
    async fn an_unpriced_model_contributes_no_estimate() {
        let db = Db::in_memory().unwrap();
        record(&db, "claude", Some("a1"), Some("some-future-model"), &usage(500, 500, None))
            .await
            .unwrap();
        let t = week(&db, Some("a1")).await.unwrap();
        assert_eq!(t.estimated_cost_usd, None, "an unknown price must not read as $0.00");
        assert_eq!(t.input_tokens, 500, "the tokens are still counted");
    }

    #[tokio::test]
    async fn the_window_excludes_older_turns() {
        let db = Db::in_memory().unwrap();
        record(&db, "claude", Some("a1"), None, &usage(10, 0, None)).await.unwrap();

        // Backdate it beyond the window.
        db.with(|c| {
            c.execute("UPDATE usage SET at = ?1", [now() - WEEK - 60])?;
            Ok(())
        })
        .await
        .unwrap();

        assert_eq!(week(&db, Some("a1")).await.unwrap().turns, 0);
        // But it is still there for a wider window.
        assert_eq!(
            totals_since(&db, Some("a1"), 0).await.unwrap().turns,
            1,
            "history is kept, only the window moves"
        );
    }

    #[tokio::test]
    async fn totals_survive_reopening_the_database() {
        let dir = std::env::temp_dir().join(format!("kora-usage-{}", uuid::Uuid::new_v4()));
        {
            let db = Db::open(&dir).unwrap();
            record(&db, "claude", Some("a1"), None, &usage(100, 200, Some(0.5)))
                .await
                .unwrap();
        }
        let db = Db::open(&dir).unwrap();
        let t = week(&db, Some("a1")).await.unwrap();
        assert_eq!(t.input_tokens, 100);
        assert_eq!(t.output_tokens, 200);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
