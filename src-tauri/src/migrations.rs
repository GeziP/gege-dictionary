use chrono::Local;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

pub const LATEST_SCHEMA_VERSION: i64 = 7;

const REVIEW_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS review_state (
    word_id TEXT PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
    box INTEGER NOT NULL DEFAULT 1 CHECK (box BETWEEN 1 AND 3),
    due_at TEXT NOT NULL,
    last_result TEXT,
    correct_count INTEGER NOT NULL DEFAULT 0,
    wrong_count INTEGER NOT NULL DEFAULT 0,
    reviewed_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_due ON review_state(due_at);
CREATE INDEX IF NOT EXISTS idx_review_box ON review_state(box);
"#;

const GLOSSARY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS glossary_terms (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    term_key TEXT NOT NULL,
    translation TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'general',
    note TEXT NOT NULL DEFAULT '',
    case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(term_key, domain)
);
CREATE INDEX IF NOT EXISTS idx_glossary_domain_enabled
ON glossary_terms(domain, enabled);
"#;

const LOCAL_EVENTS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS local_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    event TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    extra TEXT NOT NULL DEFAULT '{}',
    UNIQUE(date, event, extra)
);
CREATE INDEX IF NOT EXISTS idx_local_events_date ON local_events(date);
"#;

const ANKI_NOTE_ID_SCHEMA: &str = r#"
ALTER TABLE words ADD COLUMN anki_note_id TEXT;
CREATE INDEX IF NOT EXISTS idx_words_anki ON words(anki_note_id)
WHERE anki_note_id IS NOT NULL;
"#;

// One row per distinct lookup (by normalised text and kind), so looking the same word up
// again raises `lookup_count` instead of adding a row. `context` is kept so that reopening an
// entry asks the same question and is served from the cache.
const LOOKUP_HISTORY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS lookup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    history_key TEXT NOT NULL UNIQUE,
    selection TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    lemma TEXT NOT NULL DEFAULT '',
    translation TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'word',
    source_app TEXT NOT NULL DEFAULT '',
    source_title TEXT NOT NULL DEFAULT '',
    lookup_count INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookup_history_last_at ON lookup_history(last_at DESC);
"#;

// A third answer, "hard", is counted next to the right and wrong ones. `last_result` is free
// text, so it needs no change to hold the new answer.
const REVIEW_HARD_SCHEMA: &str = r#"
ALTER TABLE review_state ADD COLUMN hard_count INTEGER NOT NULL DEFAULT 0;
"#;

const MIGRATIONS: &[(i64, &str)] = &[
    (1, REVIEW_SCHEMA),
    (
        2,
        r#"
        INSERT OR IGNORE INTO review_state (word_id, box, due_at, created_at)
        SELECT id, 1,
               date('now', 'localtime', '+' || ((abs(rowid) % 7) + 1) || ' days'),
               datetime('now')
        FROM words
        WHERE kind IN ('word', 'phrase');
        "#,
    ),
    (3, GLOSSARY_SCHEMA),
    (4, LOCAL_EVENTS_SCHEMA),
    (5, ANKI_NOTE_ID_SCHEMA),
    (6, LOOKUP_HISTORY_SCHEMA),
    (7, REVIEW_HARD_SCHEMA),
];

pub fn current_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("读取 schema 版本失败: {e}"))
}

pub fn initialize_latest(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "{REVIEW_SCHEMA}\n{GLOSSARY_SCHEMA}\n{LOCAL_EVENTS_SCHEMA}\n{LOOKUP_HISTORY_SCHEMA}"
    ))
    .map_err(|e| format!("创建最新 schema 失败: {e}"))?;
    // Columns that were added to a table after it was first created (the `ALTER TABLE` of a
    // migration cannot be part of the `CREATE TABLE` above, which the first migration runs too).
    add_column_if_missing(conn, "words", "anki_note_id", ANKI_NOTE_ID_SCHEMA)?;
    add_column_if_missing(conn, "review_state", "hard_count", REVIEW_HARD_SCHEMA)?;
    conn.pragma_update(None, "user_version", LATEST_SCHEMA_VERSION)
        .map_err(|e| format!("写入 schema 版本失败: {e}"))
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    add: &str,
) -> Result<(), String> {
    let exists = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            [table, column],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("检查 {table}.{column} 失败: {e}"))?
        > 0;
    if exists {
        return Ok(());
    }
    conn.execute_batch(add)
        .map_err(|e| format!("创建 {table}.{column} 失败: {e}"))
}

pub fn migrate(conn: &Connection, db_path: &str) -> Result<Option<PathBuf>, String> {
    migrate_with(conn, db_path, MIGRATIONS)
}

