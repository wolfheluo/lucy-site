// =====================================================================
//  dy-enter 落地層（better-sqlite3，同步寫入；進場量低，不需要寫入佇列）
// =====================================================================
import Database from "better-sqlite3";
import { DY_ENTER_MIGRATIONS, DY_ENTER_SCHEMA } from "./schema.js";

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
  content?: string;
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
  chat_count: number;
  real_nickname?: string | null;
  real_unique_id?: string | null;
  real_short_id?: string | null;
  resolved_at?: number | null;
  resolve_tries?: number;
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
    for (const sql of DY_ENTER_MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch {
        /* 欄位已存在 */
      }
    }
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
  /** 共用 upsert：進場（enter）與發言（chat）都會建立/更新同一個人 */
  private upsert(sessionId: number, msg: EnterMessage, kind: "enter" | "chat"): string | null {
    const uid = (msg.user_id ?? "").trim();
    // 送禮訊息把匿名 uid 換成哨兵值 111111 → 無法識別，丟棄（由呼叫端計數）
    if (!uid || uid === "111111") return null;
    const ts = msg.ts || this.now();
    const nick = msg.nickname ?? "";
    const mark = markOf(nick);
    this.db
      .prepare(
        `INSERT INTO entrants(session_id, uid, nickname, display_id, sec_uid, mark,
                              first_ts, last_ts, visits, chat_count)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, uid) DO UPDATE SET
           visits = entrants.visits + excluded.visits,
           chat_count = entrants.chat_count + excluded.chat_count,
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
        ts,
        kind === "enter" ? 1 : 0,
        kind === "chat" ? 1 : 0
      );
    return uid;
  }

  /** 寫入一次進場（entrants.visits + entries 一列） */
  addEntry(sessionId: number, msg: EnterMessage): string | null {
    const uid = this.upsert(sessionId, msg, "enter");
    if (!uid) return null;
    this.db
      .prepare("INSERT INTO entries(session_id, uid, ts) VALUES (?,?,?)")
      .run(sessionId, uid, msg.ts || this.now());
    return uid;
  }

  /** 寫入一次發言（entrants.chat_count + messages 一列；內容照存） */
  addChat(sessionId: number, msg: EnterMessage): string | null {
    const uid = this.upsert(sessionId, msg, "chat");
    if (!uid) return null;
    this.db
      .prepare("INSERT INTO messages(session_id, uid, ts, content) VALUES (?,?,?,?)")
      .run(sessionId, uid, msg.ts || this.now(), msg.content ?? "");
    return uid;
  }

  /** 需要反查真名的人：神祕人或只有發言的人，且尚未解析成功、重試未超過上限 */
  unresolved(sessionId: number, limit = 1): EntrantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM entrants
          WHERE session_id=?
            AND (mark='mystery' OR (visits=0 AND chat_count>0))
            AND (real_nickname IS NULL OR real_nickname='')
            AND resolve_tries < 3
          ORDER BY last_ts DESC LIMIT ?`
      )
      .all(sessionId, limit) as EntrantRow[];
  }

  /** 寫入反查結果 */
  setReal(
    sessionId: number,
    uid: string,
    hit: { nickname: string; uniqueId?: string; shortId?: string }
  ): void {
    this.db
      .prepare(
        `UPDATE entrants SET real_nickname=?, real_unique_id=?, real_short_id=?,
                             resolved_at=?, resolve_tries=resolve_tries+1
         WHERE session_id=? AND uid=?`
      )
      .run(hit.nickname, hit.uniqueId ?? "", hit.shortId ?? "", this.now(), sessionId, uid);
  }

  /** 反查失敗：累計重試次數（避免無限打） */
  bumpResolveTry(sessionId: number, uid: string): void {
    this.db
      .prepare("UPDATE entrants SET resolve_tries=resolve_tries+1 WHERE session_id=? AND uid=?")
      .run(sessionId, uid);
  }

  /** 該人的發言內容 */
  messages(sessionId: number, uid: string): { ts: number; content: string }[] {
    return this.db
      .prepare("SELECT ts, content FROM messages WHERE session_id=? AND uid=? ORDER BY ts")
      .all(sessionId, uid) as { ts: number; content: string }[];
  }

  entrants(
    sessionId: number,
    opts: { mark?: EnterMark | "hidden"; limit?: number; offset?: number } = {}
  ): EntrantRow[] {
    const limit = Math.min(opts.limit ?? 500, 2000);
    const offset = opts.offset ?? 0;
    if (opts.mark === "hidden") {
      // 「疑似隱身」= 暱稱被遮蔽的人 ∪ 沒有進場事件、只靠發言捕捉的人
      return this.db
        .prepare(
          `SELECT * FROM entrants
            WHERE session_id=? AND (mark='suspect_hidden' OR (visits=0 AND chat_count>0))
            ORDER BY last_ts DESC LIMIT ? OFFSET ?`
        )
        .all(sessionId, limit, offset) as EntrantRow[];
    }
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

  stats(sessionId: number): {
    total: number;
    mystery: number;
    suspect_hidden: number;
    hidden_chat_only: number;
    visits: number;
    chats: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN mark='mystery' THEN 1 ELSE 0 END) AS mystery,
                SUM(CASE WHEN mark='suspect_hidden' THEN 1 ELSE 0 END) AS suspect,
                SUM(CASE WHEN visits=0 AND chat_count>0 THEN 1 ELSE 0 END) AS hidden,
                SUM(visits) AS visits,
                SUM(chat_count) AS chats
         FROM entrants WHERE session_id=?`
      )
      .get(sessionId) as {
      total: number;
      mystery: number | null;
      suspect: number | null;
      hidden: number | null;
      visits: number | null;
      chats: number | null;
    };
    return {
      total: row.total ?? 0,
      mystery: row.mystery ?? 0,
      suspect_hidden: row.suspect ?? 0,
      hidden_chat_only: row.hidden ?? 0,
      visits: row.visits ?? 0,
      chats: row.chats ?? 0,
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
