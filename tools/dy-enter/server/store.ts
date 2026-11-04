// =====================================================================
//  dy-enter 落地層（better-sqlite3，同步寫入；進場量低，不需要寫入佇列）
// =====================================================================
import Database from "better-sqlite3";
import { DY_ENTER_SCHEMA } from "./schema.js";

/** 標記：神秘人／疑似隱身／一般 */
export type EnterMark = "" | "mystery" | "suspect_hidden";

/**
 * 判定標記：
 *  - 暱稱以「神秘人」開頭 → mystery（實測 神秘人①/二阶…六阶 都存在）
 *  - 暱稱空白或只剩遮蔽符號 → suspect_hidden（推測，UI 標「疑似」）
 */
export function markOf(nickname: string | null | undefined): EnterMark {
  const n = (nickname ?? "").trim();
  if (!n) return "suspect_hidden";
  if (n.startsWith("神秘人")) return "mystery";
  if (/^[*＊·•\s._-]+$/.test(n)) return "suspect_hidden";
  return "";
}

export interface SessionRow {
  id: number;
  web_rid: string;
  room_id: string | null;
  anchor_name: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen_at: number | null;
}

export interface EnterMessage {
  type: string;
  nickname: string;
  user_id?: string;
  display_id?: string;
  sec_uid?: string;
  ts: number;
}

export interface EntrantRow {
  uid: string;
  nickname: string | null;
  display_id: string | null;
  sec_uid: string | null;
  mark: EnterMark;
  first_ts: number;
  last_ts: number;
  visits: number;
}

export interface SnapshotLike {
  web_rid: string;
  room_id?: string;
  anchor_name?: string;
  title?: string;
  status?: number;
}

const TOLERANCE = 180; // 秒：同 room_id 且在 3 分鐘內再看到 → 續接同一場

export class DyEnterStore {
  readonly db: Database.Database;

