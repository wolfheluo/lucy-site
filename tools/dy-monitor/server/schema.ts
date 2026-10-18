// =====================================================================
//  dy-monitor SQLite schema（獨立 DB：data/dy-monitor.db）
//  - 刻意不進 server/db.ts 的 MIGRATIONS：事件級資料實測約 104MB/日/房，
//    與 vault.db（~7MB）完全不是同一量級，體積/備份/清理必須脫鉤。
//  - 表格與欄位逐欄對照 Python 版 db.py，搬移舊資料時零轉換。
// =====================================================================
import type { Db } from "../../../server/db.js";

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    web_rid           TEXT NOT NULL,
    source            TEXT DEFAULT 'app',
    room_id           TEXT,
    anchor_id         TEXT,
    anchor_name       TEXT,
    title             TEXT,
    started_at        REAL NOT NULL,
    ended_at          REAL,
    last_seen_live_at REAL,
    partial           INTEGER DEFAULT 0,
    likes_start       INTEGER DEFAULT 0,
    likes_end         INTEGER DEFAULT 0,
    peak_viewers      INTEGER DEFAULT 0,
    avg_viewers       REAL    DEFAULT 0,
    total_user        TEXT,
    gift_diamonds     INTEGER DEFAULT 0,
    gift_events       INTEGER DEFAULT 0,
    chat_count        INTEGER DEFAULT 0,
    chat_users        INTEGER DEFAULT 0,
    member_count      INTEGER DEFAULT 0,
    snapshot_count    INTEGER DEFAULT 0,
    flags             TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_rid ON sessions(web_rid, started_at DESC);

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    ts         REAL    NOT NULL,
    type       TEXT    NOT NULL,
    nickname   TEXT,
    user_id    TEXT,
    content    TEXT,
    gift_id    INTEGER,
    gift_name  TEXT,
    repeat     INTEGER,
    diamonds   INTEGER,
    msg_id     TEXT,
    extra      TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_session_type ON events(session_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_msgid ON events(session_id, msg_id) WHERE msg_id <> '';

CREATE TABLE IF NOT EXISTS snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    ts         REAL    NOT NULL,
    status     INTEGER,
    viewers    INTEGER,
    like_count INTEGER,
    total_user TEXT
);
CREATE INDEX IF NOT EXISTS ix_snapshots_session_ts ON snapshots(session_id, ts);

CREATE TABLE IF NOT EXISTS rank_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    ts         REAL    NOT NULL,
    kind       TEXT    NOT NULL,
    rank       INTEGER,
    nickname   TEXT,
    score      INTEGER,
    level      INTEGER,
    payload    TEXT
);
CREATE INDEX IF NOT EXISTS ix_rank_session_kind ON rank_snapshots(session_id, kind, ts);

CREATE TABLE IF NOT EXISTS fans_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    ts         REAL    NOT NULL,
    club_name  TEXT,
    fans_name  TEXT,
    active     INTEGER,
    total      INTEGER,
    today_new  INTEGER,
    guard      INTEGER,
    members    TEXT
);
CREATE INDEX IF NOT EXISTS ix_fans_session_ts ON fans_snapshots(session_id, ts);

CREATE TABLE IF NOT EXISTS targets (
    web_rid        TEXT PRIMARY KEY,
    label          TEXT,
    anchor_name    TEXT,
    notify_live    INTEGER DEFAULT 1,
    notify_end     INTEGER DEFAULT 1,
    capture        INTEGER DEFAULT 1,
    cap_chat       INTEGER DEFAULT 1,
    cap_gift       INTEGER DEFAULT 1,
    cap_member     INTEGER DEFAULT 1,
    cap_snap       INTEGER DEFAULT 1,
    cap_rank       INTEGER DEFAULT 1,
    added_at       REAL,
    last_status    INTEGER,
    last_notify_at REAL,
    last_checked_at REAL
);

CREATE TABLE IF NOT EXISTS notifications (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL NOT NULL,
    web_rid  TEXT,
    kind     TEXT,
    ok       INTEGER,
    error    TEXT,
    text     TEXT
);
CREATE INDEX IF NOT EXISTS ix_notifications_ts ON notifications(ts DESC);

CREATE TABLE IF NOT EXISTS gift_catalog (
    gift_id    INTEGER PRIMARY KEY,
    name       TEXT,
    diamond    INTEGER,
    updated_at REAL
);
`;

function addColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** 建立/補齊 schema（也吃 Python 版舊 DB：只補缺欄位，不動資料） */
export function applySchema(db: Db): void {
  db.exec(SCHEMA_SQL);
  addColumn(db, "sessions", "source", "TEXT DEFAULT 'app'");
  addColumn(db, "sessions", "flags", "TEXT");
  addColumn(db, "targets", "cap_chat", "INTEGER DEFAULT 1");
  addColumn(db, "targets", "cap_gift", "INTEGER DEFAULT 1");
  addColumn(db, "targets", "cap_member", "INTEGER DEFAULT 1");
  addColumn(db, "targets", "cap_snap", "INTEGER DEFAULT 1");
  addColumn(db, "targets", "cap_rank", "INTEGER DEFAULT 1");
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(
    String(SCHEMA_VERSION)
  );
}
