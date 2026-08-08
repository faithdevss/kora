//! Extension points that are declared but not built.
//!
//! `docs/features.gpt.md` §30 lists MCP server management and Git integration
//! as future work. They are **interfaces only** here: no implementation, no
//! commands, no UI. The point of writing them down now is that the shapes are
//! agreed while the surrounding code is fresh, so adding one later is filling
//! in a trait rather than deciding what it should have been.
//!
//! The *real* extension point for v1 is [`crate::adapters::AgentAdapter`] —
//! adding a second agent needs nothing from this module. See
//! `docs/adding-an-agent.md`.

pub mod git;
pub mod mcp;
