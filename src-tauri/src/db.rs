use crate::glossary::{self, GlossaryTerm};
use rusqlite::{params, params_from_iter, Connection, Result as SqlResult, Row};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DB_FILENAME: &str = "gege.db";
pub const LEGACY_DB_FILENAME: &str = "lexnote.db";
pub const DATA_DIR_POINTER_FILENAME: &str = "data-dir.txt";

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

/// Resolve the configured data directory from a small pointer file kept in the
/// default application directory. The pointer is deliberately stored outside
/// the database so a moved database can still be found on the next launch.
pub fn resolve_configured_data_dir(default_dir: &Path) -> PathBuf {
    let pointer = default_dir.join(DATA_DIR_POINTER_FILENAME);
    let Ok(raw) = std::fs::read_to_string(pointer) else {
        return default_dir.to_path_buf();
    };
    let configured = PathBuf::from(raw.trim());
    if configured.is_dir() {
        configured
    } else {
        eprintln!("[db] Configured data directory is unavailable; using default directory");
        default_dir.to_path_buf()
    }
}

pub fn persist_configured_data_dir(default_dir: &Path, data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(default_dir).map_err(|e| format!("创建默认数据目录失败: {e}"))?;
    std::fs::write(
        default_dir.join(DATA_DIR_POINTER_FILENAME),
        data_dir.to_string_lossy().as_bytes(),
    )
    .map_err(|e| format!("保存数据目录配置失败: {e}"))
}

/// Resolve the database file path with legacy compatibility.
/// 1. If `gege.db` exists in dir, return it.
/// 2. If only `lexnote.db` exists, rename it to `gege.db` and return.
/// 3. Otherwise return `gege.db` (will be created).
pub fn resolve_db_path(data_dir: &Path) -> PathBuf {
    let primary = data_dir.join(DB_FILENAME);
    if primary.exists() {
        return primary;
    }
    let legacy = data_dir.join(LEGACY_DB_FILENAME);
    if legacy.exists() {
        eprintln!(
            "[db] Migrating legacy database: {} -> {}",
            legacy.display(),
            primary.display()
        );
        if let Err(e) = std::fs::rename(&legacy, &primary) {
            eprintln!("[db] Rename failed, copying instead: {e}");
            if let Err(e2) = std::fs::copy(&legacy, &primary) {
                eprintln!("[db] Copy also failed: {e2}, using legacy path");
                return legacy;
            }
        }
        return primary;
    }
    primary
}

