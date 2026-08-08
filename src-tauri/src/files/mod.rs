//! Reading files the user attached, and handing files back to their editor.
//!
//! Everything here runs on a path the webview supplied, so every path is
//! resolved before use and every read is bounded: a dropped 2 GB log must not
//! become a 2 GB IPC message, and a binary must not be sent as if it were text
//! (master plan, Security #2; `plan/phase-5-rich-content-search.md` → Security).

pub mod ingest;
pub mod open;
