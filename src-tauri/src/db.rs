use crate::enrich;
use crate::glossary::{self, GlossaryTerm};
use crate::review::{self, Answer, Step};
use rusqlite::{
    backup::Backup, params, params_from_iter, Connection, OptionalExtension, Result as SqlResult,
    Row,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DB_FILENAME: &str = "gege.db";
pub const LEGACY_DB_FILENAME: &str = "lexnote.db";
pub const DATA_DIR_POINTER_FILENAME: &str = "data-dir.txt";
const AUTO_BACKUP_PREFIX: &str = "gege-backup-";
const PREMIGRATION_BACKUP_PREFIX: &str = "gege-premigrate-";
const RESTORE_SAFETY_PREFIX: &str = "gege-restore-safety-";
const MIN_FREE_SPACE_BYTES: u64 = 16 * 1024 * 1024;

/// Which rows of `words` are bare, for [`Database::bare_words`]. It has to say what
/// [`enrich::is_bare`] says about the document (a test holds the two to each other). The `CASE`
/// keeps one row with a damaged document from failing the whole query.
const BARE_WORDS_SQL: &str = "COALESCE(NULLIF(kind, ''), 'word') IN ('word', 'phrase')
    AND CASE WHEN json_valid(data)
        THEN COALESCE(json_array_length(data, '$.senses'), 0) = 0
         AND COALESCE(json_array_length(data, '$.examples'), 0) = 0
        ELSE 0 END";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataDirChangeResult {
    pub old_db_path: String,
    pub new_db_path: String,
    pub backups_copied: u32,
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub(crate) copied_backup_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupWarning {
    pub kind: String,
    pub message: String,
}

fn glossary_term_from_row(row: &Row<'_>) -> rusqlite::Result<GlossaryTerm> {
    Ok(GlossaryTerm {
        id: row.get(0)?,
        term: row.get(1)?,
        translation: row.get(2)?,
        domain: row.get(3)?,
        note: row.get(4)?,
        case_sensitive: row.get::<_, i64>(5)? != 0,
        enabled: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn escape_tsv(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

fn unescape_tsv(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some('t') => result.push('\t'),
            Some('r') => result.push('\r'),
            Some('n') => result.push('\n'),
            Some('\\') => result.push('\\'),
            Some(other) => {
                result.push('\\');
                result.push(other);
            }
            None => result.push('\\'),
        }
    }
    result
}

/// Read the persisted pointer without silently falling back. A present but
/// unavailable directory is returned as-is so startup can enter recovery.
pub fn read_configured_data_dir(default_dir: &Path) -> Result<Option<PathBuf>, String> {
    let pointer = default_dir.join(DATA_DIR_POINTER_FILENAME);
    if !pointer.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&pointer).map_err(|e| format!("读取数据目录配置失败: {e}"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("数据目录配置为空".into());
    }
    Ok(Some(PathBuf::from(trimmed)))
}

pub fn persist_configured_data_dir(default_dir: &Path, data_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(default_dir).map_err(|e| format!("创建默认数据目录失败: {e}"))?;
    let pointer = default_dir.join(DATA_DIR_POINTER_FILENAME);
    let temp = default_dir.join(format!(
        ".{DATA_DIR_POINTER_FILENAME}.tmp-{}",
        std::process::id()
    ));
    {
        let mut file =
            fs::File::create(&temp).map_err(|e| format!("创建数据目录临时配置失败: {e}"))?;
        file.write_all(data_dir.to_string_lossy().as_bytes())
            .map_err(|e| format!("写入数据目录临时配置失败: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("同步数据目录配置失败: {e}"))?;
    }
    atomic_replace(&temp, &pointer).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("保存数据目录配置失败: {e}")
    })
}

fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination_wide: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // SAFETY: both strings are NUL-terminated UTF-16 buffers owned for the call.
        unsafe {
            MoveFileExW(
                PCWSTR(source_wide.as_ptr()),
                PCWSTR(destination_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if destination.exists() {
            fs::remove_file(destination).map_err(|e| e.to_string())?;
        }
        fs::rename(source, destination).map_err(|e| e.to_string())
    }
}

/// Resolve the database file path with legacy compatibility.
/// 1. If `gege.db` exists in dir, return it.
/// 2. If only `lexnote.db` exists, snapshot it to `gege.db` and keep the
///    legacy file untouched.
/// 3. Otherwise return `gege.db` (will be created).
pub fn resolve_db_path(data_dir: &Path) -> PathBuf {
    let primary = data_dir.join(DB_FILENAME);
    if primary.exists() {
        return primary;
    }
    let legacy = data_dir.join(LEGACY_DB_FILENAME);
    if legacy.exists() {
        eprintln!(
            "[db] Migrating legacy database via SQLite backup: {} -> {}",
            legacy.display(),
            primary.display()
        );
        let result = (|| -> Result<(), String> {
            let source = Connection::open(&legacy).map_err(|e| format!("打开旧数据库失败: {e}"))?;
            snapshot_connection(&source, &primary, false)
        })();
        if let Err(e) = result {
            // Do not create a partial copy when the legacy file is invalid or
            // inaccessible. The caller can continue using the legacy path.
            eprintln!("[db] Legacy snapshot failed: {e}; keeping legacy database path");
            return legacy;
        }
        return primary;
    }
    primary
}

pub struct Database {
    conn: Connection,
    path: String,
}

fn normalize_import_lemma(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `words.anki_note_id` mirrors the `ankiNoteId` key of the JSON document so an
/// "already sent to Anki" check can use the index instead of parsing every
/// row. Anki ids are 64-bit, hence the TEXT column.
fn anki_note_id_column(word: &Value) -> Option<String> {
    match word.get("ankiNoteId") {
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => None,
    }
}

fn str_field<'a>(word: &'a Value, key: &str) -> &'a str {
    word.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Trimmed, de-duplicated (order preserving) tags of a word document.
fn tags_of(word: &Value) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for tag in word
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let tag = tag.trim();
        if !tag.is_empty() && !tags.iter().any(|existing| existing == tag) {
            tags.push(tag.to_string());
        }
    }
    tags
}

fn tags_value(tags: Vec<String>) -> Value {
    Value::Array(tags.into_iter().map(Value::String).collect())
}

fn word_json_by_id(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row("SELECT data FROM words WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| format!("词条数据损坏 ({id}): {e}")))
        .transpose()
}

/// Find the saved word a lookup refers to: the same normalised lemma and, when
/// given, the same kind. If legacy data already holds duplicates the earliest
/// saved one wins, because it is the one carrying the user's history.
fn find_word_with_connection(
    conn: &Connection,
    lemma: &str,
    kind: Option<&str>,
) -> Result<Option<Value>, String> {
    let key = normalize_import_lemma(lemma);
    if key.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, lemma, COALESCE(kind, 'word') FROM words ORDER BY saved_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let row_lemma: String = row.get(1).map_err(|e| e.to_string())?;
        let row_kind: String = row.get(2).map_err(|e| e.to_string())?;
        let same_kind = match kind {
            Some(wanted) => wanted == row_kind,
            None => true,
        };
        if same_kind && normalize_import_lemma(&row_lemma) == key {
            return word_json_by_id(conn, &id);
        }
    }
    Ok(None)
}

/// Combine a freshly looked-up entry with the word the user already saved. The
/// lookup refreshes the *content*; everything the user owns (identity,
/// progress, note, tags, Anki link) and where/when the word was first
/// collected stays with the stored word, and the lookup counter goes up by one.
///
/// The first source is kept because reading sessions group words by
/// `sourceApp` and `savedAt`; letting a later lookup change either would make
/// words hop between sessions.
fn merged_lookup_word(existing: &Value, incoming: &Value) -> Value {
    let existing_fields = existing.as_object().cloned().unwrap_or_default();
    let mut merged = incoming.as_object().cloned().unwrap_or_default();

    for key in ["id", "mastery", "savedAt", "ankiNoteId"] {
        if let Some(value) = existing_fields.get(key).filter(|value| !value.is_null()) {
            merged.insert(key.to_string(), value.clone());
        }
    }
    for key in ["sourceApp", "sourceTitle"] {
        if !str_field(existing, key).trim().is_empty() {
            merged.insert(
                key.to_string(),
                Value::String(str_field(existing, key).to_string()),
            );
        }
    }
    let same_lemma = normalize_import_lemma(str_field(existing, "lemma"))
        == normalize_import_lemma(str_field(incoming, "lemma"));
    if same_lemma {
        merged.insert(
            "lemma".into(),
            Value::String(str_field(existing, "lemma").to_string()),
        );
    }
    if !str_field(existing, "note").trim().is_empty() {
        merged.insert(
            "note".into(),
            Value::String(str_field(existing, "note").to_string()),
        );
    }
    let mut tags = tags_of(existing);
    for tag in tags_of(incoming) {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    merged.insert("tags".into(), tags_value(tags));
    let previous = existing.get("lookups").and_then(Value::as_u64).unwrap_or(1);
    merged.insert("lookups".into(), Value::from(previous.saturating_add(1)));
    // Keep any other stored field the incoming payload does not know about.
    for (key, value) in existing_fields {
        merged.entry(key).or_insert(value);
    }
    Value::Object(merged)
}

fn ensure_text(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    default: impl FnOnce() -> String,
) {
    let present = object
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty());
    if !present {
        object.insert(key.to_string(), Value::String(default()));
    }
}

/// A looked-up entry that is not saved yet, with every field the rest of the
/// app relies on filled in.
fn new_lookup_word(incoming: &Value) -> Value {
    let tags = tags_of(incoming);
    let mut word = incoming.as_object().cloned().unwrap_or_default();
    ensure_text(&mut word, "id", || uuid::Uuid::new_v4().to_string());
    ensure_text(&mut word, "savedAt", || chrono::Utc::now().to_rfc3339());
    ensure_text(&mut word, "mastery", || "new".to_string());
    ensure_text(&mut word, "kind", || "word".to_string());
    if !word.get("note").is_some_and(Value::is_string) {
        word.insert("note".into(), Value::String(String::new()));
    }
    let lookups = word
        .get("lookups")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
        .unwrap_or(1);
    word.insert("lookups".into(), Value::from(lookups));
    word.insert("tags".into(), tags_value(tags));
    Value::Object(word)
}

const MASTERY_LEVELS: [&str; 4] = ["new", "learning", "familiar", "mastered"];
const MAX_TAGS_PER_BATCH: usize = 20;
const MAX_TAG_CHARS: usize = 32;

/// A change applied to many words at once. Tags are added or removed, never
/// replaced, so every word keeps whatever else the user attached to it.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BatchWordPatch {
    pub mastery: Option<String>,
    pub add_tags: Vec<String>,
    pub remove_tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct BatchUpdateReport {
    pub updated: u32,
    pub missing: u32,
}

struct ValidatedPatch<'a> {
    mastery: Option<&'a str>,
    add_tags: Vec<String>,
    remove_tags: Vec<String>,
}

fn clean_tag_list(tags: &[String]) -> Result<Vec<String>, String> {
    let mut cleaned: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || cleaned.iter().any(|existing| existing == tag) {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(format!("标签过长（最多 {MAX_TAG_CHARS} 个字符）: {tag}"));
        }
        cleaned.push(tag.to_string());
    }
    if cleaned.len() > MAX_TAGS_PER_BATCH {
        return Err(format!("一次最多处理 {MAX_TAGS_PER_BATCH} 个标签"));
    }
    Ok(cleaned)
}

impl BatchWordPatch {
    fn validated(&self) -> Result<ValidatedPatch<'_>, String> {
        let mastery = match self.mastery.as_deref() {
            Some(level) if MASTERY_LEVELS.contains(&level) => Some(level),
            Some(level) => return Err(format!("无效的掌握度: {level}")),
            None => None,
        };
        let add_tags = clean_tag_list(&self.add_tags)?;
        let remove_tags = clean_tag_list(&self.remove_tags)?;
        if mastery.is_none() && add_tags.is_empty() && remove_tags.is_empty() {
            return Err("没有需要应用的修改".into());
        }
        Ok(ValidatedPatch {
            mastery,
            add_tags,
            remove_tags,
        })
    }
}