pub struct Database {
    conn: Connection,
    path: String,
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

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("Memory DB error: {e}"))?;
        Ok(Self {
            conn,
            path: String::new(),
        })
    }

    pub fn path(&self) -> &str {
        &self.path
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

            CREATE INDEX IF NOT EXISTS idx_words_lemma ON words(lemma);
            CREATE INDEX IF NOT EXISTS idx_words_saved_at ON words(saved_at);
            CREATE INDEX IF NOT EXISTS idx_words_mastery ON words(mastery);
            CREATE INDEX IF NOT EXISTS idx_words_source ON words(source_app);

            CREATE TABLE IF NOT EXISTS word_tags (
                word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
                tag TEXT NOT NULL,
                PRIMARY KEY (word_id, tag)
            );

            CREATE INDEX IF NOT EXISTS idx_word_tags_tag ON word_tags(tag);

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
            .map_err(|e| format!("DB init error: {e}"))?;

        if existing_database {
            crate::migrations::migrate(&self.conn, &self.path)?;
        } else {
            crate::migrations::initialize_latest(&self.conn)?;
        }

        self.ensure_default_settings()?;
        self.ensure_default_templates()?;
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
            "streamingEnabled": true,
            "cacheTtlDays": 30,
            "reviewLimit": 20,
            "includeLongFormReview": false,
            "sessionGapMinutes": 30,
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
            "anonymousStats": false,
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

    pub fn save_word(&self, word: &Value) -> Result<(), String> {
        let id = word.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let lemma = word.get("lemma").and_then(|v| v.as_str()).unwrap_or("");
        let translation = word
            .get("translation")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let pos = word.get("pos").and_then(|v| v.as_str()).unwrap_or("");
        let context_meaning = word
            .get("contextMeaning")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let explanation = word
            .get("explanation")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let source_app = word.get("sourceApp").and_then(|v| v.as_str()).unwrap_or("");
        let source_title = word
            .get("sourceTitle")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mastery = word
            .get("mastery")
            .and_then(|v| v.as_str())
            .unwrap_or("new");
        let kind = word.get("kind").and_then(|v| v.as_str()).unwrap_or("word");
        let saved_at = word.get("savedAt").and_then(|v| v.as_str()).unwrap_or("");
        let lookups = word.get("lookups").and_then(|v| v.as_u64()).unwrap_or(1) as i64;
        let now = chrono::Utc::now().to_rfc3339();
        let saved = if saved_at.is_empty() { &now } else { saved_at };

        self.conn
            .execute(
                "INSERT INTO words (id, lemma, translation, pos, context_meaning, explanation, source_app, source_title, mastery, kind, saved_at, updated_at, lookups, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET
                   lemma=excluded.lemma, translation=excluded.translation, pos=excluded.pos,
                   context_meaning=excluded.context_meaning, explanation=excluded.explanation,
                   source_app=excluded.source_app, source_title=excluded.source_title,
                   mastery=excluded.mastery, kind=excluded.kind, updated_at=excluded.updated_at,
                   lookups=excluded.lookups, data=excluded.data",
                params![
                    id,
                    lemma,
                    translation,
                    pos,
                    context_meaning,
                    explanation,
                    source_app,
                    source_title,
                    mastery,
                    kind,
                    saved,
                    now,
                    lookups,
                    word.to_string(),
                ],
            )
            .map_err(|e| e.to_string())?;

        self.conn
            .execute("DELETE FROM word_tags WHERE word_id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        if let Some(tags) = word.get("tags").and_then(|v| v.as_array()) {
            for tag in tags {
                if let Some(tag_str) = tag.as_str() {
                    self.conn
                        .execute(
                            "INSERT OR IGNORE INTO word_tags (word_id, tag) VALUES (?1, ?2)",
                            params![id, tag_str],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
        }

        let include_long_form = self
            .get_settings()
            .ok()
            .and_then(|settings| {
                settings
                    .get("includeLongFormReview")
                    .and_then(|value| value.as_bool())
            })
            .unwrap_or(false);
        if matches!(kind, "word" | "phrase") || include_long_form {
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO review_state (word_id, box, due_at, created_at)
                     VALUES (?1, 1, date('now', 'localtime', '+1 day'), datetime('now'))",
                    params![id],
                )
                .map_err(|e| format!("创建复习记录失败: {e}"))?;
        }

        Ok(())
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
                    r.correct_count, r.wrong_count, r.reviewed_at
             FROM review_state r JOIN words w ON w.id = r.word_id
             WHERE date(r.due_at) <= date('now', 'localtime')
             ORDER BY date(r.due_at) ASC, r.box ASC, datetime(w.saved_at) ASC"
                .to_string()
        } else {
            format!(
                "SELECT w.data, r.word_id, r.box, r.due_at, r.last_result,
                        r.correct_count, r.wrong_count, r.reviewed_at
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

    pub fn submit_review(&self, word_id: &str, correct: bool) -> Result<Value, String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let (current_box, correct_count, wrong_count): (i64, i64, i64) = tx
            .query_row(
                "SELECT box, correct_count, wrong_count FROM review_state WHERE word_id=?1",
                params![word_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| format!("复习记录不存在: {e}"))?;
        let next_box = if correct { (current_box + 1).min(3) } else { 1 };
        let days = match next_box {
            1 => 1,
            2 => 3,
            _ => 7,
        };
        let mastery = match next_box {
            1 => "new",
            2 => "learning",
            _ => "mastered",
        };
        let result = if correct { "correct" } else { "wrong" };
        tx.execute(
            "UPDATE review_state SET box=?2, due_at=date('now','localtime',?3),
                    last_result=?4, correct_count=?5, wrong_count=?6,
                    reviewed_at=datetime('now','localtime') WHERE word_id=?1",
            params![
                word_id,
                next_box,
                format!("+{days} days"),
                result,
                correct_count + i64::from(correct),
                wrong_count + i64::from(!correct)
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
            "correctCount": correct_count + i64::from(correct),
            "wrongCount": wrong_count + i64::from(!correct),
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
               correct_count=0,wrong_count=0,reviewed_at=NULL",
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
        let ids = self.session_word_ids(session_id)?;
        for id in &ids {
            let raw: String = self
                .conn
                .query_row("SELECT data FROM words WHERE id=?1", params![id], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            let mut word: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let mut merged = word
                .get("tags")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for tag in tags {
                if !merged.iter().any(|value| value.as_str() == Some(tag)) {
                    merged.push(Value::String(tag.clone()));
                }
            }
            word.as_object_mut()
                .map(|object| object.insert("tags".into(), Value::Array(merged)));
            self.save_word(&word)?;
        }
        Ok(ids.len() as u32)
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

    pub fn delete_words(&self, ids: &[String]) -> Result<(), String> {
        for id in ids {
            self.conn
                .execute("DELETE FROM words WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
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
        self.conn
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?1)",
                params![settings.to_string()],
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

    pub fn increment_usage(&self, tokens: u32) -> Result<(), String> {
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

        Ok(serde_json::json!({
            "wordCount": word_count,
            "tagCount": tag_count,
            "cacheCount": cache_count,
            "cacheSizeBytes": cache_size_bytes,
        }))
    }
}

pub fn backup_database(db_path: &str) -> Result<String, String> {
    let db_dir = Path::new(db_path)
        .parent()
        .ok_or("Cannot determine database directory")?;
    let backups_dir = db_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let now = chrono::Local::now();
    let backup_name = format!("gege-backup-{}.db", now.format("%Y%m%d-%H%M%S"));
    let backup_path = backups_dir.join(&backup_name);

    std::fs::copy(db_path, &backup_path).map_err(|e| format!("备份文件复制失败: {e}"))?;

    Ok(backup_name)
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
            if !name.ends_with(".db") {
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
            }))
        })
        .collect();

    backups.sort_by(|a, b| {
        let ta = a.get("modifiedTs").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("modifiedTs").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });

    let max_backups = 10;
    if backups.len() > max_backups {
        for old in &backups[max_backups..] {
            if let Some(path) = old.get("path").and_then(|v| v.as_str()) {
                let _ = std::fs::remove_file(path);
            }
        }
        backups.truncate(max_backups);
    }

    Ok(backups)
}

pub fn restore_backup(db_path: &str, backup_name: &str) -> Result<(), String> {
    let db_dir = Path::new(db_path)
        .parent()
        .ok_or("Cannot determine database directory")?;
    let backup_path = db_dir.join("backups").join(backup_name);

    if !backup_path.exists() {
        return Err(format!("备份文件不存在: {}", backup_name));
    }

    backup_database(db_path)?;

    std::fs::copy(&backup_path, db_path).map_err(|e| format!("恢复失败: {e}"))?;

    Ok(())
}

pub fn change_data_dir(old_path: &str, new_dir: &str) -> Result<String, String> {
    let new_dir_path = Path::new(new_dir);
    std::fs::create_dir_all(new_dir_path).map_err(|e| format!("创建目标目录失败: {e}"))?;

    let new_db_path = new_dir_path.join(DB_FILENAME);
    if new_db_path.exists() {
        return Err(format!(
            "目标目录已存在 {} 文件，请选择空目录或先删除该文件",
            DB_FILENAME
        ));
    }

    // Also check for legacy filename
    let legacy_in_target = new_dir_path.join(LEGACY_DB_FILENAME);
    if legacy_in_target.exists() {
        return Err(format!(
            "目标目录已存在 {} 文件（旧版本数据），请选择空目录",
            LEGACY_DB_FILENAME
        ));
    }

    let old_dir = Path::new(old_path).parent().ok_or("无法解析原目录")?;
    let old_backups = old_dir.join("backups");

    std::fs::copy(old_path, &new_db_path).map_err(|e| format!("复制数据库失败: {e}"))?;

    // Verify integrity of copied database
    let verify_conn = Connection::open(&new_db_path).map_err(|e| {
        let _ = std::fs::remove_file(&new_db_path);
        format!("验证新数据库失败: {e}")
    })?;
    let integrity: String = verify_conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| {
            let _ = std::fs::remove_file(&new_db_path);
            format!("完整性检查失败: {e}")
        })?;
    drop(verify_conn);
    if integrity != "ok" {
        let _ = std::fs::remove_file(&new_db_path);
        return Err(format!("数据库完整性检查未通过: {integrity}"));
    }

    if old_backups.exists() {
        let new_backups = new_dir_path.join("backups");
        let _ = std::fs::create_dir_all(&new_backups);
        if let Ok(entries) = std::fs::read_dir(&old_backups) {
            for entry in entries.flatten() {
                let dest = new_backups.join(entry.file_name());
                let _ = std::fs::copy(entry.path(), dest);
            }
        }
    }

    Ok(new_db_path.to_string_lossy().to_string())
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
    fn resolves_and_renames_legacy_database() {
        let dir = TestDir::new("legacy");
        std::fs::write(dir.0.join(LEGACY_DB_FILENAME), b"legacy").unwrap();
        let resolved = resolve_db_path(&dir.0);
        assert_eq!(resolved, dir.0.join(DB_FILENAME));
        assert!(resolved.exists());
        assert!(!dir.0.join(LEGACY_DB_FILENAME).exists());
    }

    #[test]
    fn persists_custom_data_directory_pointer() {
        let root = TestDir::new("pointer");
        let default_dir = root.0.join("default");
        let custom_dir = root.0.join("custom");
        std::fs::create_dir_all(&custom_dir).unwrap();
        persist_configured_data_dir(&default_dir, &custom_dir).unwrap();
        assert_eq!(resolve_configured_data_dir(&default_dir), custom_dir);
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
        db.save_settings(&serde_json::json!({"provider": {"apiKey": ""}, "theme": "dark"}))
            .unwrap();
        db.initialize().unwrap();
        let settings = db.get_settings().unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["reviewLimit"], 20);
        assert_eq!(settings["sessionGapMinutes"], 30);
        assert_eq!(settings["autoCheckUpdates"], true);
        assert_eq!(settings["activeDomainProfile"], "general");
        assert_eq!(settings["analysisStyle"], "standard");
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
        let tx = db.conn.unchecked_transaction().unwrap();
        for index in 0..10_000 {
            tx.execute(
                "INSERT INTO glossary_terms (id,term,term_key,translation,domain,note,case_sensitive,enabled,created_at,updated_at) VALUES (?1,?2,?2,?3,'general','',0,1,'now','now')",
                params![format!("g-{index}"), format!("term{index}"), format!("译法{index}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let started = std::time::Instant::now();
        let matched = db
            .find_glossary_matches("term9999", "unrelated context", "general")
            .unwrap();
        assert_eq!(matched.len(), 1);
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        assert_eq!(
            db.list_glossary_terms(None, None, 20, 0).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            20
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
        let state = db.submit_review("alpha", true).unwrap();
        assert_eq!(state["box"], 2);
        assert_eq!(state["lastResult"], "correct");
        db.conn
            .execute(
                "UPDATE review_state SET due_at=date('now','localtime') WHERE word_id='alpha'",
                [],
            )
            .unwrap();
        let state = db.submit_review("alpha", false).unwrap();
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
        let state = db.submit_review("old", true).unwrap();
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

        let queue_started = std::time::Instant::now();
        assert_eq!(db.get_review_queue(Some(20)).unwrap().len(), 20);
        assert!(
            queue_started.elapsed().as_millis() < 200,
            "review queue exceeded 200ms"
        );

        let sessions_started = std::time::Instant::now();
        assert!(!db.get_reading_sessions(30, 50, 0).unwrap().is_empty());
        assert!(
            sessions_started.elapsed().as_millis() < 500,
            "session aggregation exceeded 500ms"
        );
    }
}
