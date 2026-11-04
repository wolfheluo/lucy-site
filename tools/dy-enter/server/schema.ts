// =====================================================================
//  dy-enter SQLite schema
//  sessions  每場直播一列（貼新 URL / 重新開播 = 新場次，永久保留）
//  entrants  每人一列（session 內去重，uid 為鍵）
//  entries   每次進場一列（明細）
// =====================================================================
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
CREATE INDEX IF NOT EXISTS ix_entries_session_uid
    ON entries(session_id, uid, ts);
CREATE INDEX IF NOT EXISTS ix_sessions_web_rid
    ON sessions(web_rid, started_at DESC);
`;