  constructor(file: string, opts: { log?: (m: string) => void } = {}) {
    const log = opts.log ?? (() => {});
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DY_ENTER_SCHEMA);
    log(`[dy-enter] SQLite ${file}`);
  }

  now(): number {
    return Date.now() / 1000;
  }

  // ---------- 場次 ----------
  /** 取該房目前開著的場次（未結束且 room_id 相同） */
  openSession(webRid: string, roomId?: string): SessionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE web_rid=? AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(webRid) as SessionRow | undefined;
    if (!row) return undefined;
    if (roomId && row.room_id && roomId !== row.room_id) return undefined;
    const last = row.last_seen_at ?? row.started_at;
    if (this.now() - last > TOLERANCE && roomId) return undefined;
    return row;
  }

  /** 建立或續接場次：同房同 room_id → 續接；否則開新的並把舊的結束 */
  ensureSession(snap: SnapshotLike): { session: SessionRow; created: boolean } {
    const existing = this.openSession(snap.web_rid, snap.room_id);
    const ts = this.now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE sessions SET last_seen_at=?,
             anchor_name=COALESCE(?, anchor_name), title=COALESCE(?, title),
             room_id=COALESCE(room_id, ?)
           WHERE id=?`
        )
        .run(ts, snap.anchor_name ?? null, snap.title ?? null, snap.room_id ?? null, existing.id);
      return { session: this.session(existing.id)!, created: false };
    }
    this.db
      .prepare(
        `UPDATE sessions SET ended_at=COALESCE(ended_at, ?) 
         WHERE web_rid=? AND ended_at IS NULL`
      )
      .run(ts, snap.web_rid);
    const info = this.db
      .prepare(
        `INSERT INTO sessions(web_rid, room_id, anchor_name, title, started_at, last_seen_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        snap.web_rid,
        snap.room_id ?? null,
        snap.anchor_name ?? null,
        snap.title ?? null,
        ts,
        ts
      );
    return { session: this.session(Number(info.lastInsertRowid))!, created: true };
  }

  touchSession(id: number, patch: Partial<Pick<SessionRow, "anchor_name" | "title" | "room_id">>): void {
    this.db
      .prepare(
        `UPDATE sessions SET last_seen_at=?,
           anchor_name=COALESCE(?, anchor_name), title=COALESCE(?, title),
           room_id=COALESCE(?, room_id)
         WHERE id=?`
      )
      .run(this.now(), patch.anchor_name ?? null, patch.title ?? null, patch.room_id ?? null, id);
  }

  endSession(id: number): void {
    this.db
      .prepare("UPDATE sessions SET ended_at=COALESCE(ended_at, ?) WHERE id=?")
      .run(this.now(), id);
  }

  session(id: number): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
  }

  sessions(limit = 50): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
  }

  // ---------- 進場 ----------
  /** 寫入一次進場（entrants upsert + entries 一列） */
  addEntry(sessionId: number, msg: EnterMessage): void {
    const uid = (msg.user_id ?? "").trim();
    if (!uid || uid === "111111") return; // 無 uid（或被遮蔽）無法識別 → 不記
    const ts = msg.ts || this.now();
    const nick = msg.nickname ?? "";
    const mark = markOf(nick);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entrants(session_id, uid, nickname, display_id, sec_uid, mark, first_ts, last_ts, visits)
           VALUES (?,?,?,?,?,?,?,?,1)
           ON CONFLICT(session_id, uid) DO UPDATE SET
             visits = entrants.visits + 1,
             last_ts = excluded.last_ts,
             nickname = CASE WHEN excluded.nickname<>'' THEN excluded.nickname ELSE entrants.nickname END,
             display_id = CASE WHEN excluded.display_id<>'' THEN excluded.display_id ELSE entrants.display_id END,
             sec_uid = CASE WHEN excluded.sec_uid<>'' THEN excluded.sec_uid ELSE entrants.sec_uid END,
             mark = CASE WHEN excluded.mark<>'' THEN excluded.mark ELSE entrants.mark END`
        )
        .run(
          sessionId,
          uid,
          nick,
          msg.display_id ?? "",
          msg.sec_uid ?? "",
          mark,
          ts,
          ts
        );
      this.db
        .prepare("INSERT INTO entries(session_id, uid, ts) VALUES (?,?,?)")
        .run(sessionId, uid, ts);
    });
    tx();
  }

  entrants(
    sessionId: number,
    opts: { mark?: EnterMark; limit?: number; offset?: number } = {}
  ): EntrantRow[] {
    const limit = Math.min(opts.limit ?? 500, 2000);
    const offset = opts.offset ?? 0;
    if (opts.mark) {
      return this.db
        .prepare(
          `SELECT * FROM entrants WHERE session_id=? AND mark=?
           ORDER BY last_ts DESC LIMIT ? OFFSET ?`
        )
        .all(sessionId, opts.mark, limit, offset) as EntrantRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM entrants WHERE session_id=? ORDER BY last_ts DESC LIMIT ? OFFSET ?`
      )
      .all(sessionId, limit, offset) as EntrantRow[];
  }

  entries(sessionId: number, uid: string): { ts: number }[] {
    return this.db
      .prepare("SELECT ts FROM entries WHERE session_id=? AND uid=? ORDER BY ts")
      .all(sessionId, uid) as { ts: number }[];
  }

  stats(sessionId: number): { total: number; mystery: number; suspect_hidden: number; visits: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN mark='mystery' THEN 1 ELSE 0 END) AS mystery,
                SUM(CASE WHEN mark='suspect_hidden' THEN 1 ELSE 0 END) AS suspect,
                SUM(visits) AS visits
         FROM entrants WHERE session_id=?`
      )
      .get(sessionId) as { total: number; mystery: number | null; suspect: number | null; visits: number | null };
    return {
      total: row.total ?? 0,
      mystery: row.mystery ?? 0,
      suspect_hidden: row.suspect ?? 0,
      visits: row.visits ?? 0,
    };
  }

  /** 最近進場（供即時列表）— 每人取最新一筆，避免洗版 */
  recent(sessionId: number, limit = 20): EntrantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM entrants WHERE session_id=? ORDER BY last_ts DESC LIMIT ?`
      )
      .all(sessionId, limit) as EntrantRow[];
  }

  // ---------- meta ----------
  getSetting(key: string, fallback = ""): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? fallback;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
