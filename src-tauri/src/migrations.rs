use chrono::Local;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub const LATEST_SCHEMA_VERSION: i64 = 3;

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
];

pub fn current_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("读取 schema 版本失败: {e}"))
}

pub fn initialize_latest(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!("{REVIEW_SCHEMA}\n{GLOSSARY_SCHEMA}"))
        .map_err(|e| format!("创建最新 schema 失败: {e}"))?;
    conn.pragma_update(None, "user_version", LATEST_SCHEMA_VERSION)
        .map_err(|e| format!("写入 schema 版本失败: {e}"))
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
    let stamp = Local::now().format("%Y%m%d-%H%M%S-%3f");
    let mut backup = dir.join(format!("gege-premigrate-v{from_version}-{stamp}.db"));
    let mut suffix = 1_u32;
    while backup.exists() {
        backup = dir.join(format!(
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
    prune_premigration_backups(dir)?;
    Ok(backup)
}

fn prune_premigration_backups(dir: &Path) -> Result<(), String> {
    let mut backups = std::fs::read_dir(dir)
        .map_err(|e| format!("读取迁移备份目录失败: {e}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("gege-premigrate-v")
        })
        .collect::<Vec<_>>();
    backups.sort_by_key(|entry| entry.file_name());
    let remove_count = backups.len().saturating_sub(3);
    for entry in backups.into_iter().take(remove_count) {
        std::fs::remove_file(entry.path())
            .map_err(|e| format!("清理旧迁移备份失败（{}）: {e}", entry.path().display()))?;
    }
    Ok(())
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
        assert_eq!(current_version(&conn).unwrap(), 3);
        let first_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_state", [], |row| row.get(0))
            .unwrap();
        assert!(migrate(&conn, "").unwrap().is_none());
        let second_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(first_count, second_count);
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
        assert_eq!(current_version(&conn).unwrap(), 3);
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
    fn premigration_backups_are_pruned_to_three() {
        let dir = std::env::temp_dir().join(format!("gege-migration-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("gege.db");
        std::fs::write(&db_path, b"database").unwrap();
        for version in 0..5 {
            let name = dir.join(format!(
                "gege-premigrate-v{version}-2026080{}-000000.db",
                version + 1
            ));
            std::fs::write(name, b"backup").unwrap();
        }
        prune_premigration_backups(&dir).unwrap();
        let count = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("gege-premigrate-v")
            })
            .count();
        assert_eq!(count, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
