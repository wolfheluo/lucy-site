// =====================================================================
//  SQLite 開檔與 migration（better-sqlite3，同步 API）
//  - 單一 db 檔 data/vault.db，WAL 模式
//  - schema 集中管理；各 tool 的表格在此註冊 migration
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "vault.db"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

const MIGRATIONS: string[] = [
  // ── rate limiting（login / pin 共用）──────────────────────────────
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key         TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count       INTEGER NOT NULL
  )`,
  // ── file vault 檔案（含分享欄位，一檔一分享）──────────────────────
  `CREATE TABLE IF NOT EXISTS vault_files (
    id            TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL,
    size          INTEGER NOT NULL,
    upload_time   INTEGER NOT NULL,   -- epoch ms (UTC)
    expire_time   INTEGER NOT NULL,   -- epoch ms (UTC)
    share_id      TEXT,
    share_pin     TEXT,
    share_created_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vault_expire ON vault_files(expire_time)`,
  `CREATE INDEX IF NOT EXISTS idx_vault_share ON vault_files(share_id)`,
];

export function migrate(db: Db): void {
  db.exec("BEGIN");
  try {
    for (const sql of MIGRATIONS) db.exec(sql);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
