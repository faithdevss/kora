//! File ingestion: what a dropped or attached file becomes.
//!
//! One file at a time (the v1 scope in `plan/phase-5-rich-content-search.md`),
//! always size-bounded, and never guessed at: a file whose bytes are not valid
//! UTF-8 is reported as binary rather than sent to an agent as mangled text.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

/// Text beyond this is truncated before it reaches the prompt. Roughly 16k
/// tokens — enough for any source file worth reading in full, small enough that
/// one careless drop cannot fill the context window.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// Images beyond this are refused. The API's own limit is around 5 MB of
/// base64, which is roughly 3.7 MB of bytes.
pub const MAX_IMAGE_BYTES: u64 = 3_500_000;

/// Any file beyond this is refused before it is read at all.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// What kind of thing was attached, which decides how it travels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Text,
    Image,
    /// Readable as bytes but not as text — attached by reference only.
    Binary,
}

/// One ingested file, ready for the UI and for [`crate::adapters::Attachment`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestedFile {
    /// Absolute, symlinks resolved.
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    /// Size on disk, before any truncation.
    pub size: u64,
    /// e.g. `"image/png"`, `"text/markdown"`.
    pub media_type: String,
    /// Text content, for [`FileKind::Text`]. Truncated to [`MAX_TEXT_BYTES`].
    pub text: Option<String>,
    /// Base64 bytes, for [`FileKind::Image`].
    pub data: Option<String>,
    /// Whether `text` is only the head of the file.
    pub truncated: bool,
    /// Something the user should know before sending, e.g. that it was cut.
    pub note: Option<String>,
}

/// Extensions we are willing to treat as text without sniffing.
const TEXT_EXTS: &[(&str, &str)] = &[
    ("md", "text/markdown"),
    ("markdown", "text/markdown"),
    ("txt", "text/plain"),
    ("log", "text/plain"),
    ("json", "application/json"),
    ("jsonl", "application/json"),
    ("yaml", "text/yaml"),
    ("yml", "text/yaml"),
    ("toml", "text/toml"),
    ("csv", "text/csv"),
    ("html", "text/html"),
    ("css", "text/css"),
    ("sql", "text/plain"),
    ("sh", "text/x-shellscript"),
    ("rs", "text/x-rust"),
    ("ts", "text/typescript"),
    ("tsx", "text/typescript"),
    ("js", "text/javascript"),
    ("jsx", "text/javascript"),
    ("py", "text/x-python"),
    ("go", "text/x-go"),
    ("java", "text/x-java"),
    ("rb", "text/x-ruby"),
    ("php", "text/x-php"),
    ("c", "text/x-c"),
    ("h", "text/x-c"),
    ("cpp", "text/x-c++"),
    ("hpp", "text/x-c++"),
    ("swift", "text/x-swift"),
    ("kt", "text/x-kotlin"),
    ("xml", "text/xml"),
    ("svg", "image/svg+xml"),
];

const IMAGE_EXTS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Resolves `path`, following symlinks, and refuses anything that is not a
/// regular file. Returning the canonical path is what later checks compare.
fn resolve(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("no file path given".into());
    }
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "~".into())).join(rest),
        None => PathBuf::from(path),
    };
    let resolved = expanded
        .canonicalize()
        .map_err(|_| format!("no such file: {path}"))?;
    if resolved.is_dir() {
        return Err(format!(
            "{} is a folder — attach a single file instead",
            resolved
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("that")
        ));
    }
    if !resolved.is_file() {
        return Err(format!("not a regular file: {path}"));
    }
    Ok(resolved)
}

/// Reads and classifies one file from disk.
pub fn ingest(path: &str) -> Result<IngestedFile, String> {
    let resolved = resolve(path)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    let size = meta.len();
    let name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    if size > MAX_FILE_BYTES {
        return Err(format!(
            "{name} is {} — too large to attach. Ask the agent to read it instead.",
            human(size)
        ));
    }

    let ext = extension(&resolved);
    let path_str = resolved.to_string_lossy().to_string();

    // --- image ---
    if let Some((_, media)) = IMAGE_EXTS.iter().find(|(e, _)| *e == ext) {
        if size > MAX_IMAGE_BYTES {
            return Err(format!(
                "{name} is {} — over the {} image limit.",
                human(size),
                human(MAX_IMAGE_BYTES)
            ));
        }
        let bytes = std::fs::read(&resolved).map_err(|e| e.to_string())?;
        return Ok(IngestedFile {
            path: path_str,
            name,
            kind: FileKind::Image,
            size,
            media_type: (*media).to_string(),
            text: None,
            data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            truncated: false,
            note: None,
        });
    }

    // --- text, if it really is text ---
    // Read at most one byte past the cap, so "was there more?" needs no second
    // stat, and a huge file never lands in memory whole.
    let bytes = read_head(&resolved, MAX_TEXT_BYTES + 1)?;
    classify_text(&bytes, name, path_str, size, &ext)
}