fn migrate_with(
    conn: &Connection,
    db_path: &str,
    migrations: &[(i64, &str)],
) -> Result<Option<PathBuf>, String> {
    let from = current_version(conn)?;
    if from >= LATEST_SCHEMA_VERSION {
        return Ok(None);
    }

    conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
        .map_err(|e| format!("迁移前写入 WAL 失败: {e}"))?;
    let backup = create_premigration_backup(db_path, from)?;
    eprintln!("[migration] schema migration started: v{from} -> v{LATEST_SCHEMA_VERSION}");

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始迁移事务失败（备份：{}）: {e}", backup.display()))?;
    let result = (|| -> Result<(), rusqlite::Error> {
        for (version, sql) in migrations.iter().filter(|(version, _)| *version > from) {
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = tx.rollback();
        eprintln!("[migration] schema migration failed: {error}");
        return Err(format!(
            "数据库升级失败，已回滚到原版本。迁移前备份：{}。原因：{error}",
            backup.display()
        ));
    }
    tx.commit().map_err(|e| {
        format!(
            "提交数据库升级失败，迁移前备份：{}。原因：{e}",
            backup.display()
        )
    })?;
    eprintln!("[migration] schema migration completed: v{LATEST_SCHEMA_VERSION}");
    Ok(Some(backup))
}

fn create_premigration_backup(db_path: &str, from_version: i64) -> Result<PathBuf, String> {
    if db_path.is_empty() || !Path::new(db_path).exists() {
        return Ok(PathBuf::from("<memory>"));
    }
    let db_path = Path::new(db_path);
    let dir = db_path.parent().ok_or("无法定位数据库目录")?;
    let backup_dir = dir.join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("migration backup directory failed: {e}"))?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S-%3f");
    let mut backup = backup_dir.join(format!("gege-premigrate-v{from_version}-{stamp}.db"));
    let mut suffix = 1_u32;
    while backup.exists() {
        backup = backup_dir.join(format!(
            "gege-premigrate-v{from_version}-{stamp}-{suffix:03}.db"
        ));
        suffix += 1;
    }
    crate::db::snapshot_connection(
        &Connection::open(db_path)
            .map_err(|e| format!("打开迁移前数据库失败（{}）: {e}", db_path.display()))?,
        &backup,
        false,
    )
    .map_err(|e| format!("创建迁移前备份失败（{}）: {e}", backup.display()))?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_from_zero_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE words (id TEXT PRIMARY KEY, kind TEXT, saved_at TEXT);")
            .unwrap();
        migrate(&conn, "").unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);
        let first_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_state", [], |row| row.get(0))
            .unwrap();
        assert!(migrate(&conn, "").unwrap().is_none());
        let second_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(first_count, second_count);
        let events_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_events')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(events_exists);
        let anki_col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('words') WHERE name='anki_note_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(anki_col, 1);
        assert!(review_columns(&conn).contains(&"hard_count".to_string()));
    }

    #[test]
    fn failed_migration_rolls_back_version_and_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE words (id TEXT PRIMARY KEY, kind TEXT, saved_at TEXT);")
            .unwrap();
        let broken = [
            (1, "CREATE TABLE transient_test(id INTEGER);"),
            (2, "INVALID SQL"),
        ];
        assert!(migrate_with(&conn, "", &broken).is_err());
        assert_eq!(current_version(&conn).unwrap(), 0);
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='transient_test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 0);
    }

    #[test]
    fn new_database_starts_at_latest_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE words (id TEXT PRIMARY KEY);")
            .unwrap();
        initialize_latest(&conn).unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);
    }

    #[test]
    fn upgrades_v2_without_changing_learning_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE words (id TEXT PRIMARY KEY, kind TEXT, saved_at TEXT);
             INSERT INTO words VALUES ('kept', 'word', '2026-08-01');",
        )
        .unwrap();
        conn.execute_batch(REVIEW_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO review_state (word_id,box,due_at,created_at) VALUES ('kept',2,'2026-08-10','2026-08-01')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        migrate(&conn, "").unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);
        assert_eq!(
            conn.query_row(
                "SELECT box FROM review_state WHERE word_id='kept'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            2
        );
        let glossary_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='glossary_terms')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(glossary_exists);
    }

    #[test]
    fn upgrades_v3_with_local_events_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE words (id TEXT PRIMARY KEY, kind TEXT, saved_at TEXT);
             CREATE TABLE review_state (word_id TEXT PRIMARY KEY, box INTEGER, due_at TEXT, last_result TEXT, correct_count INTEGER, wrong_count INTEGER, reviewed_at TEXT, created_at TEXT);
             CREATE TABLE glossary_terms (id TEXT PRIMARY KEY, term TEXT, term_key TEXT, translation TEXT, domain TEXT, note TEXT, case_sensitive INTEGER, enabled INTEGER, created_at TEXT, updated_at TEXT);
             INSERT INTO words VALUES ('kept', 'word', '2026-08-01');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        migrate(&conn, "").unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_events')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(exists);
    }

    /// A database as an earlier version left it: one word, and the review table (with that
    /// word's progress in it) which every version since the first migration has had.
    fn database_at(version: i64) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE words (id TEXT PRIMARY KEY, kind TEXT, saved_at TEXT);
             INSERT INTO words VALUES ('kept', 'word', '2026-08-01');",
        )
        .unwrap();
        conn.execute_batch(REVIEW_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO review_state
                 (word_id, box, due_at, last_result, correct_count, wrong_count, reviewed_at, created_at)
             VALUES ('kept', 2, '2026-08-10', 'correct', 4, 1, '2026-08-09', '2026-08-01')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        conn
    }

    fn review_columns(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info('review_state') ORDER BY cid")
            .unwrap();
        stmt.query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn upgrades_v4_with_anki_note_id_column() {
        let conn = database_at(4);
        migrate(&conn, "").unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);
        let col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('words') WHERE name='anki_note_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(col, 1);
    }

    fn history_columns(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info('lookup_history') ORDER BY cid")
            .unwrap();
        stmt.query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn upgrades_v5_with_lookup_history_and_keeps_existing_words() {
        let conn = database_at(5);
        migrate(&conn, "").unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);
        assert_eq!(
            history_columns(&conn),
            [
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
                "last_at"
            ]
        );
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM words WHERE id='kept'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, 1);
    }

    #[test]
    fn a_new_database_has_the_history_table_too() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE words (id TEXT PRIMARY KEY);")
            .unwrap();
        initialize_latest(&conn).unwrap();
        assert!(history_columns(&conn).contains(&"history_key".to_string()));
        // The same text and kind is one row: `history_key` is unique.
        let insert = "INSERT INTO lookup_history (history_key, selection, first_at, last_at)
                      VALUES ('run\u{1f}word', 'run', 't', 't')";
        conn.execute(insert, []).unwrap();
        assert!(conn.execute(insert, []).is_err());
    }

    #[test]
    fn upgrades_v6_with_a_hard_count_and_keeps_the_review_progress() {
        let conn = database_at(6);
        migrate(&conn, "").unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_SCHEMA_VERSION);

        let (box_number, correct, wrong, hard, last): (i64, i64, i64, i64, String) = conn
            .query_row(
                "SELECT box, correct_count, wrong_count, hard_count, last_result
                 FROM review_state WHERE word_id='kept'",
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
        assert_eq!(
            (box_number, correct, wrong, last.as_str()),
            (2, 4, 1, "correct"),
            "what was learned is kept"
        );
        assert_eq!(hard, 0, "no card was ever answered as hard before");
        // Cards that start being reviewed after the upgrade begin at zero as well.
        conn.execute_batch(
            "INSERT INTO words VALUES ('later', 'word', '2026-09-01');
             INSERT INTO review_state (word_id, box, due_at, created_at)
             VALUES ('later', 1, '2026-09-02', '2026-09-01');",
        )
        .unwrap();
        let later: i64 = conn
            .query_row(
                "SELECT hard_count FROM review_state WHERE word_id='later'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(later, 0);
    }

    #[test]
    fn a_new_database_has_the_hard_count_too() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE words (id TEXT PRIMARY KEY);")
            .unwrap();
        initialize_latest(&conn).unwrap();
        assert!(review_columns(&conn).contains(&"hard_count".to_string()));
        // Setting the database up a second time (a restart) neither fails nor adds it twice.
        initialize_latest(&conn).unwrap();
        assert_eq!(
            review_columns(&conn)
                .iter()
                .filter(|name| name.as_str() == "hard_count")
                .count(),
            1
        );
    }

    #[test]
    fn a_failed_upgrade_to_v7_leaves_the_database_at_v6_with_its_progress() {
        let conn = database_at(6);
        // The column being there already is a step that cannot be applied.
        conn.execute_batch(REVIEW_HARD_SCHEMA).unwrap();

        let error = migrate(&conn, "").unwrap_err();

        assert!(error.contains("已回滚"), "{error}");
        assert_eq!(current_version(&conn).unwrap(), 6);
        let box_number: i64 = conn
            .query_row(
                "SELECT box FROM review_state WHERE word_id='kept'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(box_number, 2);
    }

    #[test]
    fn premigration_backup_uses_managed_backup_directory() {
        let dir = std::env::temp_dir().join(format!(
            "gege-migration-managed-backup-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("gege.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE words (id TEXT PRIMARY KEY, kind TEXT, saved_at TEXT);")
            .unwrap();

        let backup = create_premigration_backup(db_path.to_str().unwrap(), 0).unwrap();
        assert_eq!(backup.parent(), Some(dir.join("backups").as_path()));
        assert!(backup.exists());
        // Windows cannot remove a folder while a connection still holds a file in it open.
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
