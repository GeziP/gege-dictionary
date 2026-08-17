# Reliability Hardening Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for each independent task when delegation is available.

**Goal:** 修复鸽鸽词典当前审计确认的 P0/P1 正确性缺陷，使恢复、迁移、导入和前端状态在失败时保持可恢复且与数据库一致。

**Architecture:** 以数据库安全边界为中心：统一快照/只读 schema 契约校验，迁移与恢复在校验完成后原子切换；前端通过串行 patch 队列和统一 rehydrate 保持 context 与活动库一致；剪贴板和流式请求只补齐状态边界，不改变现有数据库 schema。

**Tech Stack:** Rust/Tauri 2, rusqlite 0.32, SQLite Online Backup, React 18, TypeScript, Vitest, React Testing Library, GitHub Actions.

## Global Constraints

- 不修改 schema 版本、不删除旧数据库/旧版备份、不引入遥测。
- 使用 `apply_patch` 编辑；显式路径检查，不使用破坏性 git 命令。
- 每项生产改动先添加一个会失败的回归测试，运行聚焦测试确认红，再实现最小修复并确认绿。
- 保留工作区既有 `.commit_msg.tmp` 删除，禁止将其加入暂存区。

## Task 1: Establish database safety regression tests

**Files:** `src-tauri/src/db.rs`, `src-tauri/src/migrations.rs`, `src-tauri/src/word_import.rs`

1. Add a restore test that creates a file with `user_version=3` but missing required tables/columns, asserts restore returns an error, and asserts current words/settings remain unchanged.
2. Add a migration test with an existing unrelated file in the target directory; assert migration fails without replacing the file or changing the active source.
3. Add a backup-path test that creates a pre-migration backup and asserts it is under the managed backup contract and is discoverable without pruning old files.
4. Add import tests for direct (non-preview) 10,001-row rejection and for a mapping target that attempts `id`/internal-field overwrite.
5. Run focused tests and record the expected failures before implementation:
   `cargo test --manifest-path src-tauri/Cargo.toml db::tests::restore_rejects_incomplete_schema -- --exact`,
   `cargo test --manifest-path src-tauri/Cargo.toml db::tests::migration_rejects_non_empty_target -- --exact`,
   `cargo test --manifest-path src-tauri/Cargo.toml word_import::tests -- --nocapture`.

## Task 2: Implement database validation, backups, migration, and restore safety

**Files:** `src-tauri/src/db.rs`, `src-tauri/src/migrations.rs`

1. Extract a read-only schema contract validator and make every snapshot/restore path call it after `integrity_check` and schema-version validation.
2. Keep Online Backup stepping at 64 pages with a 10 ms delay, use millisecond filenames, and remove incomplete targets on failure.
3. Require an empty migration target (after path normalization and source/target comparison), preserve unrelated files, and only switch the active connection after all validations and atomic pointer updates succeed.
4. Move pre-migration snapshots into the same managed backup directory/allowlist as other snapshots; stop automatic deletion of legacy backups.
5. Make restore-safety snapshots visible and recoverable, while retaining the rollback path when target restore validation fails.
6. Run the Task 1 focused tests, then the complete Rust suite and `cargo fmt --manifest-path src-tauri/Cargo.toml --check`.

## Task 3: Harden startup recovery and import command boundaries

**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/word_import.rs`, related Rust tests

1. Add a pure startup-directory decision test proving a configured directory without `gege.db`/legacy DB is not accepted.
2. Replace startup `expect` paths with explicit user-visible recovery errors; retry only accepts a directory containing an accessible database, while reset is explicit.
3. Enforce import row limits during actual parse/submit and whitelist mapping targets before any transaction begins.
4. Run focused Rust tests and the complete Rust suite.

## Task 4: Make restore/migration refresh the React context

**Files:** `src/contexts/LexNoteContext.tsx`, `src/components/settings/DataSection.tsx`, relevant frontend tests

1. Add a failing test that restores/migrates and then asserts words/settings/templates/usage and `dataDir` are reloaded.
2. Expose one context `refreshAppState` operation that rehydrates all data refs and visible aggregates.
3. Call it after successful restore and migration; update `settingsRef` together with React state.
4. Run the focused Vitest test, then all frontend tests.

## Task 5: Serialize settings saves and wire autostart truthfully

**Files:** `src/contexts/LexNoteContext.tsx`, `src/pages/Onboarding.tsx`, `src/components/settings/CaptureSection.tsx`, `src/lib/tauri-bridge.ts`, frontend tests

1. Add a failing test for two rapid setting patches where the first save rejects and the second succeeds; assert the failed patch is rolled back and the second patch persists.
2. Replace version-based stale-failure suppression with a confirmed snapshot plus ordered pending-patch queue. Save full snapshots for queued updates so no partial operation can acknowledge unsaved fields.
3. Add a failing onboarding autostart test for bridge failure; assert UI setting stays unchanged and error is visible.
4. Route onboarding and settings through the same bridge helper and update UI only after OS success.
5. Run focused and full Vitest/lint/typecheck commands.

## Task 6: Align clipboard, streaming terminal state, and CI gates

**Files:** `src-tauri/src/clipboard_watcher.rs`, `src-tauri/src/lib.rs`, `src/contexts/LexNoteContext.tsx`, `src/pages/Lookup.tsx`, `.github/workflows/release.yml`, `src/components/domain/DomainAnalysis.tsx`, frontend tests

1. Add a failing clipboard test for startup with an already-populated clipboard; assert the first unchanged sequence is ignored.
2. Initialize the watcher fingerprint from the current clipboard and add a single-terminal guard for stream error event plus invoke rejection.
3. Add a failing frontend test for “error after delta”; assert no second request and a retryable terminal error.
4. Fix the domain title type error and add release workflow commands for fmt, Vitest, and TypeScript no-emit.
5. Run focused tests followed by all Rust/frontend gates.

## Task 7: Final verification and iteration

1. Run fresh full commands:
   `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
   `cargo test --manifest-path src-tauri/Cargo.toml`
   `npm.cmd run lint`
   `npm.cmd test -- --run`
   `npm.cmd run typecheck`
   `npm.cmd run build`
2. Inspect `git diff --check`, `git status`, and the full diff; confirm `.commit_msg.tmp` remains the only pre-existing deletion and no real database/key was touched.
3. If any gate fails, add/adjust a regression test, fix the smallest cause, rerun the failed gate, then rerun the complete set.
4. Report exact evidence, remaining limitations, and whether a follow-up release/tag is appropriate; do not commit/push without an explicit later request.
