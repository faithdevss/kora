//! Per-token prices, kept in one small table because they change.
//!
//! Used only to estimate an API-equivalent figure. For a subscription account
//! this is **not** what the user pays, and the UI must label it accordingly —
//! see [`crate::accounts::Account::is_subscription`].
//!
//! Prices are USD per million tokens.

/// What one model costs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Price {
    /// Cost of one turn, in USD.
    pub fn cost(&self, input: u64, output: u64, cache_read: u64, cache_write: u64) -> f64 {
        (input as f64 * self.input
            + output as f64 * self.output
            + cache_read as f64 * self.cache_read
            + cache_write as f64 * self.cache_write)
            / 1_000_000.0
    }
}

/// Matched by substring against the model id the agent reported, longest first,
/// so `claude-haiku-4-5-20251001` finds the haiku row.
const TABLE: &[(&str, Price)] = &[
    (
        "opus",
        Price {
            input: 15.0,
            output: 75.0,
            cache_read: 1.5,
            cache_write: 18.75,
        },
    ),
    (
        "sonnet",
        Price {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
        },
    ),
    (
        "haiku",
        Price {
            input: 1.0,
            output: 5.0,
            cache_read: 0.1,
            cache_write: 1.25,
        },
    ),
];

/// Price for a model id, or `None` when we have no entry rather than a guess.
pub fn for_model(model: &str) -> Option<Price> {
    let m = model.to_ascii_lowercase();
    TABLE
        .iter()
        .find(|(key, _)| m.contains(key))
        .map(|(_, p)| *p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids_and_aliases_both_resolve() {
        assert_eq!(for_model("opus").unwrap().input, 15.0);
        assert_eq!(for_model("claude-opus-5").unwrap().output, 75.0);
        assert_eq!(for_model("claude-haiku-4-5-20251001").unwrap().input, 1.0);
        assert_eq!(for_model("Claude-Sonnet-5").unwrap().input, 3.0);
    }

    #[test]
    fn an_unknown_model_has_no_price_rather_than_a_made_up_one() {
        assert!(for_model("some-future-model").is_none());
        assert!(for_model("").is_none());
    }

    #[test]
    fn cost_is_per_million_and_counts_cache_separately() {
        let p = for_model("sonnet").unwrap();
        // 1M input at $3, 1M output at $15.
        assert!((p.cost(1_000_000, 1_000_000, 0, 0) - 18.0).abs() < 1e-9);
        // Cache reads are far cheaper than fresh input.
        assert!(p.cost(0, 0, 1_000_000, 0) < p.cost(1_000_000, 0, 0, 0));
        assert_eq!(p.cost(0, 0, 0, 0), 0.0);
    }
}
