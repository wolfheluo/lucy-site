// =====================================================================
//  dy-enter SQLite schema
//  sessions  每場直播一列（貼新 URL / 重新開播 = 新場次，永久保留）
//  entrants  每人一列（session 內去重，uid 為鍵）
//  entries   每次進場一列（明細）
// =====================================================================
/** v2 遷移：舊 DB 補 chat_count / messages（ALTER 對已存在的欄位會失敗，呼叫端以 try 包住） */
export const DY_ENTER_MIGRATIONS = [
  "ALTER TABLE entrants ADD COLUMN chat_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE entrants ADD COLUMN real_nickname TEXT DEFAULT ''",
  "ALTER TABLE entrants ADD COLUMN real_unique_id TEXT DEFAULT ''",
  "ALTER TABLE entrants ADD COLUMN real_short_id TEXT DEFAULT ''",
  "ALTER TABLE entrants ADD COLUMN resolved_at REAL",
  "ALTER TABLE entrants ADD COLUMN resolve_tries INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE entrants ADD COLUMN hidden_flag INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN current_viewers INTEGER NOT NULL DEFAULT 0",
];

export const DY_ENTER_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    web_rid      TEXT NOT NULL,
    room_id      TEXT,
    anchor_name  TEXT,
    title        TEXT,
    started_at   REAL NOT NULL,
    ended_at     REAL,
    current_viewers INTEGER NOT NULL DEFAULT 0,
    last_seen_at REAL
);

CREATE TABLE IF NOT EXISTS entrants (
    session_id INTEGER NOT NULL,
    uid        TEXT NOT NULL,
    nickname   TEXT,
    display_id TEXT,
    sec_uid    TEXT,
    mark       TEXT NOT NULL DEFAULT '',
    first_ts   REAL NOT NULL,
    last_ts    REAL NOT NULL,
    visits     INTEGER NOT NULL DEFAULT 1,
    chat_count INTEGER NOT NULL DEFAULT 0,
    hidden_flag    INTEGER NOT NULL DEFAULT 0,
    real_nickname  TEXT DEFAULT '',
    real_unique_id TEXT DEFAULT '',
    real_short_id  TEXT DEFAULT '',
    resolved_at    REAL,
    resolve_tries  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, uid)
);

CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    uid        TEXT NOT NULL,
    ts         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_entrants_session_last
    ON entrants(session_id, last_ts DESC);
CREATE INDEX IF NOT EXISTS ix_entrants_session_mark
    ON entrants(session_id, mark);
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    uid        TEXT NOT NULL,
    ts         REAL NOT NULL,
    content    TEXT
);

CREATE INDEX IF NOT EXISTS ix_messages_session_uid
    ON messages(session_id, uid, ts);
CREATE INDEX IF NOT EXISTS ix_entries_session_uid
    ON entries(session_id, uid, ts);
CREATE INDEX IF NOT EXISTS ix_sessions_web_rid
    ON sessions(web_rid, started_at DESC);
`;