fn save_word_with_connection(
    conn: &Connection,
    word: &Value,
    include_long_form: bool,
) -> Result<(), String> {
    let id = word.get("id").and_then(Value::as_str).unwrap_or("");
    let lemma = word.get("lemma").and_then(Value::as_str).unwrap_or("");
    let translation = word
        .get("translation")
        .and_then(Value::as_str)
        .unwrap_or("");
    let pos = word.get("pos").and_then(Value::as_str).unwrap_or("");
    let context_meaning = word
        .get("contextMeaning")
        .and_then(Value::as_str)
        .unwrap_or("");
    let explanation = word
        .get("explanation")
        .and_then(Value::as_str)
        .unwrap_or("");
    let source_app = word.get("sourceApp").and_then(Value::as_str).unwrap_or("");
    let source_title = word
        .get("sourceTitle")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mastery = word.get("mastery").and_then(Value::as_str).unwrap_or("new");
    let kind = word.get("kind").and_then(Value::as_str).unwrap_or("word");
    let saved_at = word.get("savedAt").and_then(Value::as_str).unwrap_or("");
    let lookups = word.get("lookups").and_then(Value::as_u64).unwrap_or(1) as i64;
    let now = chrono::Utc::now().to_rfc3339();
    let saved = if saved_at.is_empty() { &now } else { saved_at };
    let anki_note_id = anki_note_id_column(word);
    conn.execute(
        "INSERT INTO words (id, lemma, translation, pos, context_meaning, explanation, source_app, source_title, mastery, kind, saved_at, updated_at, lookups, data, anki_note_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           lemma=excluded.lemma, translation=excluded.translation, pos=excluded.pos,
           context_meaning=excluded.context_meaning, explanation=excluded.explanation,
           source_app=excluded.source_app, source_title=excluded.source_title,
           mastery=excluded.mastery, kind=excluded.kind, updated_at=excluded.updated_at,
           lookups=excluded.lookups, data=excluded.data, anki_note_id=excluded.anki_note_id",
        params![id, lemma, translation, pos, context_meaning, explanation, source_app, source_title, mastery, kind, saved, now, lookups, word.to_string(), anki_note_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM word_tags WHERE word_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(tags) = word.get("tags").and_then(Value::as_array) {
        for tag in tags.iter().filter_map(Value::as_str) {
            conn.execute(
                "INSERT OR IGNORE INTO word_tags (word_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if matches!(kind, "word" | "phrase") || include_long_form {
        conn.execute(
            "INSERT OR IGNORE INTO review_state (word_id, box, due_at, created_at)
             VALUES (?1, 1, date('now', 'localtime', '+1 day'), datetime('now'))",
            params![id],
        )
        .map_err(|e| format!("创建复习记录失败: {e}"))?;
    }
    Ok(())
}

/// How many distinct lookups the history keeps; the oldest are dropped as new ones arrive.
pub const HISTORY_LIMIT: i64 = 500;
const HISTORY_SELECTION_CHARS: usize = 2000;
const HISTORY_CONTEXT_CHARS: usize = 1000;
const HISTORY_LEMMA_CHARS: usize = 120;
const HISTORY_TRANSLATION_CHARS: usize = 300;
/// The list shows a preview of long selections; reopening uses the full text.
const HISTORY_PREVIEW_CHARS: i64 = 400;

/// What one successful lookup leaves in the history.
pub struct HistoryRecord<'a> {
    pub selection: &'a str,
    pub context: &'a str,
    pub kind: &'a str,
    pub lemma: &'a str,
    pub translation: &'a str,
    pub source_app: &'a str,
    pub source_title: &'a str,
}

fn clipped(text: &str, max_chars: usize) -> String {
    text.trim().chars().take(max_chars).collect()
}

/// The same word in another case or with other spacing is one history entry. Sentences and
/// paragraphs ignore spacing only, exactly like the lookup cache does.
fn history_key(selection: &str, kind: &str) -> String {
    format!(
        "{}\u{1f}{kind}",
        crate::normalize_selection(selection, kind)
    )
}

fn history_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Database {
    pub fn open(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("DB open error: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("DB pragma error: {e}"))?;
        Ok(Self {
            conn,
            path: path.to_string(),
        })
    }

    /// In-memory database for tests. Foreign keys are enforced like in the
    /// real database, so cascading deletes are exercised too.
    #[cfg(test)]
    pub(crate) fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("Memory DB error: {e}"))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("Memory DB pragma error: {e}"))?;
        Ok(Self {
            conn,
            path: String::new(),
        })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// Create a transactionally consistent SQLite snapshot. This deliberately
    /// uses SQLite's online backup API so pages that still live in the source
    /// WAL are included.
    pub fn snapshot_to(&self, destination: &Path) -> Result<(), String> {
        snapshot_connection(&self.conn, destination, true)
    }
}

/// Copy a SQLite connection without treating the main database file as a
/// complete source. `validate_schema` is disabled only for pre-migration
/// snapshots, which intentionally preserve the old schema version.
pub(crate) fn snapshot_connection(
    source: &Connection,
    destination: &Path,
    validate_schema: bool,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "无法解析快照目标目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {e}"))?;
    let temp = parent.join(format!(
        ".{}.partial-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("snapshot.db"),
        std::process::id()
    ));
    let _ = fs::remove_file(&temp);
    let result = (|| -> Result<(), String> {
        let mut target = Connection::open(&temp).map_err(|e| format!("创建快照失败: {e}"))?;
        let backup =
            Backup::new(source, &mut target).map_err(|e| format!("初始化 SQLite 快照失败: {e}"))?;
        backup
            .run_to_completion(64, Duration::from_millis(10), None)
            .map_err(|e| format!("执行 SQLite 快照失败: {e}"))?;
        drop(backup);
        validate_integrity(&target)?;
        if validate_schema {
            let schema = crate::migrations::current_version(&target)?;
            if schema != crate::migrations::LATEST_SCHEMA_VERSION {
                return Err(format!("数据库 schema 版本不匹配: {schema}"));
            }
        }
        if validate_schema {
            validate_schema_contract(&target)?;
        }
        drop(target);
        atomic_replace(&temp, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

impl Database {
    fn logical_size_bytes(&self) -> Result<u64, String> {
        let page_count: i64 = self
            .conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let page_size: i64 = self
            .conn
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok((page_count.max(0) as u64).saturating_mul(page_size.max(0) as u64))
    }

    fn validate(&self) -> Result<(), String> {
        validate_connection(&self.conn)
    }

    /// Restore a validated backup into the currently open connection. A backup made by an
    /// earlier schema version is upgraded right after the copy, the way an old database is
    /// when the app starts. A safety snapshot is kept long enough to roll back a failed restore.
    pub fn restore_from_backup(&mut self, backup_name: &str) -> Result<(), String> {
        if !is_safe_backup_name(backup_name) {
            return Err("备份文件名无效".into());
        }
        let db_path = Path::new(&self.path);
        let db_dir = db_path.parent().ok_or("无法解析数据库目录")?;
        let backup_path = db_dir.join("backups").join(backup_name);
        if !backup_path.is_file() {
            return Err(format!("备份文件不存在: {backup_name}"));
        }
        let source = Connection::open(&backup_path).map_err(|e| format!("打开备份失败: {e}"))?;
        validate_restorable(&source)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
        let mut safety_name = format!("{RESTORE_SAFETY_PREFIX}{stamp}.db");
        let mut safety_path = db_dir.join("backups").join(&safety_name);
        let mut suffix = 1_u32;
        while safety_path.exists() {
            safety_name = format!("{RESTORE_SAFETY_PREFIX}{stamp}-{suffix:03}.db");
            safety_path = db_dir.join("backups").join(&safety_name);
            suffix += 1;
        }
        self.snapshot_to(&safety_path)?;
        let restore_result = (|| -> Result<(), String> {
            let backup =
                Backup::new(&source, &mut self.conn).map_err(|e| format!("初始化恢复失败: {e}"))?;
            backup
                .run_to_completion(64, Duration::from_millis(10), None)
                .map_err(|e| format!("执行恢复失败: {e}"))?;
            drop(backup);
            self.initialize()
        })();
        if let Err(error) = restore_result {
            let rollback = (|| -> Result<(), String> {
                let safety = Connection::open(&safety_path)
                    .map_err(|e| format!("打开恢复安全快照失败: {e}"))?;
                let backup = Backup::new(&safety, &mut self.conn)
                    .map_err(|e| format!("初始化恢复回滚失败: {e}"))?;
                backup
                    .run_to_completion(64, Duration::from_millis(10), None)
                    .map_err(|e| format!("执行恢复回滚失败: {e}"))?;
                drop(backup);
                self.validate()
            })();
            return Err(format!("恢复失败，已尝试自动回滚: {error}; {rollback:?}"));
        }
        Ok(())
    }

    pub fn initialize(&self) -> Result<(), String> {
        let existing_database: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='words')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("检查数据库状态失败: {e}"))?;
        // Create only tables that migrations can safely use before touching
        // the current words schema. A database selected from an older schema
        // must be migrated before indexes, FTS and triggers reference it.
        self.conn
            .execute_batch(
                "
            CREATE TABLE IF NOT EXISTS words (
                id TEXT PRIMARY KEY,
                lemma TEXT NOT NULL,
                translation TEXT,
                pos TEXT,
                context_meaning TEXT,
                explanation TEXT,
                source_app TEXT,
                source_title TEXT,
                mastery TEXT DEFAULT 'new',
                kind TEXT DEFAULT 'word',
                saved_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                lookups INTEGER DEFAULT 1,
                data TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS word_tags (
                word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
                tag TEXT NOT NULL,
                PRIMARY KEY (word_id, tag)
            );

            CREATE TABLE IF NOT EXISTS cache (
                cache_key TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                response TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS templates (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_log (
                date TEXT PRIMARY KEY,
                queries INTEGER DEFAULT 0,
                tokens INTEGER DEFAULT 0
            );

            ",
            )
            .map_err(|e| format!("DB init error: {e}"))?;

        if existing_database {
            crate::migrations::migrate(&self.conn, &self.path)?;
        } else {
            crate::migrations::initialize_latest(&self.conn)?;
        }

        self.conn
            .execute_batch(
                "
            CREATE INDEX IF NOT EXISTS idx_words_lemma ON words(lemma);
            CREATE INDEX IF NOT EXISTS idx_words_saved_at ON words(saved_at);
            CREATE INDEX IF NOT EXISTS idx_words_mastery ON words(mastery);
            CREATE INDEX IF NOT EXISTS idx_words_source ON words(source_app);
            CREATE INDEX IF NOT EXISTS idx_word_tags_tag ON word_tags(tag);

            CREATE VIRTUAL TABLE IF NOT EXISTS words_fts USING fts5(
                lemma, translation, context_meaning, explanation,
                content='words', content_rowid='rowid'
            );

            CREATE TRIGGER IF NOT EXISTS words_ai AFTER INSERT ON words BEGIN
                INSERT INTO words_fts(rowid, lemma, translation, context_meaning, explanation)
                VALUES (new.rowid, new.lemma, new.translation, new.context_meaning, new.explanation);
            END;

            CREATE TRIGGER IF NOT EXISTS words_ad AFTER DELETE ON words BEGIN
                INSERT INTO words_fts(words_fts, rowid, lemma, translation, context_meaning, explanation)
                VALUES ('delete', old.rowid, old.lemma, old.translation, old.context_meaning, old.explanation);
            END;

            CREATE TRIGGER IF NOT EXISTS words_au AFTER UPDATE ON words BEGIN
                INSERT INTO words_fts(words_fts, rowid, lemma, translation, context_meaning, explanation)
                VALUES ('delete', old.rowid, old.lemma, old.translation, old.context_meaning, old.explanation);
                INSERT INTO words_fts(rowid, lemma, translation, context_meaning, explanation)
                VALUES (new.rowid, new.lemma, new.translation, new.context_meaning, new.explanation);
            END;
            ",
            )
            .map_err(|e| format!("DB init post-migration error: {e}"))?;

        self.ensure_default_settings()?;
        self.ensure_default_templates()?;
        self.validate()?;
        Ok(())
    }

    fn ensure_default_settings(&self) -> Result<(), String> {
        let defaults = serde_json::json!({
            "provider": {
                "name": "",
                "protocol": "openai",
                "baseUrl": "",
                "apiKey": "",
                "model": "",
                "temperature": 0.3,
                "maxTokens": 1200,
                "timeoutSeconds": 60
            },
            "clipboardWatch": true,
            "clipboardMode": "smart",
            "clipboardBlacklist": [],
            "lookupInIde": true,
            "ideBlacklist": [
                "code.exe",
                "devenv.exe",
                "idea64.exe",
                "cursor.exe",
                "cmd.exe",
                "powershell.exe",
                "pwsh.exe",
                "windowsterminal.exe"
            ],
            "streamingEnabled": true,
            "cacheTtlDays": 30,
            "historyEnabled": true,
            "reviewLimit": 20,
            "includeLongFormReview": false,
            "sessionGapMinutes": 30,
            "enrichDailyTokens": enrich::DEFAULT_DAILY_TOKENS,
            "enrichPace": "normal",
            "activeDomainProfile": "general",
            "analysisStyle": "standard",
            "autoCheckUpdates": true,
            "skippedUpdateVersion": "",
            "theme": "system",
            "cardScale": "default",
            "captureContext": true,
            "launchAtLogin": false,
            "dataDir": self.path.replace("gege.db", ""),
            "autoBackup": true,
            "ttsVoice": "Microsoft Zira",
            "ttsRate": 1.0
        });
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='app'", [], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;

        if count == 0 {
            self.conn
                .execute(
                    "INSERT INTO settings (key, value) VALUES ('app', ?1)",
                    params![defaults.to_string()],
                )
                .map_err(|e| e.to_string())?;
        } else {
            let mut settings = self.get_settings()?;
            if let (Some(current), Some(default_values)) =
                (settings.as_object_mut(), defaults.as_object())
            {
                current.remove("anonymousStats");
                for (key, value) in default_values {
                    current.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
            self.save_settings(&settings)?;
        }
        Ok(())
    }

    fn ensure_default_templates(&self) -> Result<(), String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM templates", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        if count == 0 {
            let word_tpl = serde_json::json!({
                "id": "tpl-word",
                "name": "单词 / 短语解析（默认）",
                "scope": "word",
                "builtIn": true,
                "body": "你是一位精通英汉对比的语言学教师。请解析用户选中的英文内容，输出严格符合以下 JSON Schema 的结果。\n\n选中内容：{{selection}}\n所在上下文：{{context}}\n用户母语：中文\n\n输出 JSON，字段：\n- word: 选中的原文\n- lemma: 词元/原形\n- pos: 词性（中文标注）\n- ipaUS: 美式音标\n- ipaUK: 英式音标\n- translation: 简洁中文翻译\n- contextMeaning: 结合上下文的精确释义（中文，2-3句话）\n- explanation: 详细用法解释，说明语气、语域与使用边界（中文，3-5句话）\n- senses: [{pos, gloss, translation}]  常见义项（2-3个）\n- associations: [{kind: 'root'|'synonym'|'confusable', title, detail}]  词根词缀、近义辨析、易混词各一条\n- examples: [{en, zh}]  3条与上下文领域一致的例句\n- collocations: []  4个常见搭配\n- register: 'formal'|'neutral'|'spoken'|'slang'|'technical'\n\n只输出合法 JSON，不要任何解释性文字。"
            });
            let sentence_tpl = serde_json::json!({
                "id": "tpl-sentence",
                "name": "整句解析（默认）",
                "scope": "sentence",
                "builtIn": true,
                "body": "你是一位英文写作与句法分析教师。请解析用户选中的整句。\n\n选中内容：{{selection}}\n所在上下文：{{context}}\n用户母语：中文\n\n输出 JSON，字段：\n- word: 选中的原句\n- lemma: 原句\n- pos: \"句子\"\n- ipaUS: \"\"\n- ipaUK: \"\"\n- translation: 通顺的中文翻译\n- contextMeaning: 整句在上下文中的含义（中文）\n- explanation: 该句式可复用的写作骨架与注意事项\n- senses: []\n- associations: [{kind: 'synonym', title: '可替换的同义骨架', detail: '...'}, {kind: 'root', title: '关键语法点', detail: '...'}]\n- examples: [{en, zh}]  2条同类句式的例句\n- collocations: []  核心搭配\n- register: 语域\n- syntax: [{part: '成分名', note: '说明'}]  句法拆解\n- keyTerms: [{term, gloss}]  3个以内值得收藏的表达\n\n只输出合法 JSON。"
            });

            self.conn
                .execute(
                    "INSERT INTO templates (id, data) VALUES (?1, ?2)",
                    params!["tpl-word", word_tpl.to_string()],
                )
                .map_err(|e| e.to_string())?;
            self.conn
                .execute(
                    "INSERT INTO templates (id, data) VALUES (?1, ?2)",
                    params!["tpl-sentence", sentence_tpl.to_string()],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_all_words(&self) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT data FROM words ORDER BY saved_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .map_err(|e| e.to_string())?;

        let mut words = Vec::new();
        for row in rows {
            let data_str = row.map_err(|e| e.to_string())?;
            if let Ok(val) = serde_json::from_str::<Value>(&data_str) {
                words.push(val);
            }
        }
        Ok(words)
    }

    pub fn get_words_by_ids(&self, ids: &[String]) -> Result<Vec<Value>, String> {
        if ids.is_empty() {
            return self.get_all_words();
        }
        let placeholders: Vec<String> = ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();
        let sql = format!(
            "SELECT data FROM words WHERE id IN ({}) ORDER BY saved_at DESC",
            placeholders.join(",")
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<&dyn rusqlite::types::ToSql> = ids
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .map_err(|e| e.to_string())?;
        let mut words = Vec::new();
        for row in rows {
            let data_str = row.map_err(|e| e.to_string())?;
            if let Ok(val) = serde_json::from_str::<Value>(&data_str) {
                words.push(val);
            }
        }
        Ok(words)
    }

    pub fn search_words(
        &self,
        query: &str,
        tag: Option<&str>,
        source: Option<&str>,
        mastery: Option<&str>,
    ) -> Result<Vec<Value>, String> {
        let q = query.trim();
        if q.is_empty() && tag.is_none() && source.is_none() && mastery.is_none() {
            return self.get_all_words();
        }

        let mut conditions = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if !q.is_empty() {
            conditions.push(format!(
                "w.rowid IN (SELECT rowid FROM words_fts WHERE words_fts MATCH ?{})",
                idx
            ));
            let fts_query = q
                .split_whitespace()
                .map(|w| format!("\"{}\"", w.replace('"', "")))
                .collect::<Vec<_>>()
                .join(" OR ");
            param_values.push(Box::new(fts_query));
            idx += 1;
        }

        if let Some(t) = tag {
            conditions.push(format!(
                "w.id IN (SELECT word_id FROM word_tags WHERE tag = ?{})",
                idx
            ));
            param_values.push(Box::new(t.to_string()));
            idx += 1;
        }

        if let Some(s) = source {
            conditions.push(format!("w.source_app = ?{}", idx));
            param_values.push(Box::new(s.to_string()));
            idx += 1;
        }

        if let Some(m) = mastery {
            conditions.push(format!("w.mastery = ?{}", idx));
            param_values.push(Box::new(m.to_string()));
            let _ = idx;
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let sql = format!(
            "SELECT w.data FROM words w {} ORDER BY w.saved_at DESC",
            where_clause
        );

        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .map_err(|e| e.to_string())?;

        let mut words = Vec::new();
        for row in rows {
            let data_str = row.map_err(|e| e.to_string())?;
            if let Ok(val) = serde_json::from_str::<Value>(&data_str) {
                words.push(val);
            }
        }
        Ok(words)
    }

    fn include_long_form_review(&self) -> bool {
        self.get_settings()
            .ok()
            .and_then(|settings| {
                settings
                    .get("includeLongFormReview")
                    .and_then(Value::as_bool)
            })
            .unwrap_or(false)
    }

    /// Raw upsert: the stored document becomes exactly `word`. Use
    /// [`Database::save_lookup_result`] for saving a fresh lookup.
    pub fn save_word(&self, word: &Value) -> Result<(), String> {
        save_word_with_connection(&self.conn, word, self.include_long_form_review())
    }

    /// Save the outcome of a dictionary lookup.
    ///
    /// Unlike [`Database::save_word`], which replaces the stored document with
    /// whatever it is handed, this merges: looking a word up again refreshes
    /// its content but never resets what the user owns (mastery, note, tags,
    /// review progress, Anki link, first-saved date). A word is recognised by
    /// its id or, failing that, by normalised lemma and kind, so a second
    /// lookup of "Hello  World" cannot create a duplicate of "hello world".
    /// Returns the document as stored.
    pub fn save_lookup_result(&self, incoming: &Value) -> Result<Value, String> {
        let lemma = str_field(incoming, "lemma").trim();
        if lemma.is_empty() {
            return Err("词条缺少 lemma，无法保存".into());
        }
        let kind = Some(str_field(incoming, "kind"))
            .filter(|kind| !kind.trim().is_empty())
            .unwrap_or("word");
        let include_long_form = self.include_long_form_review();
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let by_id = match str_field(incoming, "id").trim() {
            "" => None,
            id => word_json_by_id(&tx, id)?,
        };
        let existing = match by_id {
            Some(word) => Some(word),
            None => find_word_with_connection(&tx, lemma, Some(kind))?,
        };
        let word = match &existing {
            Some(existing) => merged_lookup_word(existing, incoming),
            None => new_lookup_word(incoming),
        };
        save_word_with_connection(&tx, &word, include_long_form)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(word)
    }

    /// The saved word for a lemma (compared after trimming, collapsing
    /// whitespace and lower-casing), optionally restricted to one kind.
    pub fn find_word_by_lemma(
        &self,
        lemma: &str,
        kind: Option<&str>,
    ) -> Result<Option<Value>, String> {
        find_word_with_connection(&self.conn, lemma, kind)
    }

    /// Words in the order the ids were asked for, skipping unknown and
    /// repeated ids. Unlike [`Database::get_words_by_ids`], an empty request
    /// yields nothing rather than the whole library, and callers can pair the
    /// result with their own list without guessing.
    pub fn get_words_in_order(&self, ids: &[String]) -> Result<Vec<Value>, String> {
        let mut seen = HashSet::new();
        let unique: Vec<&str> = ids
            .iter()
            .map(String::as_str)
            .filter(|id| seen.insert(*id))
            .collect();
        let mut by_id: HashMap<String, Value> = HashMap::with_capacity(unique.len());
        for chunk in unique.chunks(500) {
            let sql = format!(
                "SELECT id, data FROM words WHERE id IN ({})",
                vec!["?"; chunk.len()].join(",")
            );
            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params_from_iter(chunk.iter()), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, data) = row.map_err(|e| e.to_string())?;
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    by_id.insert(id, value);
                }
            }
        }
        Ok(unique
            .into_iter()
            .filter_map(|id| by_id.remove(id))
            .collect())
    }

    /// Record which Anki note each word became. One transaction for the whole
    /// batch; both the JSON document and the indexed column are updated, and
    /// ids that no longer exist are ignored. Returns the number of words
    /// updated.
    pub fn set_anki_note_ids(&self, pairs: &[(String, i64)]) -> Result<u32, String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut updated = 0_u32;
        for (id, note_id) in pairs {
            let Some(mut word) = word_json_by_id(&tx, id)? else {
                continue;
            };
            if let Some(object) = word.as_object_mut() {
                object.insert("ankiNoteId".into(), Value::from(*note_id));
            }
            tx.execute(
                "UPDATE words SET data = ?2, anki_note_id = ?3 WHERE id = ?1",
                params![id, word.to_string(), note_id.to_string()],
            )
            .map_err(|e| e.to_string())?;
            updated += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated)
    }

    /// Apply one change to many words in a single transaction: either every
    /// existing word is updated or none is. Unknown ids are counted, not fatal.
    pub fn batch_update_words(
        &self,
        ids: &[String],
        patch: &BatchWordPatch,
    ) -> Result<BatchUpdateReport, String> {
        let patch = patch.validated()?;
        let touches_tags = !patch.add_tags.is_empty() || !patch.remove_tags.is_empty();
        let include_long_form = self.include_long_form_review();
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut seen = HashSet::new();
        let mut report = BatchUpdateReport {
            updated: 0,
            missing: 0,
        };
        for id in ids.iter().filter(|id| seen.insert(id.as_str())) {
            let Some(mut word) = word_json_by_id(&tx, id)? else {
                report.missing += 1;
                continue;
            };
            let mut tags = tags_of(&word);
            tags.retain(|tag| !patch.remove_tags.contains(tag));
            for tag in &patch.add_tags {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            let object = word
                .as_object_mut()
                .ok_or_else(|| format!("词条数据损坏 ({id})"))?;
            if let Some(level) = patch.mastery {
                object.insert("mastery".into(), Value::String(level.to_string()));
            }
            if touches_tags {
                object.insert("tags".into(), tags_value(tags));
            }
            save_word_with_connection(&tx, &word, include_long_form)?;
            report.updated += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(report)
    }

    pub fn import_words(
        &self,
        content: &str,
        format: &str,
        mapping: &std::collections::HashMap<String, String>,
    ) -> Result<crate::word_import::WordImportResult, String> {
        let (rows, mut errors) = crate::word_import::parse_import_rows(content, format, mapping)?;
        let include_long_form = self.include_long_form_review();
        let mut known = self.get_all_words()?;
        // Normalised lemma -> position in `known`. The first occurrence wins,
        // exactly as a linear scan would have found it. The scan itself made
        // big imports quadratic: 3000 rows into 3000 words took about 10 s.
        let mut index_by_lemma: HashMap<String, usize> = HashMap::with_capacity(known.len());
        for (position, word) in known.iter().enumerate() {
            if let Some(lemma) = word.get("lemma").and_then(Value::as_str) {
                index_by_lemma
                    .entry(normalize_import_lemma(lemma))
                    .or_insert(position);
            }
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut inserted = 0_u32;
        let mut merged = 0_u32;
        let mut skipped = errors.len() as u32;
        for row in rows {
            let imported_lemma = row.fields.get("lemma").cloned().unwrap_or_default();
            let key = normalize_import_lemma(&imported_lemma);
            let existing_index = index_by_lemma.get(&key).copied();
            let word = if let Some(index) = existing_index {
                let mut current = known[index].clone();
                let object = current.as_object_mut().ok_or("已有词条格式无效")?;
                for (field, value) in &row.fields {
                    if field == "lemma" || value.is_empty() {
                        continue;
                    }
                    let empty = object
                        .get(field)
                        .and_then(Value::as_str)
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true);
                    if empty {
                        object.insert(field.clone(), Value::String(value.clone()));
                    }
                }
                let mut tags = object
                    .get("tags")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for tag in &row.tags {
                    if !tags.iter().any(|current| current.as_str() == Some(tag)) {
                        tags.push(Value::String(tag.clone()));
                    }
                }
                object.insert("tags".into(), Value::Array(tags));
                merged += 1;
                current
            } else {
                let now = chrono::Utc::now().to_rfc3339();
                let mut object = serde_json::Map::new();
                object.insert("id".into(), Value::String(uuid::Uuid::new_v4().to_string()));
                object.insert("selection".into(), Value::String(imported_lemma.clone()));
                object.insert("lemma".into(), Value::String(imported_lemma));
                object.insert("pos".into(), Value::String(String::new()));
                object.insert("translation".into(), Value::String(String::new()));
                object.insert("contextMeaning".into(), Value::String(String::new()));
                object.insert("explanation".into(), Value::String(String::new()));
                object.insert("senses".into(), Value::Array(Vec::new()));
                object.insert("associations".into(), Value::Array(Vec::new()));
                object.insert("examples".into(), Value::Array(Vec::new()));
                object.insert("collocations".into(), Value::Array(Vec::new()));
                object.insert("kind".into(), Value::String("word".into()));
                object.insert("register".into(), Value::String("neutral".into()));
                object.insert("savedAt".into(), Value::String(now.clone()));
                object.insert("updatedAt".into(), Value::String(now));
                object.insert("context".into(), Value::String(String::new()));
                object.insert("sourceApp".into(), Value::String(String::new()));
                object.insert("sourceTitle".into(), Value::String(String::new()));
                object.insert("mastery".into(), Value::String("new".into()));
                object.insert("lookups".into(), Value::Number(1.into()));
                object.insert("note".into(), Value::String(String::new()));
                object.insert(
                    "tags".into(),
                    Value::Array(row.tags.iter().cloned().map(Value::String).collect()),
                );
                for (field, value) in &row.fields {
                    if field != "lemma" && !value.is_empty() {
                        object.insert(field.clone(), Value::String(value.clone()));
                    }
                }
                inserted += 1;
                Value::Object(object)
            };
            if word
                .get("lemma")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                errors.push(crate::word_import::ImportRowError {
                    row: row.row,
                    message: "lemma 不能为空".into(),
                });
                skipped += 1;
                continue;
            }
            save_word_with_connection(&tx, &word, include_long_form)?;
            if let Some(index) = existing_index {
                known[index] = word;
            } else {
                index_by_lemma.insert(key, known.len());
                known.push(word);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(crate::word_import::WordImportResult {
            inserted,
            merged,
            skipped,
            errors,
        })
    }

    /// The words that have nothing but a form and a meaning (see [`enrich::is_bare`]), oldest
    /// first, as their ids and lemmas. With `only`, just those of the given ids.
    pub fn bare_words(&self, only: Option<&[String]>) -> Result<Vec<enrich::Candidate>, String> {
        let wanted: Option<HashSet<&str>> =
            only.map(|ids| ids.iter().map(String::as_str).collect());
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT id, lemma FROM words WHERE {BARE_WORDS_SQL} ORDER BY saved_at ASC, id ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(enrich::Candidate {
                    id: row.get(0)?,
                    lemma: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut words = Vec::new();
        for row in rows {
            let candidate = row.map_err(|e| e.to_string())?;
            if wanted
                .as_ref()
                .is_none_or(|wanted| wanted.contains(candidate.id.as_str()))
            {
                words.push(candidate);
            }
        }
        Ok(words)
    }

    /// How many words [`Database::bare_words`] would give.
    pub fn count_bare_words(&self) -> Result<usize, String> {
        let count: i64 = self
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM words WHERE {BARE_WORDS_SQL}"),
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count.max(0) as usize)
    }

    /// Put what a model answered into the word where the word has nothing yet (see
    /// [`enrich::fill_gaps`]). The word is read and written in one transaction, so a note the
    /// user types meanwhile is not lost, and a word that was deleted or filled in elsewhere since
    /// the batch looked at it is left alone. An answer with nothing to add is an error rather
    /// than a word that is "done" and still bare, which the next run would ask for again.
    pub fn fill_in_word(&self, id: &str, answer: &Value) -> Result<enrich::Filled, String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let Some(word) = word_json_by_id(&tx, id)? else {
            return Ok(enrich::Filled::Gone);
        };
        if !enrich::is_bare(&word) {
            return Ok(enrich::Filled::NotBare);
        }
        let filled = enrich::fill_gaps(&word, answer);
        if enrich::is_bare(&filled) {
            return Err(crate::llm::coded(
                "empty",
                "模型没有给出义项或例句，词条保持原样",
            ));
        }
        save_word_with_connection(&tx, &filled, self.include_long_form_review())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(enrich::Filled::Done(Box::new(filled)))
    }

    pub fn get_review_queue(&self, limit: Option<u32>) -> Result<Vec<Value>, String> {
        let requested = limit.unwrap_or_else(|| {
            self.get_settings()
                .ok()
                .and_then(|settings| settings.get("reviewLimit").and_then(|v| v.as_u64()))
                .unwrap_or(20) as u32
        });
        let sql = if requested == 0 {
            "SELECT w.data, r.word_id, r.box, r.due_at, r.last_result,
                    r.correct_count, r.wrong_count, r.reviewed_at, r.hard_count
             FROM review_state r JOIN words w ON w.id = r.word_id
             WHERE date(r.due_at) <= date('now', 'localtime')
             ORDER BY date(r.due_at) ASC, r.box ASC, datetime(w.saved_at) ASC"
                .to_string()
        } else {
            format!(
                "SELECT w.data, r.word_id, r.box, r.due_at, r.last_result,
                        r.correct_count, r.wrong_count, r.reviewed_at, r.hard_count
                 FROM review_state r JOIN words w ON w.id = r.word_id
                 WHERE date(r.due_at) <= date('now', 'localtime')
                 ORDER BY date(r.due_at) ASC, r.box ASC, datetime(w.saved_at) ASC LIMIT {}",
                requested
            )
        };
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    serde_json::json!({
                        "wordId": row.get::<_, String>(1)?,
                        "box": row.get::<_, i64>(2)?,
                        "dueAt": row.get::<_, String>(3)?,
                        "lastResult": row.get::<_, Option<String>>(4)?,
                        "correctCount": row.get::<_, i64>(5)?,
                        "wrongCount": row.get::<_, i64>(6)?,
                        "reviewedAt": row.get::<_, Option<String>>(7)?,
                        "hardCount": row.get::<_, i64>(8)?,
                    }),
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut queue = Vec::new();
        for row in rows {
            let (raw, state) = row.map_err(|e| e.to_string())?;
            let mut word: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if let Some(object) = word.as_object_mut() {
                object.insert("reviewState".into(), state);
            }
            queue.push(word);
        }
        Ok(queue)
    }

    pub fn submit_review(&self, word_id: &str, answer: Answer) -> Result<Value, String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let (current_box, correct_count, hard_count, wrong_count): (i64, i64, i64, i64) = tx
            .query_row(
                "SELECT box, correct_count, hard_count, wrong_count FROM review_state WHERE word_id=?1",
                params![word_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|e| match e {
                // A card goes with its word (the row is deleted along with it), so a missing
                // one means the word is gone. The review screen tells that apart from a
                // failure to save, and moves on instead of asking for the answer again.
                rusqlite::Error::QueryReturnedNoRows => "生词已被删除，这张卡片无需再复习".to_string(),
                other => format!("读取复习记录失败: {other}"),
            })?;
        let Step {
            next_box,
            days,
            mastery,
        } = review::schedule(current_box, answer);
        let result = answer.as_str();
        let (correct_count, hard_count, wrong_count) = (
            correct_count + i64::from(answer == Answer::Correct),
            hard_count + i64::from(answer == Answer::Hard),
            wrong_count + i64::from(answer == Answer::Wrong),
        );
        tx.execute(
            "UPDATE review_state SET box=?2, due_at=date('now','localtime',?3),
                    last_result=?4, correct_count=?5, hard_count=?6, wrong_count=?7,
                    reviewed_at=datetime('now','localtime') WHERE word_id=?1",
            params![
                word_id,
                next_box,
                format!("+{days} days"),
                result,
                correct_count,
                hard_count,
                wrong_count
            ],
        )
        .map_err(|e| e.to_string())?;
        let raw: String = tx
            .query_row(
                "SELECT data FROM words WHERE id=?1",
                params![word_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("生词已被删除: {e}"))?;
        let mut word: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if let Some(object) = word.as_object_mut() {
            object.insert("mastery".into(), Value::String(mastery.into()));
        }
        tx.execute(
            "UPDATE words SET mastery=?2, data=?3, updated_at=datetime('now') WHERE id=?1",
            params![word_id, mastery, word.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "wordId": word_id,
            "box": next_box,
            "dueAt": chrono::Local::now()
                .date_naive()
                .checked_add_days(chrono::Days::new(days as u64))
                .map(|date| date.format("%Y-%m-%d").to_string()),
            "lastResult": result,
            "correctCount": correct_count,
            "hardCount": hard_count,
            "wrongCount": wrong_count,
            "previousBox": current_box,
        }))
    }

    pub fn get_review_stats(&self) -> Result<Value, String> {
        let due: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM review_state WHERE date(due_at) <= date('now','localtime')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut boxes = [0_i64; 3];
        let mut stmt = self
            .conn
            .prepare("SELECT box, COUNT(*) FROM review_state GROUP BY box")
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([], |row| {
                Ok((row.get::<_, usize>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?
        {
            let (box_no, count) = row.map_err(|e| e.to_string())?;
            if (1..=3).contains(&box_no) {
                boxes[box_no - 1] = count;
            }
        }
        let next_due: Option<String> = self.conn.query_row(
            "SELECT MIN(date(due_at)) FROM review_state WHERE date(due_at) > date('now','localtime')",
            [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "dueCount": due,
            "boxCounts": boxes,
            "nextDueAt": next_due,
            "total": boxes.iter().sum::<i64>(),
        }))
    }

    pub fn reset_review_state(&self, word_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO review_state (word_id, box, due_at, created_at)
             VALUES (?1,1,date('now','localtime','+1 day'),datetime('now'))
             ON CONFLICT(word_id) DO UPDATE SET box=1,due_at=excluded.due_at,last_result=NULL,
               correct_count=0,hard_count=0,wrong_count=0,reviewed_at=NULL",
                params![word_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_words_to_review(&self, ids: &[String]) -> Result<u32, String> {
        let mut count = 0;
        for id in ids {
            count += self
                .conn
                .execute(
                    "INSERT OR IGNORE INTO review_state (word_id,box,due_at,created_at)
                 SELECT id,1,date('now','localtime'),datetime('now') FROM words WHERE id=?1",
                    params![id],
                )
                .map_err(|e| e.to_string())? as u32;
        }
        Ok(count)
    }

    fn reading_sessions(&self, gap_minutes: u32) -> Result<Vec<Value>, String> {
        let gap_seconds = i64::from(gap_minutes.clamp(1, 24 * 60)) * 60;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, source_app, source_title, saved_at, data
             FROM words ORDER BY datetime(saved_at) ASC, rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut sessions: Vec<Value> = Vec::new();
        let mut current_ids: Vec<String> = Vec::new();
        let mut current_preview: Vec<String> = Vec::new();
        let mut current_source = String::new();
        let mut current_title = String::new();
        let mut current_start = String::new();
        let mut current_end = String::new();
        let mut previous_ts: Option<i64> = None;

        let flush = |sessions: &mut Vec<Value>,
                     ids: &mut Vec<String>,
                     preview: &mut Vec<String>,
                     source: &str,
                     title: &str,
                     start: &str,
                     end: &str| {
            if ids.is_empty() {
                return;
            }
            sessions.push(serde_json::json!({
                "id": format!("session:{}", ids[0]),
                "sourceApp": source,
                "sourceTitle": title,
                "startAt": start,
                "endAt": end,
                "wordCount": ids.len(),
                "preview": preview,
                "wordIds": ids,
            }));
            ids.clear();
            preview.clear();
        };

        for row in rows {
            let (id, source, title, saved_at, raw) = row.map_err(|e| e.to_string())?;
            let timestamp = chrono::DateTime::parse_from_rfc3339(&saved_at)
                .map(|dt| dt.timestamp())
                .or_else(|_| {
                    chrono::NaiveDateTime::parse_from_str(&saved_at, "%Y-%m-%d %H:%M:%S")
                        .map(|dt| dt.and_utc().timestamp())
                })
                .unwrap_or(0);
            let split = !current_ids.is_empty()
                && (source != current_source
                    || previous_ts.is_some_and(|previous| timestamp - previous >= gap_seconds));
            if split {
                flush(
                    &mut sessions,
                    &mut current_ids,
                    &mut current_preview,
                    &current_source,
                    &current_title,
                    &current_start,
                    &current_end,
                );
            }
            if current_ids.is_empty() {
                current_source = source.clone();
                current_title = title.clone();
                current_start = saved_at.clone();
            }
            current_end = saved_at;
            current_ids.push(id);
            if current_preview.len() < 5 {
                let word: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
                current_preview.push(
                    word.get("lemma")
                        .and_then(|v| v.as_str())
                        .unwrap_or("—")
                        .to_string(),
                );
            }
            previous_ts = Some(timestamp);
        }
        flush(
            &mut sessions,
            &mut current_ids,
            &mut current_preview,
            &current_source,
            &current_title,
            &current_start,
            &current_end,
        );
        sessions.reverse();
        Ok(sessions)
    }

    pub fn get_reading_sessions(
        &self,
        gap_minutes: u32,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Value>, String> {
        let sessions = self.reading_sessions(gap_minutes)?;
        Ok(sessions
            .into_iter()
            .skip(offset as usize)
            .take(limit.clamp(1, 200) as usize)
            .collect())
    }

    fn session_word_ids(&self, session_id: &str) -> Result<Vec<String>, String> {
        let gap = self
            .get_settings()?
            .get("sessionGapMinutes")
            .and_then(|value| value.as_u64())
            .unwrap_or(30) as u32;
        self.reading_sessions(gap)?
            .into_iter()
            .find(|session| session.get("id").and_then(|v| v.as_str()) == Some(session_id))
            .and_then(|session| session.get("wordIds").and_then(|v| v.as_array()).cloned())
            .map(|ids| {
                ids.into_iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect()
            })
            .ok_or_else(|| "阅读会话不存在或已因设置变更重新分组".to_string())
    }

    pub fn get_session_words(&self, session_id: &str) -> Result<Vec<Value>, String> {
        let ids = self.session_word_ids(session_id)?;
        self.get_words_by_ids(&ids)
    }

    pub fn tag_session(&self, session_id: &str, tags: &[String]) -> Result<u32, String> {
        let add_tags = clean_tag_list(tags)?;
        if add_tags.is_empty() {
            return Ok(0);
        }
        let ids = self.session_word_ids(session_id)?;
        let patch = BatchWordPatch {
            add_tags,
            ..BatchWordPatch::default()
        };
        Ok(self.batch_update_words(&ids, &patch)?.updated)
    }

    pub fn add_session_to_review(&self, session_id: &str) -> Result<u32, String> {
        let ids = self.session_word_ids(session_id)?;
        self.add_words_to_review(&ids)
    }

    pub fn update_word(&self, id: &str, patch: &Value) -> Result<(), String> {
        let existing: String = self
            .conn
            .query_row("SELECT data FROM words WHERE id = ?1", params![id], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Word not found: {e}"))?;

        let mut word: Value = serde_json::from_str(&existing).map_err(|e| e.to_string())?;
        if let (Some(obj), Some(patch_obj)) = (word.as_object_mut(), patch.as_object()) {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }

        self.save_word(&word)
    }

    /// Delete words (and, through the foreign keys, their tags and review
    /// state) in one transaction, so a failure cannot leave a half-deleted
    /// selection and a large selection costs one commit instead of one each.
    pub fn delete_words(&self, ids: &[String]) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for id in ids {
            tx.execute("DELETE FROM words WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn get_all_tags(&self) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT tag FROM word_tags ORDER BY tag")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|e| e.to_string())?);
        }
        Ok(tags)
    }

    pub fn get_settings(&self) -> Result<Value, String> {
        match self
            .conn
            .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
                row.get::<_, String>(0)
            }) {
            Ok(data) => serde_json::from_str(&data).map_err(|e| e.to_string()),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(serde_json::json!({})),
            Err(e) => Err(format!("Settings error: {e}")),
        }
    }

    pub fn save_settings(&self, settings: &Value) -> Result<(), String> {
        let mut sanitized = settings.clone();
        if let Some(root) = sanitized.as_object_mut() {
            root.remove("anonymousStats");
        }
        self.conn
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?1)",
                params![sanitized.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_templates(&self) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT data FROM templates ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .map_err(|e| e.to_string())?;
        let mut templates = Vec::new();
        for row in rows {
            let data_str = row.map_err(|e| e.to_string())?;
            if let Ok(val) = serde_json::from_str::<Value>(&data_str) {
                templates.push(val);
            }
        }
        Ok(templates)
    }

    pub fn save_template(&self, template: &Value) -> Result<(), String> {
        let id = template.get("id").and_then(|v| v.as_str()).unwrap_or("");
        self.conn
            .execute(
                "INSERT OR REPLACE INTO templates (id, data) VALUES (?1, ?2)",
                params![id, template.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_glossary_terms(
        &self,
        query: Option<&str>,
        domain: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Value, String> {
        if let Some(value) = domain.filter(|value| !value.is_empty()) {
            if !glossary::DOMAINS.contains(&value) {
                return Err(format!("未知领域：{value}"));
            }
        }
        let mut conditions = Vec::new();
        let mut values = Vec::new();
        if let Some(value) = query.map(str::trim).filter(|value| !value.is_empty()) {
            conditions.push("(term LIKE ? ESCAPE '\\' OR translation LIKE ? ESCAPE '\\')");
            let pattern = format!("%{}%", escape_like(value));
            values.push(pattern.clone());
            values.push(pattern);
        }
        if let Some(value) = domain.filter(|value| !value.is_empty()) {
            conditions.push("domain = ?");
            values.push(value.to_string());
        }
        let where_sql = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };
        let count_sql = format!("SELECT COUNT(*) FROM glossary_terms{where_sql}");
        let total: i64 = self
            .conn
            .query_row(&count_sql, params_from_iter(values.iter()), |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;
        let limit = limit.clamp(1, 200);
        let sql = format!(
            "SELECT id,term,translation,domain,note,case_sensitive,enabled,created_at,updated_at \
             FROM glossary_terms{where_sql} ORDER BY domain, term_key LIMIT {limit} OFFSET {offset}"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), glossary_term_from_row)
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        Ok(serde_json::json!({ "items": items, "total": total }))
    }

    pub fn save_glossary_term(&self, input: &Value) -> Result<Value, String> {
        let mut term: GlossaryTerm =
            serde_json::from_value(input.clone()).map_err(|e| format!("术语格式无效：{e}"))?;
        term.term = term.term.split_whitespace().collect::<Vec<_>>().join(" ");
        term.translation = term.translation.trim().to_string();
        term.note = term.note.trim().to_string();
        glossary::validate_term(&term)?;
        let term_key = glossary::normalize_term(&term.term);
        let now = chrono::Utc::now().to_rfc3339();
        let id_exists = if term.id.is_empty() {
            false
        } else {
            self.conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM glossary_terms WHERE id=?1)",
                    params![term.id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?
        };
        if id_exists {
            self.conn
                .execute(
                    "UPDATE glossary_terms SET term=?2,term_key=?3,translation=?4,domain=?5,note=?6,case_sensitive=?7,enabled=?8,updated_at=?9 WHERE id=?1",
                    params![term.id, term.term, term_key, term.translation, term.domain, term.note, term.case_sensitive as i64, term.enabled as i64, now],
                )
                .map_err(|e| {
                    if e.to_string().contains("UNIQUE constraint failed") {
                        "该领域已存在同名术语".to_string()
                    } else {
                        e.to_string()
                    }
                })?;
        } else {
            let id = if term.id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                term.id.clone()
            };
            self.conn
                .execute(
                    "INSERT INTO glossary_terms (id,term,term_key,translation,domain,note,case_sensitive,enabled,created_at,updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
                     ON CONFLICT(term_key,domain) DO UPDATE SET term=excluded.term,translation=excluded.translation,note=excluded.note,case_sensitive=excluded.case_sensitive,enabled=excluded.enabled,updated_at=excluded.updated_at",
                    params![id, term.term, term_key, term.translation, term.domain, term.note, term.case_sensitive as i64, term.enabled as i64, now],
                )
                .map_err(|e| e.to_string())?;
        }
        self.conn
            .query_row(
                "SELECT id,term,translation,domain,note,case_sensitive,enabled,created_at,updated_at FROM glossary_terms WHERE term_key=?1 AND domain=?2",
                params![term_key, term.domain],
                glossary_term_from_row,
            )
            .map(|saved| serde_json::to_value(saved).unwrap_or(Value::Null))
            .map_err(|e| e.to_string())
    }

    pub fn delete_glossary_terms(&self, ids: &[String]) -> Result<u32, String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut deleted = 0;
        for id in ids {
            deleted += tx
                .execute("DELETE FROM glossary_terms WHERE id=?1", params![id])
                .map_err(|e| e.to_string())? as u32;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(deleted)
    }

    fn all_glossary_terms_for_domains(&self, domain: &str) -> Result<Vec<GlossaryTerm>, String> {
        let domain = if glossary::DOMAINS.contains(&domain) {
            domain
        } else {
            "general"
        };
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,term,translation,domain,note,case_sensitive,enabled,created_at,updated_at
                 FROM glossary_terms WHERE enabled=1 AND (domain='general' OR domain=?1)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![domain], glossary_term_from_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn find_glossary_matches(
        &self,
        selection: &str,
        context: &str,
        domain: &str,
    ) -> Result<Vec<GlossaryTerm>, String> {
        let terms = self.all_glossary_terms_for_domains(domain)?;
        Ok(glossary::match_terms(&terms, selection, context, domain))
    }

    pub fn import_glossary(
        &self,
        content: &str,
        format: &str,
        conflict_policy: &str,
    ) -> Result<Value, String> {
        if !matches!(conflict_policy, "overwrite" | "skip") {
            return Err("冲突策略必须为 overwrite 或 skip".into());
        }
        let mut raw_terms = Vec::<Result<GlossaryTerm, String>>::new();
        match format {
            "json" => {
                let values: Vec<Value> =
                    serde_json::from_str(content).map_err(|e| format!("JSON 格式错误：{e}"))?;
                if values.len() > 10_000 {
                    return Err("单次最多导入 10000 条术语".into());
                }
                raw_terms.extend(values.into_iter().map(|value| {
                    serde_json::from_value(value).map_err(|e| format!("字段格式错误：{e}"))
                }));
            }
            "tsv" => {
                let mut lines = content.lines();
                let header = lines.next().unwrap_or("").trim_start_matches('\u{feff}');
                if header != "term\ttranslation\tdomain\tnote\tcase_sensitive\tenabled" {
                    return Err("TSV 表头不符合术语表格式".into());
                }
                for (index, line) in lines.enumerate() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if raw_terms.len() >= 10_000 {
                        return Err("单次最多导入 10000 条术语".into());
                    }
                    let fields = line.split('\t').collect::<Vec<_>>();
                    if fields.len() != 6 {
                        raw_terms.push(Err(format!("第 {} 行列数不是 6", index + 2)));
                        continue;
                    }
                    let parse_bool = |value: &str| match value.trim().to_ascii_lowercase().as_str()
                    {
                        "true" | "1" | "yes" => Ok(true),
                        "false" | "0" | "no" => Ok(false),
                        _ => Err(format!("第 {} 行布尔值无效", index + 2)),
                    };
                    raw_terms.push((|| {
                        Ok(GlossaryTerm {
                            id: String::new(),
                            term: unescape_tsv(fields[0]),
                            translation: unescape_tsv(fields[1]),
                            domain: unescape_tsv(fields[2]),
                            note: unescape_tsv(fields[3]),
                            case_sensitive: parse_bool(fields[4])?,
                            enabled: parse_bool(fields[5])?,
                            created_at: String::new(),
                            updated_at: String::new(),
                        })
                    })());
                }
            }
            _ => return Err("仅支持 json 或 tsv 格式".into()),
        }

        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut inserted = 0_u32;
        let mut updated = 0_u32;
        let mut skipped = 0_u32;
        let mut errors = Vec::new();
        for (index, item) in raw_terms.into_iter().enumerate() {
            let mut term = match item {
                Ok(term) => term,
                Err(error) => {
                    errors.push(error);
                    continue;
                }
            };
            term.term = term.term.split_whitespace().collect::<Vec<_>>().join(" ");
            term.translation = term.translation.trim().to_string();
            term.note = term.note.trim().to_string();
            if let Err(error) = glossary::validate_term(&term) {
                errors.push(format!("第 {} 条：{error}", index + 1));
                continue;
            }
            let term_key = glossary::normalize_term(&term.term);
            let existing: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM glossary_terms WHERE term_key=?1 AND domain=?2)",
                    params![term_key, term.domain],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if existing && conflict_policy == "skip" {
                skipped += 1;
                continue;
            }
            if existing {
                tx.execute(
                    "UPDATE glossary_terms SET term=?3,translation=?4,note=?5,case_sensitive=?6,enabled=?7,updated_at=?8 WHERE term_key=?1 AND domain=?2",
                    params![term_key, term.domain, term.term, term.translation, term.note, term.case_sensitive as i64, term.enabled as i64, now],
                ).map_err(|e| e.to_string())?;
                updated += 1;
            } else {
                tx.execute(
                    "INSERT INTO glossary_terms (id,term,term_key,translation,domain,note,case_sensitive,enabled,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
                    params![uuid::Uuid::new_v4().to_string(), term.term, term_key, term.translation, term.domain, term.note, term.case_sensitive as i64, term.enabled as i64, now],
                ).map_err(|e| e.to_string())?;
                inserted += 1;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "errorCount": errors.len(),
            "errors": errors.into_iter().take(100).collect::<Vec<_>>(),
        }))
    }

    pub fn export_glossary(&self, format: &str, domain: Option<&str>) -> Result<String, String> {
        if let Some(value) = domain.filter(|value| !value.is_empty()) {
            if !glossary::DOMAINS.contains(&value) {
                return Err(format!("未知领域：{value}"));
            }
        }
        let mut sql = "SELECT id,term,translation,domain,note,case_sensitive,enabled,created_at,updated_at FROM glossary_terms".to_string();
        if domain.is_some_and(|value| !value.is_empty()) {
            sql.push_str(" WHERE domain=?1");
        }
        sql.push_str(" ORDER BY domain,term_key");
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let terms = if let Some(value) = domain.filter(|value| !value.is_empty()) {
            stmt.query_map(params![value], glossary_term_from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        } else {
            stmt.query_map([], glossary_term_from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        match format {
            "json" => serde_json::to_string_pretty(&terms).map_err(|e| e.to_string()),
            "tsv" => {
                let mut lines =
                    vec!["term\ttranslation\tdomain\tnote\tcase_sensitive\tenabled".to_string()];
                for term in terms {
                    lines.push(format!(
                        "{}\t{}\t{}\t{}\t{}\t{}",
                        escape_tsv(&term.term),
                        escape_tsv(&term.translation),
                        term.domain,
                        escape_tsv(&term.note),
                        term.case_sensitive,
                        term.enabled,
                    ));
                }
                Ok(lines.join("\n"))
            }
            _ => Err("仅支持 json 或 tsv 格式".into()),
        }
    }

    pub fn get_usage(&self) -> Result<Value, String> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let month_prefix = &today[..7];

        let today_stats: (i64, i64) = self
            .conn
            .query_row(
                "SELECT COALESCE(queries, 0), COALESCE(tokens, 0) FROM usage_log WHERE date = ?1",
                params![today],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));

        let month_stats: (i64, i64) = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(queries), 0), COALESCE(SUM(tokens), 0) FROM usage_log WHERE date LIKE ?1",
                params![format!("{}%", month_prefix)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));

        Ok(serde_json::json!({
            "today": today_stats.0,
            "month": month_stats.0,
            "tokens": month_stats.1
        }))
    }

    /// Count one lookup that returned a result towards today's usage. A lookup answered from the
    /// cache passes 0 tokens: it is still a lookup the user made, but it cost nothing.
    pub fn record_lookup(&self, tokens: u32) -> Result<(), String> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        self.conn
            .execute(
                "INSERT INTO usage_log (date, queries, tokens) VALUES (?1, 1, ?2)
                 ON CONFLICT(date) DO UPDATE SET queries = queries + 1, tokens = tokens + ?2",
                params![today, tokens as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Count tokens that were spent today without a lookup of the user's behind them: what the
    /// batch enrichment asks of the model. Today's lookups stay as they were.
    pub fn record_tokens(&self, tokens: u32) -> Result<(), String> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        self.conn
            .execute(
                "INSERT INTO usage_log (date, queries, tokens) VALUES (?1, 0, ?2)
                 ON CONFLICT(date) DO UPDATE SET tokens = tokens + ?2",
                params![today, tokens as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Estimated tokens spent today, by lookups and by the batch together.
    pub fn tokens_today(&self) -> Result<u64, String> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let tokens: Option<i64> = self
            .conn
            .query_row(
                "SELECT tokens FROM usage_log WHERE date = ?1",
                params![today],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(tokens.unwrap_or(0).max(0) as u64)
    }

    pub fn record_local_event(&self, event: &str, extra: &Value) -> Result<(), String> {
        if event.trim().is_empty() {
            return Err("事件名不能为空".into());
        }
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let extra_str = match extra {
            Value::Object(map) if map.is_empty() => "{}".to_string(),
            Value::Null => "{}".to_string(),
            other => {
                let obj = other.as_object().cloned().unwrap_or_default();
                // Only keep compact scalar extras; never store free-form prose.
                let mut filtered = serde_json::Map::new();
                for (key, value) in obj {
                    match value {
                        Value::String(s) if s.len() <= 32 => {
                            filtered.insert(key, Value::String(s));
                        }
                        Value::Number(_) | Value::Bool(_) => {
                            filtered.insert(key, value);
                        }
                        _ => {}
                    }
                }
                serde_json::Value::Object(filtered).to_string()
            }
        };
        self.conn
            .execute(
                "INSERT INTO local_events (date, event, count, extra) VALUES (?1, ?2, 1, ?3)
                 ON CONFLICT(date, event, extra) DO UPDATE SET count = count + 1",
                params![today, event, extra_str],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_local_metrics(&self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM local_events", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn cleanup_local_events(&self, retention_days: i64) -> Result<u64, String> {
        let retention_days = retention_days.clamp(7, 365);
        let cutoff = chrono::Local::now()
            .date_naive()
            .checked_sub_signed(chrono::Duration::days(retention_days - 1))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let n = self
            .conn
            .execute("DELETE FROM local_events WHERE date < ?1", params![cutoff])
            .map_err(|e| e.to_string())?;
        Ok(n as u64)
    }

    pub fn get_local_metrics(&self, days: u32) -> Result<Value, String> {
        let days = days.clamp(1, 90) as i64;
        let cutoff = chrono::Local::now()
            .date_naive()
            .checked_sub_signed(chrono::Duration::days(days - 1))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let event_sum = |event: &str| -> Result<i64, String> {
            self.conn
                .query_row(
                    "SELECT COALESCE(SUM(count), 0) FROM local_events WHERE date >= ?1 AND event = ?2",
                    params![cutoff, event],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())
        };

        let today_event = |event: &str| -> Result<i64, String> {
            self.conn
                .query_row(
                    "SELECT COALESCE(SUM(count), 0) FROM local_events WHERE date = ?1 AND event = ?2",
                    params![today, event],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())
        };

        let filtered_by_reason = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT extra, COALESCE(SUM(count),0) FROM local_events
                     WHERE date >= ?1 AND event = 'clipboard_filtered'
                     GROUP BY extra ORDER BY 2 DESC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![cutoff], |row| {
                    let extra: String = row.get(0)?;
                    let count: i64 = row.get(1)?;
                    Ok((extra, count))
                })
                .map_err(|e| e.to_string())?;
            let mut map = serde_json::Map::new();
            for row in rows {
                let (extra, count) = row.map_err(|e| e.to_string())?;
                let reason = serde_json::from_str::<Value>(&extra)
                    .ok()
                    .and_then(|v| {
                        v.get("reason")
                            .and_then(|r| r.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| "unknown".into());
                map.insert(reason, Value::Number(count.into()));
            }
            Value::Object(map)
        };

        let stream_first = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT extra, COALESCE(SUM(count),0) FROM local_events
                     WHERE date >= ?1 AND event = 'lookup_stream_first_field'
                     GROUP BY extra",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![cutoff], |row| {
                    let extra: String = row.get(0)?;
                    let count: i64 = row.get(1)?;
                    Ok((extra, count))
                })
                .map_err(|e| e.to_string())?;
            let mut map = serde_json::Map::new();
            for row in rows {
                let (extra, count) = row.map_err(|e| e.to_string())?;
                let bucket = serde_json::from_str::<Value>(&extra)
                    .ok()
                    .and_then(|v| {
                        v.get("ms_bucket")
                            .and_then(|r| r.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| "unknown".into());
                map.insert(bucket, Value::Number(count.into()));
            }
            Value::Object(map)
        };

        let cache_hit = event_sum("lookup_cache_hit")?;
        let cache_miss = event_sum("lookup_cache_miss")?;
        let cache_total = cache_hit + cache_miss;
        let cache_hit_rate = if cache_total > 0 {
            cache_hit as f64 / cache_total as f64
        } else {
            0.0
        };

        Ok(serde_json::json!({
            "days": days,
            "cutoffDate": cutoff,
            "todayQueries": today_event("clipboard_triggered")?,
            "queries": event_sum("clipboard_triggered")?,
            "cacheHit": cache_hit,
            "cacheMiss": cache_miss,
            "cacheHitRate": cache_hit_rate,
            "filtered": event_sum("clipboard_filtered")?,
            "filteredByReason": filtered_by_reason,
            "streamFallback": event_sum("lookup_stream_fallback")?,
            "backupUsed": event_sum("lookup_backup_used")?,
            "streamFirstFieldBuckets": stream_first,
            "reviewAnswered": event_sum("review_card_answered")?,
            "sessionsViewed": event_sum("reading_session_viewed")?,
            "glossaryApplied": event_sum("glossary_term_applied")?,
            "ocrTriggered": event_sum("ocr_triggered")?,
            "ocrFiltered": event_sum("ocr_filtered")?,
            "ankiSendOk": event_sum("anki_send_ok")?,
            "ankiSendFail": event_sum("anki_send_fail")?,
        }))
    }

    pub fn get_cache(&self, key: &str, ttl_days: i64) -> Result<Option<Value>, String> {
        let result: SqlResult<String> = if ttl_days <= 0 {
            self.conn.query_row(
                "SELECT response FROM cache WHERE cache_key = ?1",
                params![key],
                |row| row.get(0),
            )
        } else {
            self.conn.query_row(
                "SELECT response FROM cache WHERE cache_key = ?1 AND created_at > datetime('now', ?2)",
                params![key, format!("-{ttl_days} days")],
                |row| row.get(0),
            )
        };
        match result {
            Ok(data) => {
                let val = serde_json::from_str(&data).map_err(|e| e.to_string())?;
                Ok(Some(val))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set_cache(&self, key: &str, model: &str, data: &Value) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO cache (cache_key, model, response, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![key, model, data.to_string(), now],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remove expired cache entries and reduce an oversized cache to 4000 rows.
    pub fn cleanup_cache(&self, ttl_days: i64) -> Result<u64, String> {
        let expired = if ttl_days <= 0 {
            0
        } else {
            self.conn
                .execute(
                    "DELETE FROM cache WHERE created_at < datetime('now', ?1)",
                    params![format!("-{ttl_days} days")],
                )
                .map_err(|e| e.to_string())? as u64
        };

        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        let mut evicted: u64 = 0;
        if count > 5000 {
            let over = count - 4000;
            evicted = self
                .conn
                .execute(
                    "DELETE FROM cache WHERE cache_key IN (SELECT cache_key FROM cache ORDER BY created_at ASC LIMIT ?1)",
                    params![over],
                )
                .map_err(|e| e.to_string())? as u64;
        }
        Ok(expired + evicted)
    }

    pub fn clear_cache(&self) -> Result<u64, String> {
        self.conn
            .execute("DELETE FROM cache", [])
            .map(|count| count as u64)
            .map_err(|e| e.to_string())
    }

    /// Remember a lookup: a new entry, or one more time for an entry that is already there,
    /// which then moves to the top. Only the newest [`HISTORY_LIMIT`] entries are kept, and a
    /// blank selection is not worth remembering.
    pub fn record_history(&self, record: &HistoryRecord<'_>) -> Result<(), String> {
        self.record_history_at(record, &history_timestamp())
    }

    fn record_history_at(&self, record: &HistoryRecord<'_>, now: &str) -> Result<(), String> {
        let selection = clipped(record.selection, HISTORY_SELECTION_CHARS);
        if selection.is_empty() {
            return Ok(());
        }
        let kind = match record.kind.trim() {
            "" => "word",
            kind => kind,
        };
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        // A repeat refreshes what the entry says but never blanks what an earlier lookup knew:
        // a lookup without captured context or source keeps the previous ones.
        tx.execute(
            "INSERT INTO lookup_history
                 (history_key, selection, context, lemma, translation, kind,
                  source_app, source_title, lookup_count, first_at, last_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)
             ON CONFLICT(history_key) DO UPDATE SET
                 selection = excluded.selection,
                 lemma = excluded.lemma,
                 translation = excluded.translation,
                 context = CASE WHEN excluded.context <> '' THEN excluded.context ELSE context END,
                 source_app = CASE WHEN excluded.source_app <> '' THEN excluded.source_app ELSE source_app END,
                 source_title = CASE WHEN excluded.source_title <> '' THEN excluded.source_title ELSE source_title END,
                 lookup_count = lookup_count + 1,
                 last_at = excluded.last_at",
            params![
                history_key(&selection, kind),
                selection,
                clipped(record.context, HISTORY_CONTEXT_CHARS),
                clipped(record.lemma, HISTORY_LEMMA_CHARS),
                clipped(record.translation, HISTORY_TRANSLATION_CHARS),
                kind,
                record.source_app.trim(),
                record.source_title.trim(),
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM lookup_history WHERE id IN (
                 SELECT id FROM lookup_history ORDER BY last_at DESC, id DESC LIMIT -1 OFFSET ?1)",
            params![HISTORY_LIMIT],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// The history, newest first. Long selections are cut to a preview: the list is for
    /// recognising an entry, [`Database::history_lookup`] has the full text.
    pub fn list_history(&self) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,
                        CASE WHEN length(selection) > ?1
                             THEN substr(selection, 1, ?1) || '…' ELSE selection END,
                        lemma, translation, kind, source_app, source_title,
                        lookup_count, first_at, last_at
                 FROM lookup_history
                 ORDER BY last_at DESC, id DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![HISTORY_PREVIEW_CHARS], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, i64>(0)?,
                    "selection": row.get::<_, String>(1)?,
                    "lemma": row.get::<_, String>(2)?,
                    "translation": row.get::<_, String>(3)?,
                    "kind": row.get::<_, String>(4)?,
                    "sourceApp": row.get::<_, String>(5)?,
                    "sourceTitle": row.get::<_, String>(6)?,
                    "count": row.get::<_, i64>(7)?,
                    "firstAt": row.get::<_, String>(8)?,
                    "lastAt": row.get::<_, String>(9)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    /// Everything needed to ask the same question again: the full selection and its context.
    pub fn history_lookup(&self, id: i64) -> Result<Option<Value>, String> {
        self.conn
            .query_row(
                "SELECT selection, context, kind, source_app, source_title
                 FROM lookup_history WHERE id = ?1",
                params![id],
                |row| {
                    Ok(serde_json::json!({
                        "selection": row.get::<_, String>(0)?,
                        "context": row.get::<_, String>(1)?,
                        "kind": row.get::<_, String>(2)?,
                        "sourceApp": row.get::<_, String>(3)?,
                        "sourceTitle": row.get::<_, String>(4)?,
                    }))
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn delete_history(&self, ids: &[i64]) -> Result<u64, String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let mut removed = 0_u64;
        {
            let mut stmt = tx
                .prepare("DELETE FROM lookup_history WHERE id = ?1")
                .map_err(|e| e.to_string())?;
            for id in ids {
                removed += stmt.execute(params![id]).map_err(|e| e.to_string())? as u64;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(removed)
    }

    pub fn clear_history(&self) -> Result<u64, String> {
        self.conn
            .execute("DELETE FROM lookup_history", [])
            .map(|count| count as u64)
            .map_err(|e| e.to_string())
    }

    pub fn get_stats(&self) -> Result<Value, String> {
        let word_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM words", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let tag_count: i64 = self
            .conn
            .query_row("SELECT COUNT(DISTINCT tag) FROM word_tags", [], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;
        let cache_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let cache_size_bytes: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(response)), 0) FROM cache",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let history_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM lookup_history", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        Ok(serde_json::json!({
            "wordCount": word_count,
            "tagCount": tag_count,
            "cacheCount": cache_count,
            "cacheSizeBytes": cache_size_bytes,
            "historyCount": history_count,
        }))
    }

    /// Everything the learning-insights page shows, for the last `days` days (7 to 90).
    pub fn learning_insights(&self, days: u32) -> Result<Value, String> {
        self.learning_insights_at(days, chrono::Local::now().date_naive())
    }

    fn learning_insights_at(&self, days: u32, today: chrono::NaiveDate) -> Result<Value, String> {
        use crate::insights;
        let days = days.clamp(7, 90);
        let sql_error = |e: rusqlite::Error| e.to_string();

        let mut facts = insights::Facts::default();
        let mut stmt = self
            .conn
            .prepare("SELECT date, queries FROM usage_log WHERE queries > 0")
            .map_err(sql_error)?;
        for row in stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(sql_error)?
        {
            let (date, queries) = row.map_err(sql_error)?;
            if let Ok(day) = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d") {
                *facts.lookups.entry(day).or_insert(0) += queries;
            }
        }
        let mut stmt = self
            .conn
            .prepare("SELECT saved_at FROM words")
            .map_err(sql_error)?;
        for row in stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sql_error)?
        {
            if let Some(day) = insights::local_day(&row.map_err(sql_error)?) {
                *facts.saved.entry(day).or_insert(0) += 1;
            }
        }
        // Review answers come from the event log, which also says how each was answered.
        let mut answers: std::collections::BTreeMap<chrono::NaiveDate, insights::Answers> =
            std::collections::BTreeMap::new();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT date, extra, COALESCE(SUM(count), 0) FROM local_events
                 WHERE event = 'review_card_answered' GROUP BY date, extra",
            )
            .map_err(sql_error)?;
        for row in stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(sql_error)?
        {
            let (date, extra, answered) = row.map_err(sql_error)?;
            if let Ok(day) = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d") {
                *facts.reviews.entry(day).or_insert(0) += answered;
                answers
                    .entry(day)
                    .or_default()
                    .add(insights::answer_of(&extra), answered);
            }
        }

        // How well the words are known; anything unexpected counts as new, so the parts add up.
        let mut mastery = serde_json::Map::new();
        for level in ["new", "learning", "familiar", "mastered"] {
            mastery.insert(level.into(), Value::from(0));
        }
        let mut stmt = self
            .conn
            .prepare("SELECT COALESCE(mastery, 'new'), COUNT(*) FROM words GROUP BY 1")
            .map_err(sql_error)?;
        for row in stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(sql_error)?
        {
            let (level, count) = row.map_err(sql_error)?;
            let level = if mastery.contains_key(&level) {
                level
            } else {
                "new".to_string()
            };
            let total = mastery[&level].as_i64().unwrap_or(0) + count;
            mastery.insert(level, Value::from(total));
        }

        let today_text = insights::day_key(today);
        let due_today: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM review_state WHERE date(due_at) <= ?1",
                params![today_text],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        let mut boxes = [0_i64; 3];
        let mut stmt = self
            .conn
            .prepare("SELECT box, COUNT(*) FROM review_state GROUP BY box")
            .map_err(sql_error)?;
        for row in stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .map_err(sql_error)?
        {
            let (box_number, count) = row.map_err(sql_error)?;
            if (1..=3).contains(&box_number) {
                boxes[(box_number - 1) as usize] = count;
            }
        }
        let (correct, hard, wrong): (i64, i64, i64) = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(correct_count), 0), COALESCE(SUM(hard_count), 0),
                        COALESCE(SUM(wrong_count), 0)
                 FROM review_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(sql_error)?;

        // A short ranking: each row is a name and a number, under the given keys.
        let ranked =
            |sql: &str, label: &'static str, number: &'static str| -> Result<Vec<Value>, String> {
                let mut stmt = self.conn.prepare(sql).map_err(sql_error)?;
                let rows = stmt
                    .query_map([], |row| {
                        let mut item = serde_json::Map::new();
                        item.insert(label.to_string(), Value::from(row.get::<_, String>(0)?));
                        item.insert(number.to_string(), Value::from(row.get::<_, i64>(1)?));
                        Ok(Value::Object(item))
                    })
                    .map_err(sql_error)?;
                rows.collect::<SqlResult<Vec<Value>>>().map_err(sql_error)
            };
        let top_sources = ranked(
            "SELECT source_app, COUNT(*) FROM words WHERE source_app <> ''
             GROUP BY source_app ORDER BY 2 DESC, 1 ASC LIMIT 5",
            "source",
            "count",
        )?;
        let often_looked_up = ranked(
            "SELECT lemma, lookups FROM words
             WHERE lookups > 1 AND kind IN ('word', 'phrase')
             ORDER BY lookups DESC, saved_at DESC, lemma ASC LIMIT 5",
            "lemma",
            "count",
        )?;
        // Forgetting a word weighs more than finding it hard: twice as much.
        let hard_words = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT w.lemma, r.wrong_count, r.hard_count
                     FROM review_state r JOIN words w ON w.id = r.word_id
                     WHERE (r.wrong_count > 0 OR r.hard_count > 0) AND w.kind IN ('word', 'phrase')
                     ORDER BY r.wrong_count * 2 + r.hard_count DESC, r.correct_count ASC, w.lemma ASC
                     LIMIT 5",
                )
                .map_err(sql_error)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "lemma": row.get::<_, String>(0)?,
                        "wrong": row.get::<_, i64>(1)?,
                        "hard": row.get::<_, i64>(2)?,
                    }))
                })
                .map_err(sql_error)?;
            rows.collect::<SqlResult<Vec<Value>>>().map_err(sql_error)?
        };

        let word_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM words", [], |row| row.get(0))
            .map_err(sql_error)?;
        let total_lookups: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(queries), 0) FROM usage_log",
                [],
                |row| row.get(0),
            )
            .map_err(sql_error)?;

        let mut result = insights::activity(days, today, &facts);
        if let Some(object) = result.as_object_mut() {
            object.insert("today".into(), Value::from(today_text));
            object.insert("days".into(), Value::from(days));
            object.insert(
                "totals".into(),
                serde_json::json!({ "words": word_count, "lookups": total_lookups }),
            );
            object.insert("mastery".into(), Value::Object(mastery));
            object.insert(
                "review".into(),
                serde_json::json!({
                    "dueToday": due_today,
                    "total": boxes.iter().sum::<i64>(),
                    "boxCounts": boxes,
                    "correct": correct,
                    "hard": hard,
                    "wrong": wrong,
                }),
            );
            object.insert(
                "reviewCalendar".into(),
                insights::review_calendar(today, &answers, insights::CALENDAR_WEEKS),
            );
            object.insert("topSources".into(), Value::Array(top_sources));
            object.insert("oftenLookedUp".into(), Value::Array(often_looked_up));
            object.insert("hardWords".into(), Value::Array(hard_words));
        }
        Ok(result)
    }
}

fn validate_integrity(conn: &Connection) -> Result<(), String> {
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("完整性检查失败: {e}"))?;
    if integrity != "ok" {
        return Err(format!("数据库完整性检查未通过: {integrity}"));
    }
    Ok(())
}

fn validate_connection_basic(conn: &Connection) -> Result<(), String> {
    validate_integrity(conn)?;
    let schema = crate::migrations::current_version(conn)?;
    if schema != crate::migrations::LATEST_SCHEMA_VERSION {
        return Err(format!("数据库 schema 版本不匹配: {schema}"));
    }
    Ok(())
}

fn validate_connection(conn: &Connection) -> Result<(), String> {
    validate_connection_basic(conn)?;
    validate_schema_contract(conn)
}

pub(crate) fn validate_database_file(path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开数据库失败: {e}"))?;
    validate_connection(&connection)
        .map_err(|error| format!("数据库 {} 验证失败: {error}", path.display()))
}

fn validate_schema_contract(conn: &Connection) -> Result<(), String> {
    validate_schema_contract_as_of(conn, crate::migrations::LATEST_SCHEMA_VERSION)
}

/// A backup made by this or an earlier version can be restored: afterwards it is upgraded
/// exactly like an old database the app opens. One made by a newer app cannot, since this
/// app does not know what it holds. What the backup must contain is what its own version had.
fn validate_restorable(conn: &Connection) -> Result<(), String> {
    validate_integrity(conn)?;
    let version = crate::migrations::current_version(conn)?;
    if version > crate::migrations::LATEST_SCHEMA_VERSION {
        return Err(format!(
            "备份来自更新版本的应用（schema v{version}），请先升级应用再恢复"
        ));
    }
    validate_schema_contract_as_of(conn, version)
}

/// Checks the tables and columns a database of schema `version` has to have. Each entry says
/// since which version it exists, so an older backup is held to what its own version had.
fn validate_schema_contract_as_of(conn: &Connection, version: i64) -> Result<(), String> {
    const REQUIRED_COLUMNS: &[(i64, &str, &[&str])] = &[
        (
            0,
            "words",
            &[
                "id",
                "lemma",
                "translation",
                "pos",
                "context_meaning",
                "explanation",
                "source_app",
                "source_title",
                "mastery",
                "kind",
                "saved_at",
                "updated_at",
                "lookups",
                "data",
            ],
        ),
        (0, "word_tags", &["word_id", "tag"]),
        (
            0,
            "cache",
            &["cache_key", "model", "response", "created_at"],
        ),
        (0, "settings", &["key", "value"]),
        (0, "templates", &["id", "data"]),
        (0, "usage_log", &["date", "queries", "tokens"]),
        (
            1,
            "review_state",
            &[
                "word_id",
                "box",
                "due_at",
                "last_result",
                "correct_count",
                "wrong_count",
                "reviewed_at",
                "created_at",
            ],
        ),
        (
            3,
            "glossary_terms",
            &[
                "id",
                "term",
                "term_key",
                "translation",
                "domain",
                "note",
                "case_sensitive",
                "enabled",
                "created_at",
                "updated_at",
            ],
        ),
        (
            4,
            "local_events",
            &["id", "date", "event", "count", "extra"],
        ),
        (
            6,
            "lookup_history",
            &[
                "id",
                "history_key",
                "selection",
                "context",
                "lemma",
                "translation",
                "kind",
                "source_app",
                "source_title",
                "lookup_count",
                "first_at",
                "last_at",
            ],
        ),
        (7, "review_state", &["hard_count"]),
    ];

    for (_, table, required_columns) in REQUIRED_COLUMNS
        .iter()
        .filter(|(since, _, _)| *since <= version)
    {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                params![table],
                |row| row.get(0),
            )
            .map_err(|e| format!("schema table check failed for {table}: {e}"))?;
        if !exists {
            return Err(format!("schema missing required table: {table}"));
        }
        let pragma = format!("PRAGMA table_info(\"{table}\")");
        let mut statement = conn
            .prepare(&pragma)
            .map_err(|e| format!("schema column check failed for {table}: {e}"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("schema column check failed for {table}: {e}"))?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| format!("schema column check failed for {table}: {e}"))?;
        for column in *required_columns {
            if !columns.contains(*column) {
                return Err(format!("schema missing required column: {table}.{column}"));
            }
        }
    }

    let fts_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='words_fts'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("schema FTS check failed: {e}"))?;
    if !fts_sql
        .as_deref()
        .map(|sql| sql.to_ascii_lowercase().contains("using fts5"))
        .unwrap_or(false)
    {
        return Err("schema missing words_fts FTS5 table".into());
    }

    for trigger in ["words_ai", "words_ad", "words_au"] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",
                params![trigger],
                |row| row.get(0),
            )
            .map_err(|e| format!("schema trigger check failed for {trigger}: {e}"))?;
        if !exists {
            return Err(format!("schema missing required trigger: {trigger}"));
        }
    }
    Ok(())
}

fn is_safe_backup_name(name: &str) -> bool {
    let path = Path::new(name);
    path.file_name().and_then(|file| file.to_str()) == Some(name)
        && name.ends_with(".db")
        && (name.starts_with(AUTO_BACKUP_PREFIX)
            || name.starts_with(PREMIGRATION_BACKUP_PREFIX)
            || name.starts_with(RESTORE_SAFETY_PREFIX))
}

fn available_space(path: &Path) -> Result<u64, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0_u64;
        // SAFETY: the path buffer is NUL-terminated and all output pointers
        // refer to stack-owned values valid for the duration of the call.
        unsafe {
            GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None)
                .map_err(|e| e.to_string())?;
        }
        Ok(free)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(u64::MAX)
    }
}

fn verify_directory_writable(directory: &Path) -> Result<(), String> {
    let probe = directory.join(format!(
        ".gege-write-probe-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&probe).map_err(|e| format!("目标目录不可写: {e}"))?;
        file.write_all(b"gege")
            .map_err(|e| format!("目标目录不可写: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("同步目标目录探针失败: {e}"))?;
        Ok(())
    })();
    let _ = fs::remove_file(&probe);
    result
}

fn copy_file_without_replace(source: &Path, destination: &Path) -> Result<u64, String> {
    let mut created = false;
    let result = (|| -> Result<u64, String> {
        let mut input = fs::File::open(source)
            .map_err(|e| format!("无法打开备份文件 {}: {e}", source.display()))?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|e| format!("目标备份文件已存在或不可写 {}: {e}", destination.display()))?;
        created = true;
        let bytes = std::io::copy(&mut input, &mut output)
            .map_err(|e| format!("复制备份文件失败 {}: {e}", source.display()))?;
        output
            .sync_all()
            .map_err(|e| format!("同步备份文件失败 {}: {e}", destination.display()))?;
        Ok(bytes)
    })();
    if result.is_err() && created {
        let _ = fs::remove_file(destination);
    }
    result
}

pub fn backup_database(database: &Database) -> Result<String, String> {
    let db_path = Path::new(database.path());
    let db_dir = db_path.parent().ok_or("无法解析数据库目录")?;
    let backups_dir = db_dir.join("backups");
    fs::create_dir_all(&backups_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let mut backup_name = format!("{AUTO_BACKUP_PREFIX}{stamp}.db");
    let mut backup_path = backups_dir.join(&backup_name);
    let mut suffix = 1_u32;
    while backup_path.exists() {
        backup_name = format!("{AUTO_BACKUP_PREFIX}{stamp}-{suffix:03}.db");
        backup_path = backups_dir.join(&backup_name);
        suffix += 1;
    }
    database.snapshot_to(&backup_path)?;
    prune_auto_backups(&backups_dir)?;
    Ok(backup_name)
}

fn prune_auto_backups(backups_dir: &Path) -> Result<(), String> {
    let mut entries = fs::read_dir(backups_dir)
        .map_err(|e| format!("读取备份目录失败: {e}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with(AUTO_BACKUP_PREFIX) && name.ends_with(".db") && entry.path().is_file()
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    let remove_count = entries.len().saturating_sub(10);
    for entry in entries.into_iter().take(remove_count) {
        fs::remove_file(entry.path()).map_err(|e| format!("清理旧自动备份失败: {e}"))?;
    }
    Ok(())
}

pub fn has_auto_backup_today(db_path: &str) -> Result<bool, String> {
    let db_dir = Path::new(db_path).parent().ok_or("无法解析数据库目录")?;
    let backups_dir = db_dir.join("backups");
    if !backups_dir.is_dir() {
        return Ok(false);
    }
    let prefix = format!(
        "{AUTO_BACKUP_PREFIX}{}-",
        chrono::Local::now().format("%Y%m%d")
    );
    Ok(fs::read_dir(backups_dir)
        .map_err(|e| format!("读取备份目录失败: {e}"))?
        .filter_map(Result::ok)
        .any(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with(&prefix) && name.ends_with(".db") && entry.path().is_file()
        }))
}

pub fn list_backups(db_path: &str) -> Result<Vec<Value>, String> {
    let db_dir = Path::new(db_path)
        .parent()
        .ok_or("Cannot determine database directory")?;
    let backups_dir = db_dir.join("backups");

    if !backups_dir.exists() {
        return Ok(vec![]);
    }

    let mut backups: Vec<Value> = std::fs::read_dir(&backups_dir)
        .map_err(|e| format!("读取备份目录失败: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_safe_backup_name(&name) {
                return None;
            }
            if !entry.path().is_file() {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let size_kb = meta.len() / 1024;
            let modified = meta.modified().ok()?;
            let modified_ts = modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();
            Some(serde_json::json!({
                "name": name,
                "sizeKb": size_kb,
                "modifiedTs": modified_ts,
                "path": entry.path().to_string_lossy().to_string(),
                "kind": if name.starts_with(AUTO_BACKUP_PREFIX) {
                    "auto"
                } else if name.starts_with(PREMIGRATION_BACKUP_PREFIX) {
                    "premigration"
                } else {
                    "restoreSafety"
                },
                "restorable": !name.starts_with(PREMIGRATION_BACKUP_PREFIX),
            }))
        })
        .collect();

    backups.sort_by(|a, b| {
        let ta = a.get("modifiedTs").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("modifiedTs").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(backups)
}

pub fn restore_backup(database: &mut Database, backup_name: &str) -> Result<(), String> {
    database.restore_from_backup(backup_name)
}

pub fn cleanup_migration_target(result: &DataDirChangeResult) {
    let new_db = Path::new(&result.new_db_path);
    let _ = fs::remove_file(new_db);
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = PathBuf::from(format!("{}{}", result.new_db_path, suffix));
        let _ = fs::remove_file(sidecar);
    }
    if let Some(parent) = new_db.parent() {
        for name in &result.copied_backup_names {
            let _ = fs::remove_file(parent.join("backups").join(name));
        }
    }
}

pub fn change_data_dir(database: &Database, new_dir: &str) -> Result<DataDirChangeResult, String> {
    let source_path = Path::new(database.path());
    let old_db_path = source_path
        .canonicalize()
        .unwrap_or_else(|_| source_path.to_path_buf());
    let target_input = PathBuf::from(new_dir.trim());
    if target_input.as_os_str().is_empty() {
        return Err("目标数据目录不能为空".into());
    }
    fs::create_dir_all(&target_input).map_err(|e| format!("创建目标目录失败: {e}"))?;
    let target_dir = target_input
        .canonicalize()
        .map_err(|e| format!("规范化目标目录失败: {e}"))?;
    let old_dir = old_db_path.parent().ok_or("无法解析原目录")?;
    if target_dir == old_dir {
        return Err("目标目录与当前数据目录相同".into());
    }
    if fs::read_dir(&target_dir)
        .map_err(|e| format!("读取目标目录失败: {e}"))?
        .next()
        .is_some()
    {
        return Err("目标数据目录必须为空".into());
    }
    let new_db_path = target_dir.join(DB_FILENAME);
    if new_db_path.exists() || target_dir.join(LEGACY_DB_FILENAME).exists() {
        return Err("目标目录已存在数据库文件，请选择空目录".into());
    }
    verify_directory_writable(&target_dir)?;

    let logical_size = database.logical_size_bytes()?;
    let required = (logical_size as f64 * 1.10).ceil() as u64 + MIN_FREE_SPACE_BYTES;
    if available_space(&target_dir)? <= required {
        return Err(format!("目标目录可用空间不足，需要至少 {} 字节", required));
    }

    let partial = target_dir.join(format!(".{DB_FILENAME}.migration-{}", std::process::id()));
    let _ = fs::remove_file(&partial);
    let mut warnings = Vec::new();
    let mut copied_backup_names = Vec::new();
    let result = (|| -> Result<DataDirChangeResult, String> {
        database.snapshot_to(&partial)?;
        let verify = Connection::open(&partial).map_err(|e| format!("验证新数据库失败: {e}"))?;
        validate_connection(&verify)?;
        let source_count: i64 = database
            .conn
            .query_row("SELECT COUNT(*) FROM words", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let target_count: i64 = verify
            .query_row("SELECT COUNT(*) FROM words", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if source_count != target_count {
            return Err(format!(
                "迁移后词条数量不一致: {source_count} != {target_count}"
            ));
        }
        drop(verify);
        atomic_replace(&partial, &new_db_path)?;

        let old_backups = old_dir.join("backups");
        let new_backups = target_dir.join("backups");
        if old_backups.is_dir() {
            fs::create_dir_all(&new_backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
            for entry in fs::read_dir(&old_backups).map_err(|e| format!("读取旧备份失败: {e}"))?
            {
                let entry = entry.map_err(|e| format!("读取旧备份条目失败: {e}"))?;
                if !entry.path().is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if !is_safe_backup_name(&name) {
                    continue;
                }
                let destination = new_backups.join(&name);
                match copy_file_without_replace(&entry.path(), &destination) {
                    Ok(_) => copied_backup_names.push(name),
                    Err(error) => warnings.push(format!("备份复制失败 {name}: {error}")),
                }
            }
        }

        Ok(DataDirChangeResult {
            old_db_path: old_db_path.to_string_lossy().to_string(),
            new_db_path: new_db_path.to_string_lossy().to_string(),
            backups_copied: copied_backup_names.len() as u32,
            warnings,
            copied_backup_names: copied_backup_names.clone(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(&new_db_path);
        let new_backups = target_dir.join("backups");
        for name in &copied_backup_names {
            let _ = fs::remove_file(new_backups.join(name));
        }
    }
    result
}

pub fn get_data_dir(db_path: &str) -> String {
    Path::new(db_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn get_db_size(db_path: &str) -> u64 {
    std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
}

pub fn export_words(words: &[Value], format: &str) -> Result<String, String> {
    match format {
        "csv" => {
            let mut lines =
                vec!["lemma,translation,pos,context_meaning,source,tags,saved_at".to_string()];
            for w in words {
                let lemma = w.get("lemma").and_then(|v| v.as_str()).unwrap_or("");
                let tr = w.get("translation").and_then(|v| v.as_str()).unwrap_or("");
                let pos = w.get("pos").and_then(|v| v.as_str()).unwrap_or("");
                let cm = w
                    .get("contextMeaning")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let src = w.get("sourceApp").and_then(|v| v.as_str()).unwrap_or("");
                let tags = w
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| t.as_str())
                            .collect::<Vec<_>>()
                            .join(";")
                    })
                    .unwrap_or_default();
                let saved = w.get("savedAt").and_then(|v| v.as_str()).unwrap_or("");
                lines.push(format!(
                    "\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"",
                    lemma.replace('"', "\"\""),
                    tr.replace('"', "\"\""),
                    pos,
                    cm.replace('"', "\"\""),
                    src,
                    tags,
                    saved
                ));
            }
            Ok(lines.join("\n"))
        }
        "markdown" => {
            let mut md = String::from("# 鸽鸽词典 生词导出\n\n");
            for w in words {
                let lemma = w.get("lemma").and_then(|v| v.as_str()).unwrap_or("");
                let pos = w.get("pos").and_then(|v| v.as_str()).unwrap_or("");
                let tr = w.get("translation").and_then(|v| v.as_str()).unwrap_or("");
                let cm = w
                    .get("contextMeaning")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let ctx = w.get("context").and_then(|v| v.as_str()).unwrap_or("");
                md.push_str(&format!("## {} ({})\n\n", lemma, pos));
                md.push_str(&format!("**翻译**: {}\n\n", tr));
                if !cm.is_empty() {
                    md.push_str(&format!("**语境义**: {}\n\n", cm));
                }
                if !ctx.is_empty() {
                    md.push_str(&format!("> {}\n\n", ctx));
                }
                if let Some(examples) = w.get("examples").and_then(|v| v.as_array()) {
                    for ex in examples {
                        let en = ex.get("en").and_then(|v| v.as_str()).unwrap_or("");
                        let zh = ex.get("zh").and_then(|v| v.as_str()).unwrap_or("");
                        md.push_str(&format!("- {} — {}\n", en, zh));
                    }
                    md.push('\n');
                }
                md.push_str("---\n\n");
            }
            Ok(md)
        }
        "anki" => {
            let mut lines = Vec::new();
            for w in words {
                let lemma = w.get("lemma").and_then(|v| v.as_str()).unwrap_or("");
                let tr = w.get("translation").and_then(|v| v.as_str()).unwrap_or("");
                let cm = w
                    .get("contextMeaning")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let ipa = w.get("ipaUS").and_then(|v| v.as_str()).unwrap_or("");
                let mut back = format!("{}<br>{}", tr, cm);
                if let Some(examples) = w.get("examples").and_then(|v| v.as_array()) {
                    for ex in examples {
                        let en = ex.get("en").and_then(|v| v.as_str()).unwrap_or("");
                        let zh = ex.get("zh").and_then(|v| v.as_str()).unwrap_or("");
                        back.push_str(&format!("<br>• {} — {}", en, zh));
                    }
                }
                let front = if ipa.is_empty() {
                    lemma.to_string()
                } else {
                    format!("{} {}", lemma, ipa)
                };
                lines.push(format!(
                    "{}\t{}",
                    front.replace('\t', " "),
                    back.replace('\t', " ")
                ));
            }
            Ok(lines.join("\n"))
        }
        _ => Err(format!("Unknown format: {format}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "gege-dictionary-test-{name}-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            if self
                .0
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("gege-dictionary-test-"))
            {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn local_events_aggregate_and_clear() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.record_local_event("clipboard_filtered", &serde_json::json!({"reason":"code"}))
            .unwrap();
        db.record_local_event("clipboard_filtered", &serde_json::json!({"reason":"code"}))
            .unwrap();
        db.record_local_event("lookup_cache_hit", &serde_json::json!({"kind":"word"}))
            .unwrap();
        db.record_local_event("ocr_triggered", &serde_json::json!({"kind":"word"}))
            .unwrap();
        db.record_local_event("ocr_filtered", &serde_json::json!({"reason":"empty"}))
            .unwrap();
        db.record_local_event("anki_send_ok", &serde_json::json!({"count":1}))
            .unwrap();
        db.record_local_event("anki_send_fail", &serde_json::json!({"count":1}))
            .unwrap();
        let metrics = db.get_local_metrics(7).unwrap();
        assert_eq!(metrics["filtered"], 2);
        assert_eq!(metrics["filteredByReason"]["code"], 2);
        assert_eq!(metrics["cacheHit"], 1);
        assert_eq!(metrics["cacheHitRate"].as_f64().unwrap(), 1.0);
        assert_eq!(metrics["ocrTriggered"], 1);
        assert_eq!(metrics["ocrFiltered"], 1);
        assert_eq!(metrics["ankiSendOk"], 1);
        assert_eq!(metrics["ankiSendFail"], 1);
        db.clear_local_metrics().unwrap();
        let after = db.get_local_metrics(7).unwrap();
        assert_eq!(after["filtered"], 0);
        assert_eq!(after["ocrTriggered"], 0);
    }

    #[test]
    fn resolves_and_renames_legacy_database() {
        let dir = TestDir::new("legacy");
        let legacy = Connection::open(dir.0.join(LEGACY_DB_FILENAME)).unwrap();
        drop(legacy);
        let resolved = resolve_db_path(&dir.0);
        assert_eq!(resolved, dir.0.join(DB_FILENAME));
        assert!(resolved.exists());
        assert!(dir.0.join(LEGACY_DB_FILENAME).exists());
    }

    #[test]
    fn persists_custom_data_directory_pointer() {
        let root = TestDir::new("pointer");
        let default_dir = root.0.join("default");
        let custom_dir = root.0.join("custom");
        std::fs::create_dir_all(&custom_dir).unwrap();
        persist_configured_data_dir(&default_dir, &custom_dir).unwrap();
        assert_eq!(
            read_configured_data_dir(&default_dir).unwrap(),
            Some(custom_dir)
        );
    }

    #[test]
    fn online_snapshot_contains_changes_still_in_wal() {
        let root = TestDir::new("wal-snapshot");
        let source_path = root.0.join(DB_FILENAME);
        let snapshot_path = root.0.join("snapshot.db");
        let source = Database::open(source_path.to_str().unwrap()).unwrap();
        source.initialize().unwrap();
        source
            .save_word(&serde_json::json!({
                "id": "wal-word",
                "lemma": "WAL word",
                "selection": "WAL word",
                "kind": "word",
                "tags": ["snapshot"]
            }))
            .unwrap();
        assert!(source_path.with_extension("db-wal").exists());

        source.snapshot_to(&snapshot_path).unwrap();

        let copied = Database::open(snapshot_path.to_str().unwrap()).unwrap();
        copied.initialize().unwrap();
        let words = copied.get_all_words().unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0]["lemma"], "WAL word");
    }

    #[test]
    fn migration_returns_paths_and_copies_only_backup_files() {
        let root = TestDir::new("migration-contract");
        let old_dir = root.0.join("old");
        let new_dir = root.0.join("new");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(old_dir.join("backups")).unwrap();
        let old_path = old_dir.join(DB_FILENAME);
        let source = Database::open(old_path.to_str().unwrap()).unwrap();
        source.initialize().unwrap();
        source
            .save_word(&serde_json::json!({
                "id": "migration-word",
                "lemma": "migration",
                "selection": "migration",
                "kind": "word"
            }))
            .unwrap();
        source
            .save_settings(&serde_json::json!({
                "provider": {"apiKey": ""},
                "theme": "dark",
                "dataDir": "migration-settings"
            }))
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE review_state SET box=3 WHERE word_id='migration-word'",
                [],
            )
            .unwrap();
        source
            .save_glossary_term(&serde_json::json!({
                "term": "migration-term",
                "translation": "迁移术语",
                "domain": "general",
                "note": "保留",
                "caseSensitive": false,
                "enabled": true
            }))
            .unwrap();
        std::fs::write(
            old_dir
                .join("backups")
                .join("gege-backup-20260811-120000-001.db"),
            b"not sqlite",
        )
        .unwrap();
        std::fs::write(
            old_dir.join("backups").join("lexnote-backup-old.db"),
            b"legacy",
        )
        .unwrap();
        std::fs::write(old_dir.join("backups").join("notes.txt"), b"unrelated").unwrap();

        let result = change_data_dir(&source, new_dir.to_str().unwrap()).unwrap();
        assert_eq!(
            result.old_db_path,
            old_path.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            result.new_db_path,
            new_dir
                .canonicalize()
                .unwrap()
                .join(DB_FILENAME)
                .to_string_lossy()
        );
        assert!(old_path.exists());
        assert_eq!(result.backups_copied, 1);
        assert!(new_dir.join(DB_FILENAME).exists());
        assert!(new_dir
            .join("backups")
            .join("gege-backup-20260811-120000-001.db")
            .exists());
        assert!(!new_dir
            .join("backups")
            .join("lexnote-backup-old.db")
            .exists());
        assert!(!new_dir.join("backups").join("notes.txt").exists());
        let migrated = Database::open(result.new_db_path.as_str()).unwrap();
        migrated.initialize().unwrap();
        assert_eq!(migrated.get_all_words().unwrap().len(), 1);
        assert_eq!(migrated.get_settings().unwrap()["theme"], "dark");
        let box_number: i64 = migrated
            .conn
            .query_row(
                "SELECT box FROM review_state WHERE word_id='migration-word'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(box_number, 3);
        assert_eq!(
            migrated.list_glossary_terms(None, None, 20, 0).unwrap()["total"],
            1
        );
    }

    #[test]
    fn isolated_reliability_workflow_round_trips_database_state() {
        let root = TestDir::new("isolated-workflow");
        let old_dir = root.0.join("old");
        let new_dir = root.0.join("new");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_path = old_dir.join(DB_FILENAME);
        let database = Database::open(old_path.to_str().unwrap()).unwrap();
        database.initialize().unwrap();
        database
            .save_word(&serde_json::json!({
                "id": "workflow-word",
                "lemma": "workflow",
                "translation": "工作流",
                "kind": "word"
            }))
            .unwrap();
        database
            .save_settings(&serde_json::json!({
                "provider": {"apiKey": ""},
                "theme": "dark"
            }))
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE review_state SET box=3 WHERE word_id='workflow-word'",
                [],
            )
            .unwrap();
        database
            .save_glossary_term(&serde_json::json!({
                "term": "workflow-term",
                "translation": "工作流术语",
                "domain": "general",
                "note": "保留",
                "caseSensitive": false,
                "enabled": true
            }))
            .unwrap();

        let backup_name = backup_database(&database).unwrap();
        let mapping = [
            ("lemma".to_string(), "lemma".to_string()),
            ("translation".to_string(), "translation".to_string()),
        ]
        .into_iter()
        .collect();
        let import = database
            .import_words("lemma,translation\nimported,导入词条\n", "csv", &mapping)
            .unwrap();
        assert_eq!(import.inserted, 1);

        let migration = change_data_dir(&database, new_dir.to_str().unwrap()).unwrap();
        drop(database);
        let mut reopened = Database::open(&migration.new_db_path).unwrap();
        reopened.initialize().unwrap();
        assert_eq!(reopened.get_all_words().unwrap().len(), 2);
        assert_eq!(reopened.get_settings().unwrap()["theme"], "dark");
        assert_eq!(
            reopened
                .conn
                .query_row(
                    "SELECT box FROM review_state WHERE word_id='workflow-word'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            3
        );
        assert_eq!(
            reopened.list_glossary_terms(None, None, 20, 0).unwrap()["total"],
            1
        );

        restore_backup(&mut reopened, &backup_name).unwrap();
        assert_eq!(reopened.get_all_words().unwrap().len(), 1);
        assert_eq!(reopened.get_all_words().unwrap()[0]["lemma"], "workflow");
        assert_eq!(reopened.get_settings().unwrap()["theme"], "dark");
        assert_eq!(
            reopened.list_glossary_terms(None, None, 20, 0).unwrap()["total"],
            1
        );
    }

    #[test]
    fn unavailable_pointer_is_reported_without_fallback() {
        let root = TestDir::new("missing-pointer");
        let default_dir = root.0.join("default");
        let missing_dir = root.0.join("missing");
        std::fs::create_dir_all(&default_dir).unwrap();
        std::fs::write(
            default_dir.join(DATA_DIR_POINTER_FILENAME),
            missing_dir.to_string_lossy().as_bytes(),
        )
        .unwrap();
        let configured = read_configured_data_dir(&default_dir).unwrap();
        assert_eq!(configured, Some(missing_dir));
    }

    #[test]
    fn auto_backup_retention_keeps_ten_and_never_deletes_other_backups() {
        let root = TestDir::new("auto-backup-retention");
        let backups = root.0.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        for index in 0..12 {
            std::fs::write(
                backups.join(format!("{AUTO_BACKUP_PREFIX}20260801-000000-{index:03}.db")),
                b"backup",
            )
            .unwrap();
        }
        let legacy = backups.join("lexnote-backup-old.db");
        std::fs::write(&legacy, b"legacy").unwrap();
        prune_auto_backups(&backups).unwrap();
        let auto_count = std::fs::read_dir(&backups)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(AUTO_BACKUP_PREFIX)
            })
            .count();
        assert_eq!(auto_count, 10);
        assert!(legacy.exists());
    }

    #[test]
    fn daily_backup_detection_is_scoped_to_the_local_calendar_day() {
        let root = TestDir::new("auto-backup-calendar-day");
        let backups = root.0.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        let db_path = root.0.join(DB_FILENAME);
        let today = chrono::Local::now().format("%Y%m%d");
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1)).format("%Y%m%d");
        std::fs::write(
            backups.join(format!("{AUTO_BACKUP_PREFIX}{yesterday}-235959-000.db")),
            b"yesterday",
        )
        .unwrap();
        std::fs::create_dir(backups.join(format!("{AUTO_BACKUP_PREFIX}{today}-000000-000.db")))
            .unwrap();
        assert!(!has_auto_backup_today(db_path.to_str().unwrap()).unwrap());
        std::fs::write(
            backups.join(format!("{AUTO_BACKUP_PREFIX}{today}-000001-000.db")),
            b"today",
        )
        .unwrap();
        assert!(has_auto_backup_today(db_path.to_str().unwrap()).unwrap());
    }

    #[test]
    fn word_import_merges_without_overwriting_user_state() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.save_word(&serde_json::json!({
            "id": "keep-id",
            "lemma": "Keep  Word",
            "selection": "Keep  Word",
            "translation": "用户翻译",
            "mastery": "learning",
            "lookups": 17,
            "note": "用户备注",
            "tags": ["old"]
        }))
        .unwrap();
        db.conn
            .execute("UPDATE review_state SET box=3 WHERE word_id='keep-id'", [])
            .unwrap();
        let mapping = [
            ("lemma".to_string(), "lemma".to_string()),
            ("translation".to_string(), "translation".to_string()),
            ("tags".to_string(), "tags".to_string()),
        ]
        .into_iter()
        .collect();
        let result = db
            .import_words(
                "lemma,translation,tags\n keep   word ,导入翻译,new;old\nInserted,新词,tag\n,缺失,skip\n",
                "csv",
                &mapping,
            )
            .unwrap();
        assert_eq!(result.inserted, 1);
        assert_eq!(result.merged, 1);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.errors.len(), 1);
        let words = db.get_all_words().unwrap();
        let kept = words.iter().find(|word| word["id"] == "keep-id").unwrap();
        assert_eq!(kept["translation"], "用户翻译");
        assert_eq!(kept["mastery"], "learning");
        assert_eq!(kept["lookups"], 17);
        assert_eq!(kept["note"], "用户备注");
        assert_eq!(kept["tags"], serde_json::json!(["old", "new"]));
        let box_number: i64 = db
            .conn
            .query_row(
                "SELECT box FROM review_state WHERE word_id='keep-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(box_number, 3);
    }

    #[test]
    fn saving_a_lookup_inserts_a_complete_new_word() {
        let db = new_db();
        let saved = db
            .save_lookup_result(&lookup_entry("Idempotent", "word", "幂等的"))
            .unwrap();
        let id = saved["id"].as_str().unwrap();
        assert!(!id.is_empty());
        assert!(!saved["savedAt"].as_str().unwrap().is_empty());
        assert_eq!(saved["mastery"], "new");
        assert_eq!(saved["lookups"], 1);
        assert_eq!(saved["note"], "");
        assert_eq!(saved["tags"], serde_json::json!([]));
        assert_eq!(db.get_all_words().unwrap(), vec![saved.clone()]);
        let reviews: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM review_state WHERE word_id=?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reviews, 1);
    }

    #[test]
    fn saving_a_lookup_again_keeps_everything_the_user_owns() {
        let db = new_db();
        let first = db
            .save_lookup_result(&lookup_entry("idempotent", "word", "旧释义"))
            .unwrap();
        let id = first["id"].as_str().unwrap().to_string();
        db.update_word(
            &id,
            &serde_json::json!({"mastery": "familiar", "note": "我的笔记", "tags": ["cs"]}),
        )
        .unwrap();
        db.conn
            .execute(
                "UPDATE review_state SET box=3 WHERE word_id=?1",
                params![id],
            )
            .unwrap();
        db.set_anki_note_ids(&[(id.clone(), 1_700_000_000_123)])
            .unwrap();

        // The lookup window only knows the entry it fetched: no user state.
        let mut again = lookup_entry("idempotent", "word", "新释义");
        again["id"] = Value::String(id.clone());
        again["mastery"] = Value::String("new".into());
        again["tags"] = serde_json::json!(["ai"]);
        again["savedAt"] = Value::String("2099-01-01T00:00:00Z".into());
        again["sourceApp"] = Value::String("Browser".into());
        again["context"] = Value::String("a newer sentence".into());
        again["lookups"] = Value::from(1);
        let merged = db.save_lookup_result(&again).unwrap();

        // The content follows the newest lookup ...
        assert_eq!(merged["translation"], "新释义");
        assert_eq!(merged["context"], "a newer sentence");
        // ... while everything the user owns, and the first source, is kept.
        assert_eq!(merged["id"], id.as_str());
        assert_eq!(merged["mastery"], "familiar");
        assert_eq!(merged["note"], "我的笔记");
        assert_eq!(merged["tags"], serde_json::json!(["cs", "ai"]));
        assert_eq!(merged["savedAt"], first["savedAt"]);
        assert_eq!(merged["sourceApp"], "Reader");
        assert_eq!(merged["lookups"], 2);
        assert_eq!(merged["ankiNoteId"], 1_700_000_000_123_i64);

        // One row, and what was returned is what is stored.
        assert_eq!(db.get_all_words().unwrap(), vec![merged.clone()]);
        let box_number: i64 = db
            .conn
            .query_row(
                "SELECT box FROM review_state WHERE word_id=?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(box_number, 3, "review progress must survive a re-lookup");
        let anki: Option<String> = db
            .conn
            .query_row(
                "SELECT anki_note_id FROM words WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(anki.as_deref(), Some("1700000000123"));
        let mut stmt = db
            .conn
            .prepare("SELECT tag FROM word_tags WHERE word_id=?1 ORDER BY tag")
            .unwrap();
        let tags: Vec<String> = stmt
            .query_map(params![id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(tags, ["ai", "cs"]);
    }

    #[test]
    fn a_second_lookup_with_a_new_id_merges_by_normalised_lemma_and_kind() {
        let db = new_db();
        let first = db
            .save_lookup_result(&lookup_entry("Hello  World", "phrase", "你好世界"))
            .unwrap();
        let mut again = lookup_entry(" hello world ", "phrase", "世界你好");
        again["id"] = Value::String("w-brand-new-id".into());
        let merged = db.save_lookup_result(&again).unwrap();
        assert_eq!(merged["id"], first["id"]);
        assert_eq!(merged["lemma"], "Hello  World", "stored spelling is kept");
        assert_eq!(merged["translation"], "世界你好");
        assert_eq!(merged["lookups"], 2);
        assert_eq!(db.get_all_words().unwrap().len(), 1);
    }

    #[test]
    fn lookups_of_different_kinds_stay_separate_words() {
        let db = new_db();
        db.save_lookup_result(&lookup_entry("run", "word", "跑"))
            .unwrap();
        db.save_lookup_result(&lookup_entry("run", "sentence", "跑。"))
            .unwrap();
        assert_eq!(db.get_all_words().unwrap().len(), 2);
        assert!(db
            .find_word_by_lemma("RUN", Some("sentence"))
            .unwrap()
            .is_some());
        assert!(db
            .find_word_by_lemma("run", Some("phrase"))
            .unwrap()
            .is_none());
        assert!(db.find_word_by_lemma("  Run ", None).unwrap().is_some());
        assert!(db.find_word_by_lemma("   ", None).unwrap().is_none());
    }

    #[test]
    fn lemma_matching_folds_non_ascii_case_like_the_importer() {
        // SQLite's own lower() only understands ASCII, so this would have been
        // missed by a purely SQL-side comparison.
        let db = new_db();
        db.save_lookup_result(&lookup_entry("Über", "word", "over"))
            .unwrap();
        let merged = db
            .save_lookup_result(&lookup_entry("über", "word", "above"))
            .unwrap();
        assert_eq!(merged["lookups"], 2);
        assert_eq!(db.get_all_words().unwrap().len(), 1);
    }

    #[test]
    fn saving_a_lookup_without_a_lemma_is_rejected_and_stores_nothing() {
        let db = new_db();
        assert!(db
            .save_lookup_result(&lookup_entry("   ", "word", "x"))
            .is_err());
        assert!(db
            .save_lookup_result(&serde_json::json!("not an object"))
            .is_err());
        assert!(db.get_all_words().unwrap().is_empty());
    }

    #[test]
    fn legacy_duplicates_resolve_to_the_earliest_saved_word() {
        let db = new_db();
        let mut early = sample_word("early", "Reader", "2026-08-01T10:00:00+08:00");
        early["lemma"] = Value::String("dup".into());
        let mut late = sample_word("late", "Reader", "2026-08-02T10:00:00+08:00");
        late["lemma"] = Value::String("Dup".into());
        db.save_word(&late).unwrap();
        db.save_word(&early).unwrap();
        let merged = db
            .save_lookup_result(&lookup_entry("dup", "word", "新"))
            .unwrap();
        assert_eq!(merged["id"], "early");
        assert_eq!(
            db.get_all_words().unwrap().len(),
            2,
            "existing duplicates are never silently deleted"
        );
    }

    #[test]
    fn words_in_order_follow_the_request_and_skip_unknown_and_repeated_ids() {
        let db = new_db();
        for (id, saved_at) in [
            ("a", "2026-08-01T10:00:00+08:00"),
            ("b", "2026-08-02T10:00:00+08:00"),
            ("c", "2026-08-03T10:00:00+08:00"),
        ] {
            db.save_word(&sample_word(id, "Reader", saved_at)).unwrap();
        }
        let ids: Vec<String> = ["a", "c", "missing", "b", "a"].map(String::from).to_vec();
        assert_eq!(
            ids_of(&db.get_words_in_order(&ids).unwrap()),
            ["a", "c", "b"]
        );
        // The older helper sorts newest first, so pairing its output with the
        // requested ids by position (what the Anki export did) mixed words up.
        let legacy = db
            .get_words_by_ids(&["a".to_string(), "c".to_string()])
            .unwrap();
        assert_eq!(ids_of(&legacy), ["c", "a"]);
        assert!(db.get_words_in_order(&[]).unwrap().is_empty());
    }

    #[test]
    fn anki_note_ids_are_stored_in_the_document_and_the_indexed_column() {
        let db = new_db();
        for id in ["a", "b", "c"] {
            db.save_word(&sample_word(id, "Reader", "2026-08-01T10:00:00+08:00"))
                .unwrap();
        }
        let updated = db
            .set_anki_note_ids(&[("a".into(), 11), ("ghost".into(), 99), ("b".into(), 22)])
            .unwrap();
        assert_eq!(updated, 2);
        let words = db
            .get_words_in_order(&["a".to_string(), "b".to_string()])
            .unwrap();
        assert_eq!(words[0]["ankiNoteId"], 11);
        assert_eq!(words[1]["ankiNoteId"], 22);
        let column = |id: &str| -> Option<String> {
            db.conn
                .query_row(
                    "SELECT anki_note_id FROM words WHERE id=?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(column("a").as_deref(), Some("11"));
        assert_eq!(column("b").as_deref(), Some("22"));
        assert_eq!(column("c"), None, "a word never sent has no link");
        // An ordinary edit keeps the link in the document and the column.
        db.update_word("a", &serde_json::json!({"note": "edited"}))
            .unwrap();
        assert_eq!(column("a").as_deref(), Some("11"));
    }

    #[test]
    fn batch_update_changes_mastery_and_edits_tags_on_every_word() {
        let db = new_db();
        for (id, tags) in [
            ("a", serde_json::json!(["x"])),
            ("b", serde_json::json!([])),
            ("c", serde_json::json!(["x", "y"])),
        ] {
            let mut word = sample_word(id, "Reader", "2026-08-01T10:00:00+08:00");
            word["tags"] = tags;
            db.save_word(&word).unwrap();
        }
        let ids: Vec<String> = ["a", "b", "c", "ghost", "a"].map(String::from).to_vec();
        let report = db
            .batch_update_words(
                &ids,
                &BatchWordPatch {
                    mastery: Some("learning".into()),
                    add_tags: vec![" fresh ".into(), "x".into()],
                    remove_tags: vec!["y".into()],
                },
            )
            .unwrap();
        assert_eq!(
            report,
            BatchUpdateReport {
                updated: 3,
                missing: 1
            }
        );
        let words = db
            .get_words_in_order(&["a".to_string(), "b".to_string(), "c".to_string()])
            .unwrap();
        let tags: Vec<Value> = words.iter().map(|word| word["tags"].clone()).collect();
        assert_eq!(
            tags,
            vec![
                serde_json::json!(["x", "fresh"]),
                serde_json::json!(["fresh", "x"]),
                serde_json::json!(["x", "fresh"]),
            ]
        );
        assert!(words.iter().all(|word| word["mastery"] == "learning"));
        let mut stmt = db
            .conn
            .prepare("SELECT tag FROM word_tags WHERE word_id='c' ORDER BY tag")
            .unwrap();
        let indexed: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(indexed, ["fresh", "x"]);
        let reviews: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM review_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(reviews, 3, "batch edits must not reset review state");
    }

    #[test]
    fn batch_mastery_change_leaves_tags_untouched() {
        let db = new_db();
        let mut word = sample_word("a", "Reader", "2026-08-01T10:00:00+08:00");
        word["tags"] = serde_json::json!(["  spaced ", "dup", "dup"]);
        db.save_word(&word).unwrap();
        db.batch_update_words(
            &["a".to_string()],
            &BatchWordPatch {
                mastery: Some("mastered".into()),
                ..BatchWordPatch::default()
            },
        )
        .unwrap();
        let stored = db.get_words_in_order(&["a".to_string()]).unwrap();
        assert_eq!(stored[0]["mastery"], "mastered");
        assert_eq!(stored[0]["tags"], word["tags"]);
    }

    #[test]
    fn batch_update_rejects_bad_patches_before_touching_any_word() {
        let db = new_db();
        db.save_word(&sample_word("a", "Reader", "2026-08-01T10:00:00+08:00"))
            .unwrap();
        let ids = vec!["a".to_string()];
        let bad_patches = [
            BatchWordPatch {
                mastery: Some("expert".into()),
                ..BatchWordPatch::default()
            },
            BatchWordPatch::default(),
            BatchWordPatch {
                add_tags: vec!["x".repeat(33)],
                ..BatchWordPatch::default()
            },
            BatchWordPatch {
                add_tags: (0..21).map(|n| format!("t{n}")).collect(),
                ..BatchWordPatch::default()
            },
        ];
        for patch in &bad_patches {
            assert!(db.batch_update_words(&ids, patch).is_err(), "{patch:?}");
        }
        let stored = db.get_words_in_order(&ids).unwrap();
        assert_eq!(stored[0]["mastery"], "new");
        assert_eq!(stored[0]["tags"], serde_json::json!([]));
    }

    #[test]
    fn deleting_words_removes_their_tags_and_review_state_together() {
        let db = new_db();
        for id in ["a", "b", "c"] {
            let mut word = sample_word(id, "Reader", "2026-08-01T10:00:00+08:00");
            word["tags"] = serde_json::json!(["t"]);
            db.save_word(&word).unwrap();
        }
        db.delete_words(&["a".to_string(), "b".to_string(), "ghost".to_string()])
            .unwrap();
        assert_eq!(ids_of(&db.get_all_words().unwrap()), ["c"]);
        let count = |table: &str| -> i64 {
            db.conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        assert_eq!(count("word_tags"), 1);
        assert_eq!(count("review_state"), 1);
    }

    fn new_db() -> Database {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db
    }

    /// What the lookup window hands over: the entry content, no user state.
    fn lookup_entry(lemma: &str, kind: &str, translation: &str) -> Value {
        serde_json::json!({
            "selection": lemma,
            "lemma": lemma,
            "translation": translation,
            "pos": "n.",
            "contextMeaning": "context meaning",
            "explanation": "explanation",
            "kind": kind,
            "sourceApp": "Reader",
            "sourceTitle": "Doc",
            "context": "context",
            "tags": [],
            "examples": [],
            "associations": [],
            "senses": [],
            "collocations": []
        })
    }

    fn ids_of(words: &[Value]) -> Vec<String> {
        words
            .iter()
            .map(|word| word["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn usage_counts_today_and_this_month_but_not_older_months() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.conn
            .execute(
                "INSERT INTO usage_log (date, queries, tokens) VALUES ('2000-01-15', 7, 7000)",
                [],
            )
            .unwrap();
        assert_eq!(db.get_usage().unwrap()["month"], 0);

        db.record_lookup(120).unwrap();
        db.record_lookup(0).unwrap(); // answered from the cache: counted, but free

        let usage = db.get_usage().unwrap();
        assert_eq!(usage["today"], 2);
        assert_eq!(usage["month"], 2);
        assert_eq!(usage["tokens"], 120);
    }

    #[test]
    fn the_batch_spends_tokens_without_making_lookups() {
        let db = new_db();
        assert_eq!(db.tokens_today().unwrap(), 0);

        db.record_lookup(120).unwrap();
        db.record_tokens(500).unwrap();
        db.record_tokens(80).unwrap();

        assert_eq!(db.tokens_today().unwrap(), 700);
        let usage = db.get_usage().unwrap();
        assert_eq!(usage["today"], 1, "the batch is not a lookup of the user");
        assert_eq!(usage["tokens"], 700);
    }

    #[test]
    fn the_batch_can_be_the_only_use_of_the_day() {
        let db = new_db();
        db.record_tokens(300).unwrap();

        assert_eq!(db.tokens_today().unwrap(), 300);
        assert_eq!(db.get_usage().unwrap()["today"], 0);
    }

    #[test]
    fn only_todays_tokens_count_towards_the_limit_of_the_day() {
        let db = new_db();
        db.conn
            .execute(
                "INSERT INTO usage_log (date, queries, tokens) VALUES ('2000-01-15', 7, 7000)",
                [],
            )
            .unwrap();

        assert_eq!(db.tokens_today().unwrap(), 0);
    }

    fn variant(id: &str, edit: impl FnOnce(&mut Value)) -> Value {
        let mut word = sample_word(id, "Reader", "2026-08-01T10:00:00+00:00");
        edit(&mut word);
        word
    }

    fn model_answer() -> Value {
        serde_json::json!({
            "lemma": "a-form-the-model-prefers",
            "translation": "模型的释义",
            "pos": "adj.",
            "ipaUS": "/əˈfemərəl/",
            "ipaUK": "/ɪˈfemərəl/",
            "contextMeaning": "语境义",
            "explanation": "lasting a very short time",
            "senses": [{ "pos": "adj.", "translation": "短暂的", "gloss": "first" }],
            "associations": [{ "title": "transient", "text": "近义" }],
            "examples": [{ "en": "Fame is ephemeral.", "zh": "名声转瞬即逝。" }],
            "collocations": [{ "phrase": "ephemeral beauty", "translation": "转瞬即逝的美" }],
            "register": "formal",
            "_model": "test-model"
        })
    }

    fn ids_of_candidates(candidates: &[enrich::Candidate]) -> Vec<String> {
        candidates
            .iter()
            .map(|candidate| candidate.id.clone())
            .collect()
    }

    #[test]
    fn the_bare_words_are_the_ones_the_rule_in_rust_calls_bare() {
        let db = new_db();
        let words = vec![
            variant("bare-word", |_| {}),
            variant("bare-phrase", |word| word["kind"] = "phrase".into()),
            variant("unsaid-kind", |word| word["kind"] = "".into()),
            variant("with-senses", |word| {
                word["senses"] = serde_json::json!([{ "translation": "义" }])
            }),
            variant("with-examples", |word| {
                word["examples"] = serde_json::json!([{ "en": "x", "zh": "y" }])
            }),
            variant("sentence", |word| word["kind"] = "sentence".into()),
            variant("paragraph", |word| word["kind"] = "paragraph".into()),
            variant("no-lists", |word| {
                let fields = word.as_object_mut().unwrap();
                fields.remove("senses");
                fields.remove("examples");
            }),
            variant("odd-lists", |word| {
                word["senses"] = "oops".into();
                word["examples"] = Value::Null;
            }),
        ];
        for word in &words {
            db.save_word(word).unwrap();
        }

        let mut expected: Vec<String> = words
            .iter()
            .filter(|word| enrich::is_bare(word))
            .map(|word| word["id"].as_str().unwrap().to_string())
            .collect();
        expected.sort();
        let mut listed = ids_of_candidates(&db.bare_words(None).unwrap());
        listed.sort();

        assert_eq!(listed, expected, "the query and the rule disagree");
        assert_eq!(db.count_bare_words().unwrap(), expected.len());
        // Not a test of nothing against nothing.
        assert_eq!(
            expected,
            [
                "bare-phrase",
                "bare-word",
                "no-lists",
                "odd-lists",
                "unsaid-kind"
            ]
        );
    }

    #[test]
    fn the_bare_words_come_oldest_first_and_can_be_narrowed_down() {
        let db = new_db();
        for (id, saved_at) in [
            ("c", "2026-08-03T10:00:00+00:00"),
            ("b", "2026-08-01T10:00:00+00:00"),
            ("a", "2026-08-01T10:00:00+00:00"),
        ] {
            db.save_word(&sample_word(id, "", saved_at)).unwrap();
        }
        let mut done = sample_word("d", "", "2026-07-01T10:00:00+00:00");
        done["senses"] = serde_json::json!([{ "translation": "义" }]);
        db.save_word(&done).unwrap();

        let all = db.bare_words(None).unwrap();
        assert_eq!(ids_of_candidates(&all), ["a", "b", "c"]);
        assert_eq!(all[0].lemma, "a");

        let some = db
            .bare_words(Some(&["c".into(), "d".into(), "nobody".into()]))
            .unwrap();
        assert_eq!(ids_of_candidates(&some), ["c"]);
        assert!(db.bare_words(Some(&[])).unwrap().is_empty());
    }

    #[test]
    fn one_damaged_document_does_not_fail_the_whole_list() {
        let db = new_db();
        db.save_word(&sample_word("good", "", "2026-08-01T10:00:00+00:00"))
            .unwrap();
        db.save_word(&sample_word("damaged", "", "2026-08-01T10:00:00+00:00"))
            .unwrap();
        db.conn
            .execute(
                "UPDATE words SET data = 'not json at all' WHERE id = 'damaged'",
                [],
            )
            .unwrap();

        assert_eq!(ids_of_candidates(&db.bare_words(None).unwrap()), ["good"]);
        assert_eq!(db.count_bare_words().unwrap(), 1);
    }

    #[test]
    fn filling_a_bare_word_adds_what_it_lacks_and_leaves_what_the_user_owns() {
        let db = new_db();
        let mut word = sample_word("alpha", "Reader", "2026-08-01T10:00:00+00:00");
        word["note"] = "我的笔记".into();
        word["tags"] = serde_json::json!(["托福"]);
        word["mastery"] = "learning".into();
        word["lookups"] = 3.into();
        db.save_word(&word).unwrap();
        db.conn
            .execute(
                "UPDATE review_state SET box = 3 WHERE word_id = 'alpha'",
                [],
            )
            .unwrap();

        let filled = db.fill_in_word("alpha", &model_answer()).unwrap();
        let enrich::Filled::Done(stored) = filled else {
            panic!("expected the word to be filled, got {filled:?}");
        };

        // What was missing is there now.
        assert_eq!(stored["senses"][0]["gloss"], "first");
        assert_eq!(stored["examples"][0]["en"], "Fame is ephemeral.");
        assert_eq!(stored["collocations"][0]["phrase"], "ephemeral beauty");
        assert_eq!(stored["ipaUS"], "/əˈfemərəl/");
        assert_eq!(stored["register"], "formal");
        assert_eq!(stored["_model"], "test-model");
        // What the user owns, and what the word already said, is not touched.
        assert_eq!(stored["id"], "alpha");
        assert_eq!(stored["lemma"], "alpha");
        assert_eq!(stored["translation"], "alpha-中文");
        assert_eq!(stored["pos"], "n.");
        assert_eq!(stored["note"], "我的笔记");
        assert_eq!(stored["tags"], serde_json::json!(["托福"]));
        assert_eq!(stored["mastery"], "learning");
        assert_eq!(stored["lookups"], 3);
        assert_eq!(stored["savedAt"], "2026-08-01T10:00:00+00:00");
        assert_eq!(stored["sourceApp"], "Reader");

        // What came back is what is stored, and the rest of the database agrees with it.
        let in_the_library = db.get_words_in_order(&["alpha".to_string()]).unwrap();
        assert_eq!(in_the_library, [*stored]);
        let box_number: i64 = db
            .conn
            .query_row(
                "SELECT box FROM review_state WHERE word_id = 'alpha'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(box_number, 3, "review progress is the user's");
        let tags: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM word_tags WHERE word_id = 'alpha'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tags, 1);
        assert_eq!(db.count_bare_words().unwrap(), 0);
        assert_eq!(db.get_all_words().unwrap().len(), 1, "no second entry");
    }

    #[test]
    fn a_note_typed_while_the_model_was_answering_is_not_lost() {
        let db = new_db();
        let word = sample_word("alpha", "", "2026-08-01T10:00:00+00:00");
        db.save_word(&word).unwrap();

        // The batch looked at the word, asked the model, and in the meantime the user wrote a note.
        let mut edited = word.clone();
        edited["note"] = "写在这期间的笔记".into();
        db.save_word(&edited).unwrap();
        db.fill_in_word("alpha", &model_answer()).unwrap();

        let stored = &db.get_words_in_order(&["alpha".to_string()]).unwrap()[0];
        assert_eq!(stored["note"], "写在这期间的笔记");
        assert_eq!(stored["senses"][0]["gloss"], "first");
    }

    #[test]
    fn a_word_deleted_in_the_meantime_is_not_brought_back() {
        let db = new_db();
        db.save_word(&sample_word("alpha", "", "2026-08-01T10:00:00+00:00"))
            .unwrap();
        db.delete_words(&["alpha".to_string()]).unwrap();

        let outcome = db.fill_in_word("alpha", &model_answer()).unwrap();

        assert_eq!(outcome, enrich::Filled::Gone);
        assert!(db.get_all_words().unwrap().is_empty());
    }

    #[test]
    fn a_word_that_is_no_longer_bare_is_left_as_it_is() {
        let db = new_db();
        let mut word = sample_word("alpha", "", "2026-08-01T10:00:00+00:00");
        word["senses"] = serde_json::json!([{ "translation": "我自己加的义项" }]);
        db.save_word(&word).unwrap();
        let mut sentence = sample_word("beta", "", "2026-08-01T10:00:00+00:00");
        sentence["kind"] = "sentence".into();
        db.save_word(&sentence).unwrap();

        assert_eq!(
            db.fill_in_word("alpha", &model_answer()).unwrap(),
            enrich::Filled::NotBare
        );
        assert_eq!(
            db.fill_in_word("beta", &model_answer()).unwrap(),
            enrich::Filled::NotBare
        );

        let stored = db
            .get_words_in_order(&["alpha".to_string(), "beta".to_string()])
            .unwrap();
        assert_eq!(stored, [word, sentence]);
    }

    #[test]
    fn an_answer_with_nothing_to_add_is_an_error_and_changes_nothing() {
        let db = new_db();
        let word = sample_word("alpha", "", "2026-08-01T10:00:00+00:00");
        db.save_word(&word).unwrap();

        for nothing in [
            serde_json::json!({ "lemma": "alpha", "senses": [], "examples": [] }),
            serde_json::json!({}),
            serde_json::json!("not even an object"),
        ] {
            let error = db.fill_in_word("alpha", &nothing).unwrap_err();
            assert!(error.starts_with("[empty]"), "{error}");
        }

        assert_eq!(
            db.get_words_in_order(&["alpha".to_string()]).unwrap(),
            [word]
        );
        assert_eq!(
            db.count_bare_words().unwrap(),
            1,
            "it is still there to be asked again"
        );
    }

    fn history_db() -> Database {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db
    }

    fn lookup<'a>(selection: &'a str, kind: &'a str) -> HistoryRecord<'a> {
        HistoryRecord {
            selection,
            context: "",
            kind,
            lemma: "",
            translation: "",
            source_app: "",
            source_title: "",
        }
    }

    /// Strictly increasing timestamps, so ordering never depends on the clock.
    fn at(n: u32) -> String {
        format!("2026-10-07T12:00:{:02}.{:03}Z", n / 1000, n % 1000)
    }

    #[test]
    fn history_keeps_one_entry_per_lookup_and_counts_repeats() {
        let db = history_db();
        let first = HistoryRecord {
            lemma: "run",
            translation: "跑",
            ..lookup("Run", "word")
        };
        let again = HistoryRecord {
            translation: "奔跑",
            ..lookup("  run ", "word")
        };
        db.record_history_at(&first, &at(1)).unwrap();
        db.record_history_at(&again, &at(2)).unwrap();

        let list = db.list_history().unwrap();
        assert_eq!(list.len(), 1, "case and spacing do not make a new word");
        assert_eq!(list[0]["count"], 2);
        assert_eq!(list[0]["selection"], "run", "the latest spelling is shown");
        assert_eq!(list[0]["translation"], "奔跑");
        assert_eq!(list[0]["firstAt"], at(1).as_str());
        assert_eq!(list[0]["lastAt"], at(2).as_str());
    }

    #[test]
    fn history_tells_sentences_apart_by_case_and_kinds_apart_always() {
        let db = history_db();
        db.record_history_at(&lookup("Time flies", "sentence"), &at(1))
            .unwrap();
        db.record_history_at(&lookup("time flies", "sentence"), &at(2))
            .unwrap();
        db.record_history_at(&lookup("Time   flies", "sentence"), &at(3))
            .unwrap();
        db.record_history_at(&lookup("Time flies", "phrase"), &at(4))
            .unwrap();

        let counts: Vec<(String, i64)> = db
            .list_history()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    format!(
                        "{}/{}",
                        item["selection"].as_str().unwrap(),
                        item["kind"].as_str().unwrap()
                    ),
                    item["count"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            counts,
            [
                ("Time flies/phrase".to_string(), 1),
                ("Time   flies/sentence".to_string(), 2),
                ("time flies/sentence".to_string(), 1),
            ]
        );
    }

    #[test]
    fn history_lists_the_newest_first_and_a_repeat_moves_to_the_top() {
        let db = history_db();
        for (index, word) in ["alpha", "beta", "gamma"].into_iter().enumerate() {
            db.record_history_at(&lookup(word, "word"), &at(index as u32 + 1))
                .unwrap();
        }
        let order = |db: &Database| -> Vec<String> {
            db.list_history()
                .unwrap()
                .iter()
                .map(|item| item["selection"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(order(&db), ["gamma", "beta", "alpha"]);

        db.record_history_at(&lookup("alpha", "word"), &at(10))
            .unwrap();
        assert_eq!(order(&db), ["alpha", "gamma", "beta"]);
    }

    #[test]
    fn history_keeps_only_the_newest_entries() {
        let db = history_db();
        let total = HISTORY_LIMIT as u32 + 5;
        for index in 0..total {
            db.record_history_at(&lookup(&format!("word{index}"), "word"), &at(index))
                .unwrap();
        }
        let list = db.list_history().unwrap();
        assert_eq!(list.len() as i64, HISTORY_LIMIT);
        assert_eq!(list[0]["selection"], format!("word{}", total - 1));
        let oldest_kept = list.last().unwrap()["selection"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            oldest_kept, "word5",
            "word0..word4 were the oldest and are gone"
        );
    }

    #[test]
    fn history_ignores_blank_selections_and_clips_long_text() {
        let db = history_db();
        db.record_history_at(&lookup("  \n ", "word"), &at(1))
            .unwrap();
        assert!(db.list_history().unwrap().is_empty());

        let long = "字".repeat(5000);
        db.record_history_at(&lookup(&long, "paragraph"), &at(2))
            .unwrap();
        let id = db.list_history().unwrap()[0]["id"].as_i64().unwrap();

        let preview = db.list_history().unwrap()[0]["selection"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            preview.chars().count(),
            401,
            "400 characters and an ellipsis"
        );
        assert!(preview.ends_with('…'));
        let full = db.history_lookup(id).unwrap().unwrap();
        assert_eq!(full["selection"].as_str().unwrap().chars().count(), 2000);
    }

    #[test]
    fn a_repeat_without_context_or_source_keeps_what_the_earlier_lookup_knew() {
        let db = history_db();
        let with_source = HistoryRecord {
            context: "He was running late.",
            source_app: "chrome.exe",
            source_title: "News",
            ..lookup("running", "word")
        };
        db.record_history_at(&with_source, &at(1)).unwrap();
        db.record_history_at(&lookup("running", "word"), &at(2))
            .unwrap();

        let id = db.list_history().unwrap()[0]["id"].as_i64().unwrap();
        let kept = db.history_lookup(id).unwrap().unwrap();
        assert_eq!(kept["context"], "He was running late.");
        assert_eq!(kept["sourceApp"], "chrome.exe");
        assert_eq!(kept["sourceTitle"], "News");

        let newer = HistoryRecord {
            context: "Running is fun.",
            source_app: "word.exe",
            ..lookup("running", "word")
        };
        db.record_history_at(&newer, &at(3)).unwrap();
        let updated = db.history_lookup(id).unwrap().unwrap();
        assert_eq!(updated["context"], "Running is fun.");
        assert_eq!(updated["sourceApp"], "word.exe");
        assert_eq!(
            updated["sourceTitle"], "News",
            "no new title: the old one stays"
        );
    }

    #[test]
    fn history_can_be_reopened_deleted_and_cleared() {
        let db = history_db();
        let sentence = HistoryRecord {
            context: "A sentence before.",
            ..lookup("Time flies like an arrow.", "sentence")
        };
        db.record_history_at(&sentence, &at(1)).unwrap();
        db.record_history_at(&lookup("alpha", "word"), &at(2))
            .unwrap();
        db.record_history_at(&lookup("beta", "word"), &at(3))
            .unwrap();
        assert_eq!(db.get_stats().unwrap()["historyCount"], 3);

        let list = db.list_history().unwrap();
        let sentence_id = list[2]["id"].as_i64().unwrap();
        let question = db.history_lookup(sentence_id).unwrap().unwrap();
        assert_eq!(question["selection"], "Time flies like an arrow.");
        assert_eq!(question["context"], "A sentence before.");
        assert_eq!(question["kind"], "sentence");
        assert!(db.history_lookup(987_654).unwrap().is_none());

        let beta_id = list[0]["id"].as_i64().unwrap();
        assert_eq!(db.delete_history(&[beta_id, 987_654]).unwrap(), 1);
        assert_eq!(db.list_history().unwrap().len(), 2);

        assert_eq!(db.clear_history().unwrap(), 2);
        assert!(db.list_history().unwrap().is_empty());
        assert_eq!(db.get_stats().unwrap()["historyCount"], 0);
    }

    fn local_noon(day: chrono::NaiveDate) -> String {
        use chrono::TimeZone;
        chrono::Local
            .from_local_datetime(&day.and_hms_opt(12, 0, 0).unwrap())
            .earliest()
            .unwrap()
            .to_rfc3339()
    }

    #[test]
    fn insights_summarise_the_days_the_library_and_the_reviews() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
        let ago = |n: u64| today.checked_sub_days(chrono::Days::new(n)).unwrap();

        let word = |id: &str,
                    lemma: &str,
                    kind: &str,
                    mastery: &str,
                    source: &str,
                    lookups: u64,
                    saved: chrono::NaiveDate| {
            let mut word = sample_word(id, source, &local_noon(saved));
            word["lemma"] = Value::String(lemma.into());
            word["kind"] = Value::String(kind.into());
            word["mastery"] = Value::String(mastery.into());
            word["lookups"] = Value::from(lookups);
            word
        };
        for saved in [
            word("a", "run", "word", "learning", "Reader", 5, today),
            word("b", "serendipity", "word", "new", "Reader", 1, ago(1)),
            word(
                "c",
                "ubiquitous",
                "word",
                "mastered",
                "chrome.exe",
                3,
                ago(2),
            ),
            // Long ago, a sentence (kept out of the word rankings) with a mastery nobody knows.
            word("d", "Time flies.", "sentence", "odd", "", 9, ago(40)),
        ] {
            db.save_word(&saved).unwrap();
        }
        for (day, queries) in [(today, 4), (ago(1), 0), (ago(3), 2), (ago(60), 50)] {
            db.conn
                .execute(
                    "INSERT INTO usage_log (date, queries, tokens) VALUES (?1, ?2, 0)",
                    params![day.format("%Y-%m-%d").to_string(), queries],
                )
                .unwrap();
        }
        for (day, event, count) in [
            (ago(1), "review_card_answered", 3),
            (ago(1), "lookup_cache_hit", 8),
        ] {
            db.conn
                .execute(
                    "INSERT INTO local_events (date, event, count, extra) VALUES (?1, ?2, ?3, '{}')",
                    params![day.format("%Y-%m-%d").to_string(), event, count],
                )
                .unwrap();
        }
        for (id, due, box_number, correct, wrong) in [
            ("a", "2026-10-07", 1, 4, 0),
            ("b", "2026-10-20", 2, 1, 3),
            ("c", "2026-10-01", 3, 6, 1),
        ] {
            db.conn
                .execute(
                    "UPDATE review_state SET due_at=?2, box=?3, correct_count=?4, wrong_count=?5
                     WHERE word_id=?1",
                    params![id, due, box_number, correct, wrong],
                )
                .unwrap();
        }

        let result = db.learning_insights_at(30, today).unwrap();

        assert_eq!(result["today"], "2026-10-07");
        assert_eq!(result["days"], 30);
        let daily = result["daily"].as_array().unwrap();
        assert_eq!(daily.len(), 30);
        assert_eq!(daily[29]["date"], "2026-10-07");
        assert_eq!(
            (daily[29]["lookups"].as_i64(), daily[29]["saved"].as_i64()),
            (Some(4), Some(1))
        );
        assert_eq!(
            (
                daily[28]["lookups"].as_i64(),
                daily[28]["saved"].as_i64(),
                daily[28]["reviews"].as_i64()
            ),
            (Some(0), Some(1), Some(3)),
            "yesterday: a lookup count of zero is no lookups, a review came from the event log"
        );
        assert_eq!(daily[26]["lookups"], 2);
        assert_eq!(
            result["window"],
            serde_json::json!({"lookups": 6, "saved": 3, "reviews": 3}),
            "what is older than the window is left out"
        );
        assert_eq!(result["savedThisWeek"], 3);
        assert_eq!(
            result["streak"],
            serde_json::json!({"current": 4, "longest": 4, "activeDays": 6})
        );
        assert_eq!(
            result["totals"],
            serde_json::json!({"words": 4, "lookups": 56}),
            "all time, not just the window"
        );
        assert_eq!(
            result["mastery"],
            serde_json::json!({"new": 2, "learning": 1, "familiar": 0, "mastered": 1}),
            "an unknown level counts as new, so the parts add up to the words"
        );
        assert_eq!(
            result["review"],
            serde_json::json!({
                "dueToday": 2,
                "total": 3,
                "boxCounts": [1, 1, 1],
                "correct": 11,
                "hard": 0,
                "wrong": 4,
            })
        );
        assert_eq!(
            result["topSources"],
            serde_json::json!([
                {"source": "Reader", "count": 2},
                {"source": "chrome.exe", "count": 1},
            ]),
            "a word without a source is not a source"
        );
        assert_eq!(
            result["oftenLookedUp"],
            serde_json::json!([
                {"lemma": "run", "count": 5},
                {"lemma": "ubiquitous", "count": 3},
            ]),
            "the sentence was looked up most, but this list is about words"
        );
        assert_eq!(
            result["hardWords"],
            serde_json::json!([
                {"lemma": "serendipity", "wrong": 3, "hard": 0},
                {"lemma": "ubiquitous", "wrong": 1, "hard": 0},
            ])
        );
    }

    #[test]
    fn insights_tell_how_the_cards_were_answered() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();
        let ago = |n: u64| {
            today
                .checked_sub_days(chrono::Days::new(n))
                .unwrap()
                .format("%Y-%m-%d")
                .to_string()
        };

        for (day, event, extra, count) in [
            (ago(0), "review_card_answered", r#"{"result":"correct"}"#, 4),
            (ago(0), "review_card_answered", r#"{"result":"hard"}"#, 2),
            (ago(1), "review_card_answered", r#"{"result":"wrong"}"#, 1),
            // An answer from before the kind of answer was recorded.
            (ago(1), "review_card_answered", "{}", 3),
            // Not an answer at all.
            (ago(0), "lookup_cache_hit", "{}", 9),
        ] {
            db.conn
                .execute(
                    "INSERT INTO local_events (date, event, count, extra) VALUES (?1, ?2, ?3, ?4)",
                    params![day, event, count, extra],
                )
                .unwrap();
        }
        // (id, lemma, kind, right, hard, wrong): the progress of each card over its life.
        for (id, lemma, kind, correct, hard, wrong) in [
            ("w1", "forgot", "word", 1, 0, 1),
            ("w2", "tough", "word", 5, 3, 0),
            ("w3", "slightly", "word", 2, 1, 0),
            ("w4", "Time flies.", "sentence", 0, 9, 9),
            ("w5", "easy", "word", 7, 0, 0),
        ] {
            let mut word = sample_word(id, "Reader", &local_noon(today));
            word["lemma"] = Value::String(lemma.into());
            word["kind"] = Value::String(kind.into());
            db.save_word(&word).unwrap();
            db.conn
                .execute(
                    "INSERT INTO review_state
                         (word_id, box, due_at, correct_count, hard_count, wrong_count, created_at)
                     VALUES (?1, 1, '2026-10-08', ?2, ?3, ?4, '2026-10-01')
                     ON CONFLICT(word_id) DO UPDATE SET correct_count=excluded.correct_count,
                         hard_count=excluded.hard_count, wrong_count=excluded.wrong_count",
                    params![id, correct, hard, wrong],
                )
                .unwrap();
        }

        let result = db.learning_insights_at(30, today).unwrap();

        assert_eq!(
            result["review"],
            serde_json::json!({
                "dueToday": 0,
                "total": 5,
                "boxCounts": [5, 0, 0],
                "correct": 15,
                "hard": 13,
                "wrong": 10,
            })
        );
        assert_eq!(
            result["hardWords"],
            serde_json::json!([
                {"lemma": "tough", "wrong": 0, "hard": 3},
                {"lemma": "forgot", "wrong": 1, "hard": 0},
                {"lemma": "slightly", "wrong": 0, "hard": 1},
            ]),
            "forgetting counts twice as much as finding hard; sentences and easy words are not listed"
        );

        let daily = result["daily"].as_array().unwrap();
        assert_eq!(daily[29]["reviews"], 6);
        assert_eq!(daily[28]["reviews"], 4, "the chart counts every answer");
        let calendar = &result["reviewCalendar"];
        assert_eq!(calendar["weeks"], 12);
        let days = calendar["days"].as_array().unwrap();
        assert_eq!(
            days[days.len() - 1],
            serde_json::json!({"date": "2026-10-07", "total": 6, "correct": 4, "hard": 2, "wrong": 0})
        );
        assert_eq!(
            days[days.len() - 2],
            serde_json::json!({"date": "2026-10-06", "total": 4, "correct": 0, "hard": 0, "wrong": 1}),
            "an answer of no known kind is in the total only"
        );
    }

    #[test]
    fn insights_of_an_empty_library_are_all_zeros_not_an_error() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();

        let result = db.learning_insights_at(30, today).unwrap();

        assert_eq!(result["daily"].as_array().unwrap().len(), 30);
        assert_eq!(
            result["window"],
            serde_json::json!({"lookups": 0, "saved": 0, "reviews": 0})
        );
        assert_eq!(
            result["streak"],
            serde_json::json!({"current": 0, "longest": 0, "activeDays": 0})
        );
        assert_eq!(
            result["totals"],
            serde_json::json!({"words": 0, "lookups": 0})
        );
        assert_eq!(result["review"]["boxCounts"], serde_json::json!([0, 0, 0]));
        assert_eq!(result["topSources"], serde_json::json!([]));
        assert_eq!(result["hardWords"], serde_json::json!([]));
    }

    #[test]
    fn insights_keep_the_window_between_a_week_and_a_quarter() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap();

        assert_eq!(db.learning_insights_at(1, today).unwrap()["days"], 7);
        assert_eq!(db.learning_insights_at(500, today).unwrap()["days"], 90);
        assert_eq!(
            db.learning_insights_at(500, today).unwrap()["daily"]
                .as_array()
                .unwrap()
                .len(),
            90
        );
    }

    #[test]
    fn importing_thousands_of_rows_stays_fast() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        const EXISTING: usize = 3_000;
        const ROWS: usize = 3_000;
        // One save per existing word: work of linear cost, which the import is measured against.
        let seeding_started = std::time::Instant::now();
        {
            let tx = db.conn.unchecked_transaction().unwrap();
            for index in 0..EXISTING {
                let word = sample_word(
                    &format!("seed{index}"),
                    "Reader",
                    "2026-08-01T10:00:00+08:00",
                );
                save_word_with_connection(&tx, &word, false).unwrap();
            }
            tx.commit().unwrap();
        }
        let seeding = seeding_started.elapsed();
        // Even rows hit an existing word (case-insensitively), odd rows are new.
        let mut csv = String::from("lemma,translation\n");
        for index in 0..ROWS {
            if index % 2 == 0 {
                csv.push_str(&format!("SEED{index},合并{index}\n"));
            } else {
                csv.push_str(&format!("fresh{index},新词{index}\n"));
            }
        }
        let mapping = [
            ("lemma".to_string(), "lemma".to_string()),
            ("translation".to_string(), "translation".to_string()),
        ]
        .into_iter()
        .collect();
        let started = std::time::Instant::now();
        let result = db.import_words(&csv, "csv", &mapping).unwrap();
        let elapsed = started.elapsed();
        println!("import: {EXISTING} words saved in {seeding:?}, then {ROWS} rows imported in {elapsed:?}");
        // A quadratic lemma lookup took ~10 s for this size, far more than saving the existing
        // words does; with the hash index the import costs about as much as that saving. So it
        // may take up to six times the saving, or stay within four seconds.
        assert_fast_enough(
            &format!("importing {ROWS} rows into {EXISTING} words"),
            elapsed,
            std::time::Duration::from_secs(4),
            seeding,
            6,
        );
        assert_eq!(result.merged as usize, ROWS / 2);
        assert_eq!(result.inserted as usize, ROWS / 2);
        assert_eq!(db.get_all_words().unwrap().len(), EXISTING + ROWS / 2);
    }

    #[test]
    fn restore_validates_backup_and_restores_the_open_database() {
        let root = TestDir::new("restore");
        let path = root.0.join(DB_FILENAME);
        let mut db = Database::open(path.to_str().unwrap()).unwrap();
        db.initialize().unwrap();
        db.save_word(&serde_json::json!({"id": "before", "lemma": "before", "kind": "word"}))
            .unwrap();
        db.save_settings(&serde_json::json!({
            "provider": {"apiKey": ""},
            "theme": "dark"
        }))
        .unwrap();
        db.conn
            .execute("UPDATE review_state SET box=3 WHERE word_id='before'", [])
            .unwrap();
        db.save_glossary_term(&serde_json::json!({
            "term": "restore-term",
            "translation": "恢复术语",
            "domain": "general",
            "note": "保留",
            "caseSensitive": false,
            "enabled": true
        }))
        .unwrap();
        let backup_name = backup_database(&db).unwrap();
        db.save_word(&serde_json::json!({"id": "after", "lemma": "after", "kind": "word"}))
            .unwrap();
        restore_backup(&mut db, &backup_name).unwrap();
        let words = db.get_all_words().unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0]["lemma"], "before");
        assert_eq!(db.get_settings().unwrap()["theme"], "dark");
        let box_number: i64 = db
            .conn
            .query_row(
                "SELECT box FROM review_state WHERE word_id='before'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(box_number, 3);
        assert_eq!(
            db.list_glossary_terms(None, None, 20, 0).unwrap()["total"],
            1
        );
        assert!(path.exists());
        assert!(root.0.join("backups").join(backup_name).exists());
        assert!(list_backups(path.to_str().unwrap())
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "restoreSafety" && item["restorable"] == true));
    }

    #[test]
    fn backup_listing_marks_pre_migration_snapshots_non_restorable() {
        let root = TestDir::new("backup-list-kinds");
        let path = root.0.join(DB_FILENAME);
        let database = Database::open(path.to_str().unwrap()).unwrap();
        database.initialize().unwrap();
        let backups = root.0.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        let premigration = backups.join("gege-premigrate-v2-test.db");
        database.snapshot_to(&premigration).unwrap();
        let listed = list_backups(path.to_str().unwrap()).unwrap();
        let item = listed
            .iter()
            .find(|item| item["name"] == "gege-premigrate-v2-test.db")
            .unwrap();
        assert_eq!(item["kind"], "premigration");
        assert_eq!(item["restorable"], false);
    }

    #[test]
    fn restore_rejects_incomplete_schema_without_changing_current_database() {
        let root = TestDir::new("restore-invalid-schema");
        let path = root.0.join(DB_FILENAME);
        let mut db = Database::open(path.to_str().unwrap()).unwrap();
        db.initialize().unwrap();
        db.save_word(&serde_json::json!({
            "id": "current",
            "lemma": "current value",
            "kind": "word"
        }))
        .unwrap();

        let invalid_name = "gege-backup-invalid-schema.db";
        let invalid_path = root.0.join("backups").join(invalid_name);
        std::fs::create_dir_all(invalid_path.parent().unwrap()).unwrap();
        let invalid = Connection::open(&invalid_path).unwrap();
        invalid
            .execute_batch(
                "CREATE TABLE words (
                    id TEXT PRIMARY KEY,
                    lemma TEXT NOT NULL,
                    translation TEXT,
                    pos TEXT,
                    context_meaning TEXT,
                    explanation TEXT,
                    source_app TEXT,
                    source_title TEXT,
                    mastery TEXT,
                    kind TEXT,
                    saved_at TEXT,
                    updated_at TEXT,
                    lookups INTEGER,
                    data TEXT
                );
                INSERT INTO words (id, lemma) VALUES ('invalid', 'invalid value');
                PRAGMA user_version = 3;",
            )
            .unwrap();
        drop(invalid);

        let error = restore_backup(&mut db, invalid_name).unwrap_err();
        assert!(error.contains("schema") || error.contains("表") || error.contains("column"));
        let lemma: String = db
            .conn
            .query_row("SELECT lemma FROM words WHERE id='current'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(lemma, "current value");
    }

    #[test]
    fn a_backup_from_an_older_version_is_restored_and_brought_up_to_date() {
        let root = TestDir::new("restore-older-schema");
        let path = root.0.join(DB_FILENAME);
        let mut db = Database::open(path.to_str().unwrap()).unwrap();
        db.initialize().unwrap();
        db.save_word(&serde_json::json!({"id": "kept", "lemma": "kept", "kind": "word"}))
            .unwrap();
        let backup_name = backup_database(&db).unwrap();

        // What an earlier version wrote: the same file, but from before the history table
        // and from before cards could be answered as hard.
        let backup_path = root.0.join("backups").join(&backup_name);
        {
            let old = Connection::open(&backup_path).unwrap();
            old.execute_batch(
                "DROP TABLE lookup_history;
                 ALTER TABLE review_state DROP COLUMN hard_count;
                 PRAGMA user_version = 5;",
            )
            .unwrap();
        }

        db.save_word(&serde_json::json!({"id": "later", "lemma": "later", "kind": "word"}))
            .unwrap();
        restore_backup(&mut db, &backup_name).unwrap();

        let words = db.get_all_words().unwrap();
        assert_eq!(words.len(), 1, "the restore replaces what was there");
        assert_eq!(words[0]["lemma"], "kept");
        assert_eq!(
            crate::migrations::current_version(&db.conn).unwrap(),
            crate::migrations::LATEST_SCHEMA_VERSION
        );
        // The upgrade is complete, not just a version number: the new table is usable.
        db.record_history(&lookup("kept", "word")).unwrap();
        assert_eq!(db.list_history().unwrap().len(), 1);
        assert!(
            list_backups(path.to_str().unwrap())
                .unwrap()
                .iter()
                .any(|item| item["kind"] == "restoreSafety"),
            "what was there before is kept, in case the restore was a mistake"
        );
    }

    #[test]
    fn a_backup_from_before_the_hard_answer_is_restored_with_its_progress_and_upgraded() {
        let root = TestDir::new("restore-v6-schema");
        let path = root.0.join(DB_FILENAME);
        let mut db = Database::open(path.to_str().unwrap()).unwrap();
        db.initialize().unwrap();
        db.save_word(&serde_json::json!({"id": "kept", "lemma": "kept", "kind": "word"}))
            .unwrap();
        db.submit_review("kept", Answer::Correct).unwrap();
        let backup_name = backup_database(&db).unwrap();

        // The version before this one wrote the same file without the hard count.
        {
            let old = Connection::open(root.0.join("backups").join(&backup_name)).unwrap();
            old.execute_batch(
                "ALTER TABLE review_state DROP COLUMN hard_count; PRAGMA user_version = 6;",
            )
            .unwrap();
        }
        db.submit_review("kept", Answer::Wrong).unwrap();

        restore_backup(&mut db, &backup_name).unwrap();

        assert_eq!(
            crate::migrations::current_version(&db.conn).unwrap(),
            crate::migrations::LATEST_SCHEMA_VERSION
        );
        // The progress made up to the backup is back (the wrong answer after it is gone), and
        // the upgraded card can be answered the new way.
        let state = db.submit_review("kept", Answer::Hard).unwrap();
        assert_eq!(state["previousBox"], 2);
        assert_eq!(state["correctCount"], 1);
        assert_eq!(state["wrongCount"], 0);
        assert_eq!(state["hardCount"], 1);
    }

    #[test]
    fn a_backup_that_claims_to_be_current_must_have_the_hard_count() {
        let root = TestDir::new("restore-v7-incomplete");
        let path = root.0.join(DB_FILENAME);
        let mut db = Database::open(path.to_str().unwrap()).unwrap();
        db.initialize().unwrap();
        let backup_name = backup_database(&db).unwrap();
        {
            let broken = Connection::open(root.0.join("backups").join(&backup_name)).unwrap();
            broken
                .execute_batch("ALTER TABLE review_state DROP COLUMN hard_count;")
                .unwrap();
        }

        let error = restore_backup(&mut db, &backup_name).unwrap_err();
        assert!(error.contains("hard_count"), "{error}");
    }

    #[test]
    fn a_backup_from_a_newer_version_is_refused_and_nothing_changes() {
        let root = TestDir::new("restore-newer-schema");
        let path = root.0.join(DB_FILENAME);
        let mut db = Database::open(path.to_str().unwrap()).unwrap();
        db.initialize().unwrap();
        db.save_word(&serde_json::json!({"id": "current", "lemma": "current", "kind": "word"}))
            .unwrap();
        let backup_name = backup_database(&db).unwrap();
        {
            let newer = Connection::open(root.0.join("backups").join(&backup_name)).unwrap();
            newer.execute_batch("PRAGMA user_version = 99;").unwrap();
        }

        let error = restore_backup(&mut db, &backup_name).unwrap_err();
        assert!(error.contains("更新版本"), "{error}");
        let words = db.get_all_words().unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0]["lemma"], "current");
        assert_eq!(
            crate::migrations::current_version(&db.conn).unwrap(),
            crate::migrations::LATEST_SCHEMA_VERSION
        );
    }

    #[test]
    fn an_older_backup_must_still_hold_what_its_own_version_had() {
        let root = TestDir::new("restore-older-incomplete");
        let path = root.0.join(DB_FILENAME);
        let mut db = Database::open(path.to_str().unwrap()).unwrap();
        db.initialize().unwrap();
        let backup_name = backup_database(&db).unwrap();
        {
            // Claims to be v5, but the table v5 certainly had is gone.
            let broken = Connection::open(root.0.join("backups").join(&backup_name)).unwrap();
            broken
                .execute_batch("DROP TABLE glossary_terms; PRAGMA user_version = 5;")
                .unwrap();
        }

        let error = restore_backup(&mut db, &backup_name).unwrap_err();
        assert!(error.contains("glossary_terms"), "{error}");
    }

    #[test]
    fn migration_rejects_non_empty_target_without_creating_database() {
        let root = TestDir::new("migration-non-empty-target");
        let old_dir = root.0.join("old");
        let new_dir = root.0.join("new");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        let marker = new_dir.join("keep-me.txt");
        std::fs::write(&marker, b"do not replace").unwrap();

        let old_path = old_dir.join(DB_FILENAME);
        let source = Database::open(old_path.to_str().unwrap()).unwrap();
        source.initialize().unwrap();
        source
            .save_word(&serde_json::json!({
                "id": "migration-source",
                "lemma": "source",
                "kind": "word"
            }))
            .unwrap();

        let error = change_data_dir(&source, new_dir.to_str().unwrap()).unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(std::fs::read(&marker).unwrap(), b"do not replace");
        assert!(!new_dir.join(DB_FILENAME).exists());
    }

    #[test]
    fn backup_copy_never_replaces_existing_destination() {
        let root = TestDir::new("backup-copy-no-replace");
        let source = root.0.join("source.db");
        let destination = root.0.join("destination.db");
        std::fs::write(&source, b"new backup").unwrap();
        std::fs::write(&destination, b"keep existing").unwrap();

        assert!(copy_file_without_replace(&source, &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"keep existing");
    }

    #[test]
    fn cleanup_migration_target_removes_sqlite_sidecars() {
        let root = TestDir::new("migration-cleanup-sidecars");
        let target_dir = root.0.join("target");
        let new_db = target_dir.join(DB_FILENAME);
        std::fs::create_dir_all(target_dir.join("backups")).unwrap();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            std::fs::write(
                PathBuf::from(format!("{}{}", new_db.display(), suffix)),
                b"partial",
            )
            .unwrap();
        }
        let copied = "gege-backup-test.db".to_string();
        std::fs::write(target_dir.join("backups").join(&copied), b"backup").unwrap();
        cleanup_migration_target(&DataDirChangeResult {
            old_db_path: root.0.join("old").to_string_lossy().to_string(),
            new_db_path: new_db.to_string_lossy().to_string(),
            backups_copied: 1,
            warnings: Vec::new(),
            copied_backup_names: vec![copied],
        });
        assert!(!new_db.exists());
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!PathBuf::from(format!("{}{}", new_db.display(), suffix)).exists());
        }
        assert!(!target_dir
            .join("backups")
            .join("gege-backup-test.db")
            .exists());
    }

    #[test]
    fn cache_ttl_and_clear_are_enforced() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.set_cache("old", "model", &serde_json::json!({"value": 1}))
            .unwrap();
        db.conn
            .execute(
                "UPDATE cache SET created_at = datetime('now', '-31 days') WHERE cache_key = 'old'",
                [],
            )
            .unwrap();
        assert!(db.get_cache("old", 30).unwrap().is_none());
        assert!(db.get_cache("old", 0).unwrap().is_some());
        assert_eq!(db.clear_cache().unwrap(), 1);
    }

    #[test]
    fn existing_settings_receive_new_defaults() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.save_settings(&serde_json::json!({"provider": {"apiKey": ""}, "theme": "dark", "anonymousStats": true}))
            .unwrap();
        assert!(db.get_settings().unwrap().get("anonymousStats").is_none());
        db.initialize().unwrap();
        let settings = db.get_settings().unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["reviewLimit"], 20);
        assert_eq!(settings["sessionGapMinutes"], 30);
        assert_eq!(settings["enrichDailyTokens"], enrich::DEFAULT_DAILY_TOKENS);
        assert_eq!(settings["enrichPace"], "normal");
        assert_eq!(settings["autoCheckUpdates"], true);
        assert_eq!(settings["activeDomainProfile"], "general");
        assert_eq!(settings["analysisStyle"], "standard");
        assert!(settings.get("anonymousStats").is_none());
    }

    #[test]
    fn glossary_crud_matching_and_round_trip_work() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let saved = db
            .save_glossary_term(&serde_json::json!({
                "term": "deadlock",
                "translation": "死锁",
                "domain": "computing",
                "note": "并发控制",
                "caseSensitive": false,
                "enabled": true
            }))
            .unwrap();
        assert!(!saved["id"].as_str().unwrap().is_empty());
        assert_eq!(
            db.list_glossary_terms(Some("dead"), Some("computing"), 20, 0)
                .unwrap()["total"],
            1
        );
        assert_eq!(
            db.find_glossary_matches("deadlock", "avoid deadlock", "computing")
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .find_glossary_matches("deadlock", "", "finance")
            .unwrap()
            .is_empty());

        let tsv = db.export_glossary("tsv", None).unwrap();
        db.delete_glossary_terms(&[saved["id"].as_str().unwrap().into()])
            .unwrap();
        let report = db.import_glossary(&tsv, "tsv", "overwrite").unwrap();
        assert_eq!(report["inserted"], 1);
        let json = db.export_glossary("json", None).unwrap();
        let report = db.import_glossary(&json, "json", "skip").unwrap();
        assert_eq!(report["skipped"], 1);
    }

    #[test]
    fn glossary_import_reports_bad_rows_and_overwrites_conflicts() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let first = "term\ttranslation\tdomain\tnote\tcase_sensitive\tenabled\nPCR\t聚合酶链式反应\tmedical_ivd\t初始\ttrue\ttrue\nbad\trow";
        let report = db.import_glossary(first, "tsv", "overwrite").unwrap();
        assert_eq!(report["inserted"], 1);
        assert_eq!(report["errorCount"], 1);
        let second = "term\ttranslation\tdomain\tnote\tcase_sensitive\tenabled\nPCR\tPCR 扩增\tmedical_ivd\t更新\ttrue\ttrue";
        let report = db.import_glossary(second, "tsv", "overwrite").unwrap();
        assert_eq!(report["updated"], 1);
        assert!(db
            .export_glossary("tsv", Some("medical_ivd"))
            .unwrap()
            .contains("PCR 扩增"));
    }

    #[test]
    fn ten_thousand_glossary_terms_match_within_budget() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let seeding_started = std::time::Instant::now();
        let tx = db.conn.unchecked_transaction().unwrap();
        for index in 0..10_000 {
            tx.execute(
                "INSERT INTO glossary_terms (id,term,term_key,translation,domain,note,case_sensitive,enabled,created_at,updated_at) VALUES (?1,?2,?2,?3,'general','',0,1,'now','now')",
                params![format!("g-{index}"), format!("term{index}"), format!("译法{index}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let seeding = seeding_started.elapsed();
        let started = std::time::Instant::now();
        let matched = db
            .find_glossary_matches("term9999", "unrelated context", "general")
            .unwrap();
        assert_eq!(matched.len(), 1);
        // Matching one lookup must cost far less than writing the ten thousand terms did.
        assert_fast_enough(
            "matching against ten thousand glossary terms",
            started.elapsed(),
            std::time::Duration::from_millis(500),
            seeding,
            1,
        );
        assert_eq!(
            db.list_glossary_terms(None, None, 20, 0).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            20
        );
    }

    /// A timing assertion that holds on a slow machine too.
    ///
    /// A wall-clock budget measures the host as much as the code: on a laptop that is busy with
    /// other work the same query takes many times as long, and a test that fails then proves
    /// nothing. So a measurement passes when it is within `budget`, which is what a machine at
    /// rest achieves, or when it costs no more than `allowed_share` times `reference`: the time
    /// that work of known, linear cost took on this same machine a moment before. Code that has
    /// become quadratic misses both by a wide margin.
    fn assert_fast_enough(
        what: &str,
        took: std::time::Duration,
        budget: std::time::Duration,
        reference: std::time::Duration,
        allowed_share: u32,
    ) {
        assert!(
            took <= budget || took <= reference * allowed_share,
            "{what} took {took:?}: over its budget of {budget:?}, and over {allowed_share} times \
             the {reference:?} that the reference work took on this machine"
        );
    }

    fn sample_word(id: &str, source: &str, saved_at: &str) -> Value {
        serde_json::json!({
            "id": id,
            "selection": id,
            "lemma": id,
            "translation": format!("{id}-中文"),
            "pos": "n.",
            "contextMeaning": "test",
            "explanation": "test",
            "sourceApp": source,
            "sourceTitle": "Document",
            "kind": "word",
            "savedAt": saved_at,
            "mastery": "new",
            "lookups": 1,
            "tags": [],
            "examples": [],
            "associations": [],
            "senses": [],
            "collocations": [],
            "context": "",
            "note": "",
            "ipaUS": "",
            "ipaUK": "",
            "register": "neutral"
        })
    }

    #[test]
    fn review_state_survives_word_upsert_and_transitions() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        let mut word = sample_word("alpha", "Reader", "2026-08-01T10:00:00+08:00");
        db.save_word(&word).unwrap();
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now','localtime') WHERE word_id='alpha'",
                [],
            )
            .unwrap();
        assert_eq!(db.get_review_queue(Some(20)).unwrap().len(), 1);

        word["translation"] = Value::String("已编辑".into());
        db.save_word(&word).unwrap();
        let state = db.submit_review("alpha", Answer::Correct).unwrap();
        assert_eq!(state["box"], 2);
        assert_eq!(state["lastResult"], "correct");
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now','localtime') WHERE word_id='alpha'",
                [],
            )
            .unwrap();
        let state = db.submit_review("alpha", Answer::Wrong).unwrap();
        assert_eq!(state["box"], 1);
        let mastery: String = db
            .conn
            .query_row("SELECT mastery FROM words WHERE id='alpha'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(mastery, "new");
    }

    #[test]
    fn a_hard_answer_keeps_the_box_and_brings_the_card_back_tomorrow() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.save_word(&sample_word("alpha", "Reader", "2026-08-01T10:00:00+08:00"))
            .unwrap();
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now','localtime'), box=2 WHERE word_id='alpha'",
                [],
            )
            .unwrap();
        assert_eq!(db.get_review_queue(Some(20)).unwrap().len(), 1);

        let state = db.submit_review("alpha", Answer::Hard).unwrap();

        assert_eq!(state["box"], 2, "it stays where it was");
        assert_eq!(state["previousBox"], 2);
        assert_eq!(state["lastResult"], "hard");
        assert_eq!(
            (
                state["correctCount"].as_i64(),
                state["hardCount"].as_i64(),
                state["wrongCount"].as_i64()
            ),
            (Some(0), Some(1), Some(0))
        );
        let (due, tomorrow): (String, String) = db
            .conn
            .query_row(
                "SELECT due_at, date('now','localtime','+1 day') FROM review_state WHERE word_id='alpha'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(due, tomorrow, "not after the three days of box 2");
        assert!(
            db.get_review_queue(Some(20)).unwrap().is_empty(),
            "it is done for today"
        );
        let mastery: String = db
            .conn
            .query_row("SELECT mastery FROM words WHERE id='alpha'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(mastery, "learning", "it is neither forgotten nor mastered");
    }

    #[test]
    fn the_three_answers_are_counted_apart_and_the_queue_hands_the_counts_on() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.save_word(&sample_word("alpha", "Reader", "2026-08-01T10:00:00+08:00"))
            .unwrap();

        let mut last = Value::Null;
        for answer in [
            Answer::Correct,
            Answer::Correct,
            Answer::Hard,
            Answer::Wrong,
            Answer::Hard,
        ] {
            last = db.submit_review("alpha", answer).unwrap();
        }

        // Up to box 3, a hard answer there, a wrong one back to box 1, a hard one there.
        assert_eq!(last["box"], 1);
        assert_eq!(last["lastResult"], "hard");
        assert_eq!(
            (
                last["correctCount"].as_i64(),
                last["hardCount"].as_i64(),
                last["wrongCount"].as_i64()
            ),
            (Some(2), Some(2), Some(1))
        );
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now','localtime') WHERE word_id='alpha'",
                [],
            )
            .unwrap();
        let queue = db.get_review_queue(Some(20)).unwrap();
        assert_eq!(queue[0]["reviewState"]["hardCount"], 2);
        assert_eq!(queue[0]["reviewState"]["lastResult"], "hard");
    }

    #[test]
    fn a_card_whose_word_is_gone_cannot_be_answered_and_says_it_was_deleted() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.save_word(&sample_word("alpha", "Reader", "2026-08-01T10:00:00+08:00"))
            .unwrap();
        db.delete_words(&["alpha".to_string()]).unwrap();

        // The review screen skips a card on seeing "删除"; any other message makes it stay.
        for id in ["alpha", "nobody"] {
            let error = db.submit_review(id, Answer::Hard).unwrap_err();
            assert!(error.contains("已被删除"), "{error}");
        }
    }

    #[test]
    fn starting_a_card_over_forgets_its_hard_answers_too() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.save_word(&sample_word("alpha", "Reader", "2026-08-01T10:00:00+08:00"))
            .unwrap();
        db.submit_review("alpha", Answer::Hard).unwrap();
        db.submit_review("alpha", Answer::Correct).unwrap();

        db.reset_review_state("alpha").unwrap();

        let (box_number, correct, hard, wrong, last): (i64, i64, i64, i64, Option<String>) = db
            .conn
            .query_row(
                "SELECT box, correct_count, hard_count, wrong_count, last_result
                 FROM review_state WHERE word_id='alpha'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!((box_number, correct, hard, wrong, last), (1, 0, 0, 0, None));
    }

    #[test]
    fn review_queue_priority_box_three_and_long_form_setting_work() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        for id in ["old", "box-one", "box-two"] {
            db.save_word(&sample_word(id, "Reader", "2026-08-01T10:00:00+08:00"))
                .unwrap();
        }
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now','-2 day'),box=3 WHERE word_id='old'",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now'),box=1 WHERE word_id='box-one'",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now'),box=2 WHERE word_id='box-two'",
                [],
            )
            .unwrap();
        let queue = db.get_review_queue(Some(10)).unwrap();
        let ids = queue
            .iter()
            .filter_map(|word| word.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["old", "box-one", "box-two"]);
        let state = db.submit_review("old", Answer::Correct).unwrap();
        assert_eq!(state["box"], 3);

        let mut paragraph = sample_word("paragraph-off", "Reader", "2026-08-01T12:00:00+08:00");
        paragraph["kind"] = Value::String("paragraph".into());
        db.save_word(&paragraph).unwrap();
        let off: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM review_state WHERE word_id='paragraph-off'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(off, 0);
        let mut settings = db.get_settings().unwrap();
        settings["includeLongFormReview"] = Value::Bool(true);
        db.save_settings(&settings).unwrap();
        paragraph["id"] = Value::String("paragraph-on".into());
        db.save_word(&paragraph).unwrap();
        let on: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM review_state WHERE word_id='paragraph-on'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(on, 1);
    }

    #[test]
    fn deleting_word_cascades_review_state() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        db.save_word(&sample_word("gone", "Reader", "2026-08-01T10:00:00+08:00"))
            .unwrap();
        db.delete_words(&["gone".into()]).unwrap();
        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM review_state WHERE word_id='gone'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn reading_sessions_split_by_gap_and_source() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        for word in [
            sample_word("a", "Reader", "2026-08-01T10:00:00+08:00"),
            sample_word("b", "Reader", "2026-08-01T10:20:00+08:00"),
            sample_word("c", "Reader", "2026-08-01T11:00:00+08:00"),
            sample_word("d", "Browser", "2026-08-01T11:05:00+08:00"),
        ] {
            db.save_word(&word).unwrap();
        }
        let sessions = db.get_reading_sessions(30, 20, 0).unwrap();
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[2]["wordCount"], 2);
        assert_eq!(sessions[0]["sourceApp"], "Browser");

        let reader_session = sessions[2]["id"].as_str().unwrap();
        assert_eq!(db.get_session_words(reader_session).unwrap().len(), 2);
        assert_eq!(db.get_reading_sessions(30, 1, 1).unwrap().len(), 1);
        assert_eq!(
            db.tag_session(reader_session, &["project-a".into()])
                .unwrap(),
            2
        );
        let tagged = db.get_session_words(reader_session).unwrap();
        assert!(tagged.iter().all(|word| word["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tag| tag == "project-a")));
        assert!(export_words(&tagged, "markdown").unwrap().contains("## a"));
        db.conn
            .execute("DELETE FROM review_state WHERE word_id IN ('a','b')", [])
            .unwrap();
        assert_eq!(db.add_session_to_review(reader_session).unwrap(), 2);
    }

    #[test]
    fn ten_thousand_words_meet_queue_and_session_budgets() {
        let db = Database::open_memory().unwrap();
        db.initialize().unwrap();
        // Filling the library is work of linear cost, which the two reads are measured against.
        let seeding_started = std::time::Instant::now();
        let tx = db.conn.unchecked_transaction().unwrap();
        {
            let mut insert_word = tx
                .prepare(
                    "INSERT INTO words (id,lemma,translation,pos,context_meaning,explanation,
                 source_app,source_title,mastery,kind,saved_at,updated_at,lookups,data)
                 VALUES (?1,?1,'','','','','Reader','Document','new','word',?2,?2,1,?3)",
                )
                .unwrap();
            let mut insert_review = tx
                .prepare(
                    "INSERT INTO review_state (word_id,box,due_at,created_at)
                 VALUES (?1,1,date('now','localtime'),datetime('now'))",
                )
                .unwrap();
            let base = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00+08:00").unwrap();
            for index in 0..10_000 {
                let id = format!("perf-{index}");
                let saved = (base + chrono::Duration::minutes(index)).to_rfc3339();
                let data = serde_json::json!({"id": id, "lemma": id}).to_string();
                insert_word.execute(params![id, saved, data]).unwrap();
                insert_review.execute(params![id]).unwrap();
            }
        }
        tx.commit().unwrap();
        let seeding = seeding_started.elapsed();

        let queue_started = std::time::Instant::now();
        assert_eq!(db.get_review_queue(Some(20)).unwrap().len(), 20);
        let queue = queue_started.elapsed();

        let sessions_started = std::time::Instant::now();
        assert!(!db.get_reading_sessions(30, 50, 0).unwrap().is_empty());
        let sessions = sessions_started.elapsed();

        println!(
            "ten thousand words: filled in {seeding:?}, queue {queue:?}, sessions {sessions:?}"
        );
        // Reading the library is far cheaper than writing it; a read that costs as much as
        // filling the whole library has gone quadratic.
        let budget = std::time::Duration::from_millis(500);
        assert_fast_enough("the review queue", queue, budget, seeding, 1);
        assert_fast_enough("the reading sessions", sessions, budget, seeding, 1);
    }
}
