//! Agent process management.
//!
//! Named `proc` rather than `pty` deliberately: the Phase 2 spike settled on
//! structured mode, which is plain stdin/stdout pipes, so there is no terminal
//! to emulate and no ANSI to strip. See `plan/phase-2-agent-exec.md`.

pub mod manager;
