//! User settings.
//!
//! One JSON file next to Kora's data. It holds preferences only — **never a
//! credential**: accounts are profile directories the agent owns (Phase 3), and
//! there is deliberately no field here that could carry a secret. The test at
//! the bottom of `config.rs` is what keeps that true.

pub mod config;
