//! Handing a file back to the user's own tools.
//!
//! Both entry points here take a path that came from the webview, so both go
//! through the same rule: **argv array, never a shell string**. A file called
//! `; rm -rf ~` is one argument, not a command (master plan, Security #4;
//! phase-5 Security).

use std::path::PathBuf;

/// Editors that need to be told to wait, or not to fork, when opened from a
/// GUI app. Anything else is spawned as-is.
const GUI_EDITORS: &[(&str, &[&str])] = &[
    ("code", &["--new-window"]),
    ("subl", &[]),
    ("zed", &[]),
];

/// The editor command to use, from the environment, with its arguments.
///
/// `$VISUAL` wins over `$EDITOR` because that is what it means: the one to use
/// when a terminal is not necessarily attached. On macOS with neither set,
/// `open` hands the file to whatever the user associated with it.
pub fn editor_command() -> (String, Vec<String>) {
    for var in ["VISUAL", "EDITOR"] {
        let Ok(raw) = std::env::var(var) else { continue };
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        // `EDITOR` conventionally may carry flags ("code -w"). Splitting on
        // whitespace is not shell parsing — no quoting, no substitution, no
        // metacharacters — it just recovers the argv the user wrote.
        let mut parts = raw.split_whitespace().map(str::to_string);
        let program = parts.next().unwrap_or_default();
        let mut args: Vec<String> = parts.collect();
        if args.is_empty() {
            if let Some((_, extra)) = GUI_EDITORS.iter().find(|(name, _)| {
                program == *name || program.ends_with(&format!("/{name}"))
            }) {
                args.extend(extra.iter().map(|s| (*s).to_string()));
            }
        }
        return (program, args);
    }

    #[cfg(target_os = "macos")]
    return ("open".to_string(), Vec::new());
    #[cfg(not(target_os = "macos"))]
    return ("xdg-open".to_string(), Vec::new());
}

/// Opens `path` in the user's editor. Returns the command that was run.
pub fn open_in_editor(path: &str) -> Result<String, String> {
    let resolved = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| format!("no such file: {path}"))?;

    let (program, args) = editor_command();
    std::process::Command::new(&program)
        .args(&args)
        // The path is one argument, whatever characters are in it.
        .arg(&resolved)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                format!("{program} is not installed — set $EDITOR to something that is")
            }
            _ => format!("could not start {program}: {e}"),
        })?;

    Ok(format!("{program} {}", resolved.display()))
}

/// Writes `contents` to `path`, creating parent directories.
///
/// Used by the transcript's "save this code block" action, so the path is
/// whatever the user typed — expanded for `~`, and never interpreted further.
pub fn save_text(path: &str, contents: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("no path given".into());
    }
    let target = match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "~".into())).join(rest),
        None => PathBuf::from(path),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, contents)
        .map_err(|e| format!("could not write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `$VISUAL`/`$EDITOR` are process-global, so these must not overlap.
    fn env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    fn with_env(vars: &[(&str, Option<&str>)], f: impl FnOnce()) {
        let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let saved: Vec<(String, Option<String>)> = vars
            .iter()
            .map(|(k, _)| ((*k).to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in vars {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        f();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(&k, v),
                None => std::env::remove_var(&k),
            }
        }
    }

    #[test]
    fn visual_beats_editor() {
        with_env(&[("VISUAL", Some("nvim")), ("EDITOR", Some("vi"))], || {
            assert_eq!(editor_command().0, "nvim");
        });
    }

    #[test]
    fn an_editor_with_flags_keeps_them_as_separate_arguments() {
        with_env(&[("VISUAL", None), ("EDITOR", Some("code -w -n"))], || {
            let (program, args) = editor_command();
            assert_eq!(program, "code");
            assert_eq!(args, vec!["-w", "-n"]);
        });
    }

    #[test]
    fn an_empty_editor_variable_falls_through_to_the_platform_default() {
        with_env(&[("VISUAL", Some("  ")), ("EDITOR", None)], || {
            let (program, _) = editor_command();
            assert!(program == "open" || program == "xdg-open", "{program}");
        });
    }

    #[test]
    fn a_filename_full_of_shell_syntax_stays_one_argument() {
        // The proof is structural: `open_in_editor` never builds a string for a
        // shell. This asserts the path survives canonicalization intact, which
        // is what gets passed to `.arg()`.
        let dir = std::env::temp_dir().join(format!("kora-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let nasty = dir.join("; rm -rf ~ && echo pwned.txt");
        std::fs::write(&nasty, b"safe").unwrap();

        with_env(&[("VISUAL", Some("true")), ("EDITOR", None)], || {
            let ran = open_in_editor(nasty.to_str().unwrap()).unwrap();
            assert!(ran.contains("; rm -rf ~ && echo pwned.txt"));
            assert!(ran.starts_with("true "));
        });
        // Nothing was deleted, because nothing was interpreted.
        assert!(nasty.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_something_that_is_not_there_fails_before_spawning() {
        assert!(open_in_editor("/nope/not/here").unwrap_err().contains("no such file"));
    }

    #[test]
    fn saving_creates_missing_directories_and_returns_the_path() {
        let dir = std::env::temp_dir().join(format!("kora-save-{}", uuid::Uuid::new_v4()));
        let target = dir.join("nested").join("snippet.ts");
        let written = save_text(target.to_str().unwrap(), "export const x = 1;\n").unwrap();

        assert_eq!(std::fs::read_to_string(&written).unwrap(), "export const x = 1;\n");
        assert!(save_text("  ", "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