/// Classifies bytes that never had a path — a pasted screenshot, or a file the
/// webview's own picker handed over.
///
/// Same limits and the same refusals as [`ingest`], so which route a file took
/// into Kora cannot change what Kora does with it.
pub fn ingest_bytes(name: &str, bytes: &[u8], media_hint: Option<&str>) -> Result<IngestedFile, String> {
    let name = if name.trim().is_empty() { "pasted" } else { name.trim() };
    let size = bytes.len() as u64;
    let ext = extension(Path::new(name));

    let is_image = IMAGE_EXTS.iter().any(|(e, _)| *e == ext)
        || media_hint.is_some_and(|m| m.starts_with("image/"));

    if is_image {
        if size > MAX_IMAGE_BYTES {
            return Err(format!(
                "{name} is {} — over the {} image limit.",
                human(size),
                human(MAX_IMAGE_BYTES)
            ));
        }
        let media = IMAGE_EXTS
            .iter()
            .find(|(e, _)| *e == ext)
            .map(|(_, m)| (*m).to_string())
            .or_else(|| media_hint.map(str::to_string))
            .unwrap_or_else(|| "image/png".to_string());
        return Ok(IngestedFile {
            // No path: this never existed on disk.
            path: String::new(),
            name: name.to_string(),
            kind: FileKind::Image,
            size,
            media_type: media,
            text: None,
            data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            truncated: false,
            note: None,
        });
    }

    if size > MAX_FILE_BYTES {
        return Err(format!("{name} is {} — too large to attach.", human(size)));
    }
    let head = &bytes[..bytes.len().min(MAX_TEXT_BYTES + 1)];
    classify_text(head, name.to_string(), String::new(), size, &ext)
}

/// Decides whether `bytes` are text, and truncates them if so.
fn classify_text(
    bytes: &[u8],
    name: String,
    path_str: String,
    size: u64,
    ext: &str,
) -> Result<IngestedFile, String> {
    let over = bytes.len() > MAX_TEXT_BYTES;
    let head = &bytes[..bytes.len().min(MAX_TEXT_BYTES)];

    match std::str::from_utf8(head) {
        Ok(text) if !head.contains(&0) => {
            let media = TEXT_EXTS
                .iter()
                .find(|(e, _)| *e == ext)
                .map(|(_, m)| *m)
                .unwrap_or("text/plain");
            let size = size.max(head.len() as u64);
            let truncated = over || size as usize > head.len();
            Ok(IngestedFile {
                path: path_str,
                name: name.clone(),
                kind: FileKind::Text,
                size,
                media_type: media.to_string(),
                text: Some(text.to_string()),
                data: None,
                truncated,
                note: truncated.then(|| {
                    format!(
                        "{name} is {} — only the first {} is attached; the agent can read the rest from disk.",
                        human(size),
                        human(MAX_TEXT_BYTES as u64)
                    )
                }),
            })
        }
        // Invalid UTF-8 mid-character at the cut is still text; a NUL byte or a
        // decode failure early on is not.
        Err(e) if over && e.valid_up_to() > MAX_TEXT_BYTES.saturating_sub(4) => {
            let text = String::from_utf8_lossy(&head[..e.valid_up_to()]).to_string();
            Ok(IngestedFile {
                path: path_str,
                name: name.clone(),
                kind: FileKind::Text,
                size,
                media_type: "text/plain".into(),
                text: Some(text),
                data: None,
                truncated: true,
                note: Some(format!(
                    "{name} is {} — only the first {} is attached.",
                    human(size),
                    human(MAX_TEXT_BYTES as u64)
                )),
            })
        }
        _ => Ok(IngestedFile {
            path: path_str,
            name: name.clone(),
            kind: FileKind::Binary,
            size,
            media_type: "application/octet-stream".into(),
            text: None,
            data: None,
            truncated: false,
            note: Some(format!(
                "{name} is binary — its path is sent, not its contents."
            )),
        }),
    }
}

