// =====================================================================
//  DOUYIN SQLite schema（單一 data/dy.db）
//  - events 為唯一事件真相；entrants 是引擎增量維護的物化表
//  - profiles 是跨場真名快取（30 天）
// =====================================================================
import type { Db } from "../../../server/db.js";

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  web_rid           TEXT NOT NULL,
  room_id           TEXT,
  source            TEXT NOT NULL DEFAULT 'app',
  anchor_id         TEXT,
  anchor_name       TEXT,
  title             TEXT,
  started_at        REAL NOT NULL,
  ended_at          REAL,
  last_seen_live_at REAL,
  partial           INTEGER NOT NULL DEFAULT 0,
  likes_start       INTEGER NOT NULL DEFAULT 0,
  likes_end         INTEGER NOT NULL DEFAULT 0,
  peak_viewers      INTEGER NOT NULL DEFAULT 0,
  avg_viewers       REAL    NOT NULL DEFAULT 0,
  total_user        TEXT,
  gift_diamonds     INTEGER NOT NULL DEFAULT 0,
  gift_events       INTEGER NOT NULL DEFAULT 0,
  chat_count        INTEGER NOT NULL DEFAULT 0,
  chat_users        INTEGER NOT NULL DEFAULT 0,
  member_count      INTEGER NOT NULL DEFAULT 0,
  snapshot_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sessions_rid ON sessions(web_rid, started_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  ts         REAL    NOT NULL,
  type       TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  raw_uid    TEXT,
  anonymous  INTEGER NOT NULL DEFAULT 0,
  nickname   TEXT,
  display_id TEXT,
  sec_uid    TEXT,
  content    TEXT,
  gift_id    INTEGER,
  gift_name  TEXT,
  repeat     INTEGER,
  diamonds   INTEGER,
  msg_id     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX        IF NOT EXISTS ix_events_session_ts   ON events(session_id, ts);
CREATE INDEX        IF NOT EXISTS ix_events_session_type ON events(session_id, type);
CREATE INDEX        IF NOT EXISTS ix_events_session_user ON events(session_id, user_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_msgid        ON events(session_id, msg_id) WHERE msg_id <> '';

CREATE TABLE IF NOT EXISTS entrants (
  session_id     INTEGER NOT NULL,
  uid            TEXT    NOT NULL,
  nickname       TEXT,
  display_id     TEXT,
  sec_uid        TEXT,
  mark           TEXT    NOT NULL DEFAULT '',
  anonymous      INTEGER NOT NULL DEFAULT 0,
  hidden_flag    INTEGER NOT NULL DEFAULT 0,
  first_ts       REAL    NOT NULL,
  last_ts        REAL    NOT NULL,
  visits         INTEGER NOT NULL DEFAULT 0,
  chat_count     INTEGER NOT NULL DEFAULT 0,
  diamonds       INTEGER NOT NULL DEFAULT 0,
  last_gift_ts   REAL,
  real_nickname  TEXT,
  real_unique_id TEXT,
  real_short_id  TEXT,
  resolved_at    REAL,
  resolve_tries  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, uid)
);
CREATE INDEX IF NOT EXISTS ix_entrants_session_last ON entrants(session_id, last_ts DESC);
CREATE INDEX IF NOT EXISTS ix_entrants_session_mark ON entrants(session_id, mark);

CREATE TABLE IF NOT EXISTS profiles (
  uid         TEXT PRIMARY KEY,
  nickname    TEXT,
  unique_id   TEXT,
  short_id    TEXT,
  sec_uid     TEXT,
  followers   INTEGER,
  awemes      INTEGER,
  signature   TEXT,
  resolved_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  web_rid         TEXT PRIMARY KEY,
  label           TEXT,
  anchor_name     TEXT,
  notify_live     INTEGER NOT NULL DEFAULT 1,
  notify_end      INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1,
  added_at        REAL,
  last_status     INTEGER,
  last_notify_at  REAL,
  last_checked_at REAL
);

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

CREATE TABLE IF NOT EXISTS gift_catalog (
  gift_id    INTEGER PRIMARY KEY,
  name       TEXT,
  diamond    INTEGER,
  updated_at REAL
);

CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      REAL NOT NULL,
  web_rid TEXT,
  kind    TEXT,
  ok      INTEGER,
  error   TEXT,
  text    TEXT
);
CREATE INDEX IF NOT EXISTS ix_notifications_ts ON notifications(ts DESC);
`;

export function applySchema(db: Db): void {
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(
    String(SCHEMA_VERSION)
  );
}
