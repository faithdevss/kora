// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Start of process, for the cold-start measurement. Reported to stderr when
    // `KORA_TIMING=1`, so the number in `plan/phase-6-polish-extensibility.md`
    // can be re-measured on any machine rather than taken on trust.
    kora_lib::run(std::time::Instant::now())
}