/// Reads at most `limit` bytes from the front of a file.
fn read_head(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take(limit as u64)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Bytes as something a person reads: `1.4 MB`, `12 KB`.
pub fn human(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b >= KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("kora-ingest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().to_string()
    }

    #[test]
    fn a_source_file_comes_back_as_text_with_its_type() {
        let d = tmp();
        let p = write(&d, "main.rs", b"fn main() {}\n");
        let f = ingest(&p).unwrap();

        assert_eq!(f.kind, FileKind::Text);
        assert_eq!(f.media_type, "text/x-rust");
        assert_eq!(f.text.unwrap(), "fn main() {}\n");
        assert!(!f.truncated);
        assert!(f.note.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_large_text_file_is_truncated_and_says_so() {
        let d = tmp();
        let big = "x".repeat(MAX_TEXT_BYTES * 2);
        let p = write(&d, "huge.log", big.as_bytes());
        let f = ingest(&p).unwrap();

        assert!(f.truncated);
        assert_eq!(f.text.as_ref().unwrap().len(), MAX_TEXT_BYTES);
        assert!(f.note.unwrap().contains("only the first"));
        assert_eq!(f.size, (MAX_TEXT_BYTES * 2) as u64, "the real size is reported");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_binary_file_is_attached_by_reference_rather_than_as_mangled_text() {
        let d = tmp();
        let p = write(&d, "thing.bin", &[0u8, 159, 146, 150, 0, 1, 2]);
        let f = ingest(&p).unwrap();

        assert_eq!(f.kind, FileKind::Binary);
        assert!(f.text.is_none() && f.data.is_none());
        assert!(f.note.unwrap().contains("binary"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_image_comes_back_base64_with_its_media_type() {
        let d = tmp();
        // A one-pixel PNG's header is enough; ingest does not decode images.
        let p = write(&d, "shot.PNG", b"\x89PNG\r\n\x1a\n and some bytes");
        let f = ingest(&p).unwrap();

        assert_eq!(f.kind, FileKind::Image);
        assert_eq!(f.media_type, "image/png", "extension case must not matter");
        assert!(f.data.is_some() && f.text.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_oversized_image_is_refused_rather_than_silently_shrunk() {
        let d = tmp();
        let p = write(&d, "big.png", &vec![7u8; MAX_IMAGE_BYTES as usize + 1]);
        let err = ingest(&p).unwrap_err();
        assert!(err.contains("image limit"), "{err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_folder_is_refused_with_something_the_user_can_act_on() {
        let d = tmp();
        let err = ingest(d.to_str().unwrap()).unwrap_err();
        assert!(err.contains("folder"), "{err}");
        assert!(err.contains("single file"), "{err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_file_fails_before_anything_is_read() {
        assert!(ingest("/nope/nothing/here.txt").unwrap_err().contains("no such file"));
        assert!(ingest("   ").is_err());
    }

    #[test]
    fn the_path_that_comes_back_is_resolved_not_the_one_that_went_in() {
        let d = tmp();
        write(&d, "a.txt", b"hi");
        // A path with a `..` segment must not survive into the record.
        let sneaky = d.join("sub").join("..").join("a.txt");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let f = ingest(sneaky.to_str().unwrap()).unwrap();

        assert!(!f.path.contains(".."));
        assert!(f.path.ends_with("a.txt"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sizes_read_the_way_a_person_would_say_them() {
        assert_eq!(human(512), "512 B");
        assert_eq!(human(2048), "2 KB");
        assert_eq!(human(3_500_000), "3.3 MB");
    }
}

#[cfg(test)]
mod byte_tests {
    use super::*;

    #[test]
    fn a_pasted_screenshot_is_classified_from_its_media_type() {
        let f = ingest_bytes("pasted", b"\x89PNG fake bytes", Some("image/png")).unwrap();
        assert_eq!(f.kind, FileKind::Image);
        assert_eq!(f.media_type, "image/png");
        assert!(f.data.is_some());
        assert_eq!(f.path, "", "a pasted image never existed on disk");
    }

    #[test]
    fn a_pasted_image_over_the_limit_is_refused_the_same_way_a_dropped_one_is() {
        let big = vec![0u8; MAX_IMAGE_BYTES as usize + 1];
        let err = ingest_bytes("shot.png", &big, Some("image/png")).unwrap_err();
        assert!(err.contains("image limit"), "{err}");
    }

    #[test]
    fn picked_text_is_truncated_by_the_same_rule_as_a_dropped_file() {
        let big = "y".repeat(MAX_TEXT_BYTES * 2);
        let f = ingest_bytes("notes.md", big.as_bytes(), None).unwrap();

        assert_eq!(f.kind, FileKind::Text);
        assert_eq!(f.media_type, "text/markdown");
        assert!(f.truncated);
        assert_eq!(f.text.unwrap().len(), MAX_TEXT_BYTES);
        assert_eq!(f.size, (MAX_TEXT_BYTES * 2) as u64);
    }

    #[test]
    fn picked_binary_is_still_refused_as_text() {
        let f = ingest_bytes("x.dat", &[0, 1, 2, 0, 3], None).unwrap();
        assert_eq!(f.kind, FileKind::Binary);
        assert!(f.note.unwrap().contains("binary"));
    }

    #[test]
    fn an_unnamed_paste_still_gets_a_name() {
        let f = ingest_bytes("  ", b"hello", None).unwrap();
        assert_eq!(f.name, "pasted");
        assert_eq!(f.kind, FileKind::Text);
    }
}
