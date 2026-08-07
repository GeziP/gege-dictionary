use rusqlite::{params, Connection, Result as SqlResult};
use serde_json::Value;

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

        self.ensure_default_settings()?;
        self.ensure_default_templates()?;
        Ok(())
    }

    fn ensure_default_settings(&self) -> Result<(), String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='app'", [], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;

        if count == 0 {
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
            self.conn
                .execute(
                    "INSERT INTO settings (key, value) VALUES ('app', ?1)",
                    params![defaults.to_string()],
                )
                .map_err(|e| e.to_string())?;
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
        let placeholders: Vec<String> = ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
        let sql = format!(
            "SELECT data FROM words WHERE id IN ({}) ORDER BY saved_at DESC",
            placeholders.join(",")
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
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
        let translation = word.get("translation").and_then(|v| v.as_str()).unwrap_or("");
        let pos = word.get("pos").and_then(|v| v.as_str()).unwrap_or("");
        let context_meaning = word.get("contextMeaning").and_then(|v| v.as_str()).unwrap_or("");
        let explanation = word.get("explanation").and_then(|v| v.as_str()).unwrap_or("");
        let source_app = word.get("sourceApp").and_then(|v| v.as_str()).unwrap_or("");
        let source_title = word.get("sourceTitle").and_then(|v| v.as_str()).unwrap_or("");
        let mastery = word.get("mastery").and_then(|v| v.as_str()).unwrap_or("new");
        let kind = word.get("kind").and_then(|v| v.as_str()).unwrap_or("word");
        let saved_at = word.get("savedAt").and_then(|v| v.as_str()).unwrap_or("");
        let lookups = word.get("lookups").and_then(|v| v.as_u64()).unwrap_or(1) as i64;
        let now = chrono::Utc::now().to_rfc3339();
        let saved = if saved_at.is_empty() { &now } else { saved_at };

        self.conn
            .execute(
                "INSERT OR REPLACE INTO words (id, lemma, translation, pos, context_meaning, explanation, source_app, source_title, mastery, kind, saved_at, updated_at, lookups, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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

        Ok(())
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
        match self.conn.query_row(
            "SELECT value FROM settings WHERE key = 'app'",
            [],
            |row| row.get::<_, String>(0),
        ) {
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

    pub fn get_cache(&self, key: &str) -> Result<Option<Value>, String> {
        let result: SqlResult<String> = self.conn.query_row(
            "SELECT response FROM cache WHERE cache_key = ?1 AND created_at > datetime('now', '-30 days')",
            params![key],
            |row| row.get(0),
        );
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

        Ok(serde_json::json!({
            "wordCount": word_count,
            "tagCount": tag_count,
            "cacheCount": cache_count,
        }))
    }
}

pub fn backup_database(db_path: &str) -> Result<String, String> {
    let db_dir = std::path::Path::new(db_path)
        .parent()
        .ok_or("Cannot determine database directory")?;
    let backups_dir = db_dir.join("backups");
    std::fs::create_dir_all(&backups_dir)
        .map_err(|e| format!("创建备份目录失败: {e}"))?;

    let now = chrono::Local::now();
    let backup_name = format!("lexnote-{}.db", now.format("%Y-%m-%d_%H%M%S"));
    let backup_path = backups_dir.join(&backup_name);

    std::fs::copy(db_path, &backup_path)
        .map_err(|e| format!("备份文件复制失败: {e}"))?;

    Ok(backup_name)
}

pub fn list_backups(db_path: &str) -> Result<Vec<Value>, String> {
    let db_dir = std::path::Path::new(db_path)
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
    let db_dir = std::path::Path::new(db_path)
        .parent()
        .ok_or("Cannot determine database directory")?;
    let backup_path = db_dir.join("backups").join(backup_name);

    if !backup_path.exists() {
        return Err(format!("备份文件不存在: {}", backup_name));
    }

    backup_database(db_path)?;

    std::fs::copy(&backup_path, db_path)
        .map_err(|e| format!("恢复失败: {e}"))?;

    Ok(())
}

pub fn change_data_dir(old_path: &str, new_dir: &str) -> Result<String, String> {
    let new_dir_path = std::path::Path::new(new_dir);
    std::fs::create_dir_all(new_dir_path)
        .map_err(|e| format!("创建目标目录失败: {e}"))?;

    let new_db_path = new_dir_path.join("lexnote.db");
    if new_db_path.exists() {
        return Err("目标目录已存在 lexnote.db 文件，请选择空目录或先删除该文件".to_string());
    }

    let old_dir = std::path::Path::new(old_path).parent().ok_or("无法解析原目录")?;
    let old_backups = old_dir.join("backups");

    std::fs::copy(old_path, &new_db_path)
        .map_err(|e| format!("复制数据库失败: {e}"))?;

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
    std::path::Path::new(db_path)
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
            let mut lines = vec!["lemma,translation,pos,context_meaning,source,tags,saved_at".to_string()];
            for w in words {
                let lemma = w.get("lemma").and_then(|v| v.as_str()).unwrap_or("");
                let tr = w.get("translation").and_then(|v| v.as_str()).unwrap_or("");
                let pos = w.get("pos").and_then(|v| v.as_str()).unwrap_or("");
                let cm = w.get("contextMeaning").and_then(|v| v.as_str()).unwrap_or("");
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
                let cm = w.get("contextMeaning").and_then(|v| v.as_str()).unwrap_or("");
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
                let cm = w.get("contextMeaning").and_then(|v| v.as_str()).unwrap_or("");
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
                lines.push(format!("{}\t{}", front.replace('\t', " "), back.replace('\t', " ")));
            }
            Ok(lines.join("\n"))
        }
        _ => Err(format!("Unknown format: {format}")),
    }
}
