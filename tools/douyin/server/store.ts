// =====================================================================
//  DOUYIN 落地層（單一 data/dy.db）
//  - events 是唯一真相；entrants 由同一條寫入路徑增量維護（物化表）
//  - 寫入佇列 + 每 2 秒 transaction；msg_id 由 DB 唯一索引第二層去重
//  - 場次續接：離開 300 秒內復播續接、結束 900 秒內重開 partial=1
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Db } from "../../../server/db.js";
import { applySchema } from "./schema.js";
import { canonicalIdentity, type CanonicalIdentity } from "./identity.js";
import type {
  DyMessage,
  EntrantMarkLike,
  EntrantRow,
  EntrantStats,
  GiftCatalogEntry,
  NotificationRow,
  ProfileHit,
  ProfileRow,
  RankMember,
  RoomSnapshot,
  SessionRow,
  SessionSummary,
  TargetRow,
} from "../types.js";

const GB = 1024 ** 3;

interface QueuedEvent {
  sid: number;
  ts: number;
  type: string;
  identity: CanonicalIdentity;
  nickname: string | null;
  content: string | null;
  giftId: number | null;
  giftName: string | null;
  repeat: number | null;
  diamonds: number | null;
  msgId: string;
  hiddenFlag: number;
}

type WriteOp =
  | { kind: "event"; ev: QueuedEvent }
  | { kind: "snapshot"; sid: number; ts: number; status: number; viewers: number; likeCount: number; totalUser: string }
  | { kind: "rank"; sid: number; ts: number; rankKind: string; rank: number | null; nickname: string | null; score: number; level: number; payload: string }
  | { kind: "fans"; sid: number; ts: number; club: string | null; fans: string | null; active: number | null; total: number | null; todayNew: number | null; guard: number; members: string };

export interface StoreOptions {
  flushSecs?: number;
  maxBytes?: number;
  liveTolerance?: number;
  log?: (message: string) => void;
  now?: () => number;
}

export class DyStore {
  readonly path: string;
  readonly db: Db;
  readonly resumeWindow = 900;
  readonly liveTolerance: number;

  private readonly flushSecs: number;
  private readonly maxBytes: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  private queue: WriteOp[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sizeWarning = false;
  private lastSizeCheck = 0;

  private readonly stmtInsertEvent;
  private readonly stmtUpsertEntrant;
  private readonly stmtInsertSnapshot;
  private readonly stmtInsertRank;
  private readonly stmtInsertFans;

  constructor(dbPath: string, opts: StoreOptions = {}) {
    this.path = dbPath;
    this.flushSecs = opts.flushSecs ?? 2;
    this.maxBytes = opts.maxBytes ?? 20 * GB;
    this.liveTolerance = opts.liveTolerance ?? 300;
    this.log = opts.log ?? ((m) => console.log(m));
    this.now = opts.now ?? (() => Date.now() / 1000);

    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    applySchema(this.db);

    this.stmtInsertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO events
        (session_id,ts,type,user_id,raw_uid,anonymous,nickname,display_id,sec_uid,
         content,gift_id,gift_name,repeat,diamonds,msg_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    this.stmtUpsertEntrant = this.db.prepare(
      `INSERT INTO entrants
        (session_id,uid,nickname,display_id,sec_uid,mark,anonymous,hidden_flag,
         first_ts,last_ts,visits,chat_count,diamonds,last_gift_ts)
       VALUES (@sid,@uid,@nickname,@display_id,@sec_uid,@mark,@anonymous,@hidden,
               @ts,@ts,@visits,@chats,@diamonds,@gift_ts)
       ON CONFLICT(session_id,uid) DO UPDATE SET
         visits      = entrants.visits + excluded.visits,
         chat_count  = entrants.chat_count + excluded.chat_count,
         diamonds    = entrants.diamonds + excluded.diamonds,
         first_ts    = MIN(entrants.first_ts, excluded.first_ts),
         last_ts     = MAX(entrants.last_ts, excluded.last_ts),
         last_gift_ts = CASE
           WHEN excluded.last_gift_ts IS NULL THEN entrants.last_gift_ts
           WHEN entrants.last_gift_ts IS NULL THEN excluded.last_gift_ts
           ELSE MAX(entrants.last_gift_ts, excluded.last_gift_ts)
         END,
         hidden_flag = MAX(entrants.hidden_flag, excluded.hidden_flag),
         mark = CASE
           WHEN entrants.mark='mystery' OR excluded.mark='mystery' THEN 'mystery'
           WHEN entrants.mark='suspect_hidden' OR excluded.mark='suspect_hidden' THEN 'suspect_hidden'
           ELSE ''
         END,
         nickname = CASE WHEN COALESCE(excluded.nickname,'')<>'' THEN excluded.nickname ELSE entrants.nickname END,
         display_id = CASE WHEN COALESCE(excluded.display_id,'')<>'' THEN excluded.display_id ELSE entrants.display_id END,
         sec_uid = CASE WHEN COALESCE(excluded.sec_uid,'')<>'' THEN excluded.sec_uid ELSE entrants.sec_uid END`
    );
    this.stmtInsertSnapshot = this.db.prepare(
      `INSERT INTO snapshots(session_id,ts,status,viewers,like_count,total_user) VALUES (?,?,?,?,?,?)`
    );
    this.stmtInsertRank = this.db.prepare(
      `INSERT INTO rank_snapshots(session_id,ts,kind,rank,nickname,score,level,payload)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    this.stmtInsertFans = this.db.prepare(
      `INSERT INTO fans_snapshots(session_id,ts,club_name,fans_name,active,total,today_new,guard,members)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
  }

  // ---------- 生命週期 ----------
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushSecs * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    this.db.close();
  }

  flushNow(): boolean {
    try {
      this.flush();
      return true;
    } catch (err) {
      this.log(`[db] flushNow 失敗：${(err as Error).message}`);
      return false;
    }
  }

  // ---------- 寫入 ----------
  private put(op: WriteOp): void {
    if (this.queue.length >= 200_000) {
      this.log("[db] 寫入佇列已滿，丟棄一筆");
      return;
    }
    this.queue.push(op);
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    const tx = this.db.transaction((ops: WriteOp[]) => {
      for (const op of ops) {
        if (op.kind === "event") {
          const ev = op.ev;
          const res = this.stmtInsertEvent.run(
            ev.sid,
            ev.ts,
            ev.type,
            ev.identity.uid,
            ev.identity.rawUid,
            ev.identity.anonymous,
            ev.nickname,
            ev.identity.displayId || null,
            ev.identity.secUid ?? null,
            ev.content,
            ev.giftId,
            ev.giftName,
            ev.repeat,
            ev.diamonds,
            ev.msgId
          );
          if (res.changes !== 1) continue;
          this.stmtUpsertEntrant.run({
            sid: ev.sid,
            uid: ev.identity.uid,
            nickname: ev.nickname ?? "",
            display_id: ev.identity.displayId || null,
            sec_uid: ev.identity.secUid ?? "",
            mark: ev.identity.mark,
            anonymous: ev.identity.anonymous,
            hidden: ev.type === "Chat" ? ev.hiddenFlag : 0,
            ts: ev.ts,
            visits: ev.type === "Member" ? 1 : 0,
            chats: ev.type === "Chat" ? 1 : 0,
            diamonds: ev.type === "Gift" ? (ev.diamonds ?? 0) : 0,
            gift_ts: ev.type === "Gift" ? ev.ts : null,
          });
        } else if (op.kind === "snapshot") {
          this.stmtInsertSnapshot.run(op.sid, op.ts, op.status, op.viewers, op.likeCount, op.totalUser);
        } else if (op.kind === "rank") {
          this.stmtInsertRank.run(op.sid, op.ts, op.rankKind, op.rank, op.nickname, op.score, op.level, op.payload);
        } else {
          this.stmtInsertFans.run(op.sid, op.ts, op.club, op.fans, op.active, op.total, op.todayNew, op.guard, op.members);
        }
      }
    });
    try {
      tx(items);
    } catch (err) {
      this.log(`[db] flush 失敗：${(err as Error).message}`);
    }
  }

  /**
   * 寫入一批訊息。
   * - Like 不落庫（只留引擎記憶體計數）
   * - 無法識別 uid 的訊息丟棄
   * - Gift 的鑽石由 giftValue 回呼計算（引擎用目錄價 × repeat）
   * 回傳實際排入佇列的筆數（不含 Like／無法識別）。
   */
  addMessages(
    sid: number,
    messages: DyMessage[],
    opts: {
      hiddenFlag?: boolean;
      giftValue?: (giftId: number, repeat: number) => { diamonds: number; name: string };
    } = {}
  ): number {
    let accepted = 0;
    for (const raw of messages) {
      if (raw.type === "Like") continue;
      if (raw.type !== "Member" && raw.type !== "Chat" && raw.type !== "Gift") continue;
      const identity = canonicalIdentity(raw);
      if (!identity) continue;

      const m: DyMessage = { ...raw };
      let diamonds: number | null = null;
      let giftName: string | null = null;
      const repeat = m.repeat || 1;
      if (m.type === "Gift") {
        const g = opts.giftValue?.(m.gift_id || 0, repeat) ?? { diamonds: 0, name: "" };
        diamonds = m.diamonds ?? g.diamonds;
        giftName = m.gift_name || g.name || m.content || "禮物";
        m.content = giftName + (repeat > 1 ? ` ×${repeat}` : "");
      }

      this.put({
        kind: "event",
        ev: {
          sid,
          ts: m.ts || this.now(),
          type: m.type,
          identity,
          nickname: m.nickname || null,
          content: m.content || null,
          giftId: m.type === "Gift" ? m.gift_id ?? null : null,
          giftName,
          repeat: m.type === "Gift" ? repeat : null,
          diamonds,
          msgId: m.msg_id || "",
          hiddenFlag: opts.hiddenFlag && m.type === "Chat" ? 1 : 0,
        },
      });
      accepted += 1;
    }
    return accepted;
  }

  addSnapshot(sid: number, snap: RoomSnapshot): void {
    this.put({
      kind: "snapshot",
      sid,
      ts: snap.ts || this.now(),
      status: snap.status,
      viewers: snap.viewers,
      likeCount: snap.like_count,
      totalUser: snap.total_user,
    });
  }

  addRank(
    sid: number,
    rankKind: string,
    rows: ReadonlyArray<Partial<RankMember> & { count?: number }>,
    ts?: number
  ): void {
    const at = ts ?? this.now();
    for (const r of rows || []) {
      this.put({
        kind: "rank",
        sid,
        ts: at,
        rankKind,
        rank: r.rank ?? null,
        nickname: r.nickname ?? null,
        score: r.score ?? r.diamonds ?? 0,
        level: r.level ?? r.pay_level ?? 0,
        payload: JSON.stringify(r),
      });
    }
  }

  addFans(
    sid: number,
    meta: { club_name?: string; fans_name?: string; active?: number; total?: number; today_new?: number; guard?: boolean },
    members: ReadonlyArray<{ nickname: string; intimacy: number; level: number }>
  ): void {
    this.put({
      kind: "fans",
      sid,
      ts: this.now(),
      club: meta.club_name ?? null,
      fans: meta.fans_name ?? null,
      active: meta.active ?? null,
      total: meta.total ?? null,
      todayNew: meta.today_new ?? null,
      guard: meta.guard ? 1 : 0,
      members: JSON.stringify(members || []),
    });
  }

  // ---------- 場次 ----------
  ensureSession(
    snap: RoomSnapshot,
    opts: { firstSeenLive?: boolean } = {}
  ): { id: number; resumed: boolean } {
    const now = this.now();
    const rid = snap.web_rid;
    const open = this.db
      .prepare(
        `SELECT id, room_id, last_seen_live_at FROM sessions
         WHERE web_rid=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
      )
      .get(rid) as { id: number; room_id: string | null; last_seen_live_at: number | null } | undefined;

    if (open) {
      const sameRoom = !open.room_id || open.room_id === snap.room_id;
      if (sameRoom && now - (open.last_seen_live_at ?? 0) <= this.liveTolerance) {
        this.db.prepare("UPDATE sessions SET last_seen_live_at=? WHERE id=?").run(now, open.id);
        return { id: open.id, resumed: true };
      }
      this.closeSession(open.id);
    } else {
      const prev = this.db
        .prepare(
          `SELECT id, room_id, ended_at FROM sessions
           WHERE web_rid=? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`
        )
        .get(rid) as { id: number; room_id: string | null; ended_at: number | null } | undefined;
      if (prev) {
        const sameRoom = !prev.room_id || prev.room_id === snap.room_id;
        if (sameRoom && now - (prev.ended_at ?? 0) <= this.resumeWindow) {
          this.db
            .prepare("UPDATE sessions SET ended_at=NULL, last_seen_live_at=?, partial=1 WHERE id=?")
            .run(now, prev.id);
          return { id: prev.id, resumed: true };
        }
      }
    }

    const info = this.db
      .prepare(
        `INSERT INTO sessions
          (web_rid, source, room_id, anchor_id, anchor_name, title, started_at,
           last_seen_live_at, partial, likes_start, likes_end, peak_viewers, avg_viewers, total_user)
         VALUES (?, 'app', ?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        rid,
        snap.room_id,
        snap.anchor_id,
        snap.anchor_name,
        snap.title,
        now,
        now,
        opts.firstSeenLive === false ? 1 : 0,
        snap.like_count || 0,
        snap.like_count || 0,
        snap.viewers || 0,
        snap.viewers || 0,
        snap.total_user || ""
      );
    return { id: Number(info.lastInsertRowid), resumed: false };
  }

  touchSession(sid: number, snap: RoomSnapshot): void {
    this.db
      .prepare(
        `UPDATE sessions SET last_seen_live_at=?, anchor_name=COALESCE(?,anchor_name),
           title=COALESCE(?,title), peak_viewers=MAX(peak_viewers, ?),
           likes_end=COALESCE(?, likes_end), total_user=COALESCE(?, total_user)
         WHERE id=?`
      )
      .run(
        this.now(),
        snap.anchor_name,
        snap.title,
        snap.viewers || 0,
        snap.like_count,
        snap.total_user,
        sid
      );
  }

  refreshSummary(sid: number, finalSnap?: RoomSnapshot | null, close = false): SessionSummary {
    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='Gift' THEN diamonds ELSE 0 END),0) AS gift_diamonds,
           SUM(CASE WHEN type='Gift' THEN 1 ELSE 0 END)                    AS gift_events,
           SUM(CASE WHEN type='Chat' THEN 1 ELSE 0 END)                    AS chat_count,
           COUNT(DISTINCT CASE WHEN type='Chat' THEN user_id END)          AS chat_users,
           SUM(CASE WHEN type='Member' THEN 1 ELSE 0 END)                  AS member_count
         FROM events WHERE session_id=?`
      )
      .get(sid) as {
      gift_diamonds: number | null;
      gift_events: number | null;
      chat_count: number | null;
      chat_users: number | null;
      member_count: number | null;
    };

    const snaps = this.db
      .prepare(
        `SELECT COUNT(*) AS snap_count, AVG(viewers) AS avg_viewers,
                MAX(viewers) AS peak_viewers, MIN(like_count) AS min_like, MAX(like_count) AS max_like
         FROM snapshots WHERE session_id=?`
      )
      .get(sid) as {
      snap_count: number | null;
      avg_viewers: number | null;
      peak_viewers: number | null;
      min_like: number | null;
      max_like: number | null;
    };

    const summary: SessionSummary = {
      gift_diamonds: agg.gift_diamonds || 0,
      gift_events: agg.gift_events || 0,
      chat_count: agg.chat_count || 0,
      chat_users: agg.chat_users || 0,
      member_count: agg.member_count || 0,
      snapshot_count: snaps.snap_count || 0,
      avg_viewers: Math.round((snaps.avg_viewers || 0) * 10) / 10,
      peak_viewers: snaps.peak_viewers || 0,
      likes_start: snaps.min_like || 0,
      likes_end: finalSnap?.like_count || snaps.max_like || 0,
    };
    if (close) summary.ended_at = this.now();

    const sets = Object.keys(summary).map((k) => `${k}=?`).join(", ");
    this.db.prepare(`UPDATE sessions SET ${sets} WHERE id=?`).run(...Object.values(summary), sid);
    return summary;
  }

  closeSession(sid: number, finalSnap?: RoomSnapshot | null): SessionSummary {
    return this.refreshSummary(sid, finalSnap, true);
  }

  /** 場次禮物彙總（重啟／續接時把記憶體基準接回來） */
  giftSummary(sid: number): {
    total: number;
    events: number;
    top: { uid: string; nickname: string; diamonds: number; count: number }[];
  } {
    const agg = this.db
      .prepare(
        `SELECT COALESCE(SUM(diamonds),0) AS total, COUNT(*) AS events
         FROM events WHERE session_id=? AND type='Gift'`
      )
      .get(sid) as { total: number | null; events: number | null };
    const top = this.db
      .prepare(
        `SELECT user_id AS uid, COALESCE(MAX(nickname),'') AS nickname,
                SUM(diamonds) AS diamonds, COUNT(*) AS count
         FROM events WHERE session_id=? AND type='Gift' AND user_id<>''
         GROUP BY user_id ORDER BY diamonds DESC LIMIT 50`
      )
      .all(sid) as { uid: string; nickname: string; diamonds: number; count: number }[];
    return { total: agg.total || 0, events: agg.events || 0, top };
  }

  getSession(sid: number): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id=?").get(sid) as SessionRow | undefined;
  }

  latestSession(webRid: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE web_rid=? ORDER BY started_at DESC LIMIT 1")
      .get(webRid) as SessionRow | undefined;
  }

  latestOpenSession(): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get() as SessionRow | undefined;
  }

  listSessions(limit = 50, offset = 0, webRid = ""): SessionRow[] {
    return (
      webRid
        ? this.db
            .prepare("SELECT * FROM sessions WHERE web_rid=? ORDER BY started_at DESC LIMIT ? OFFSET ?")
            .all(webRid, limit, offset)
        : this.db
            .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?")
            .all(limit, offset)
    ) as SessionRow[];
  }

  countSessions(webRid = ""): number {
    const row = (
      webRid
        ? this.db.prepare("SELECT COUNT(*) c FROM sessions WHERE web_rid=?").get(webRid)
        : this.db.prepare("SELECT COUNT(*) c FROM sessions").get()
    ) as { c: number };
    return row.c;
  }

  // ---------- 禮物目錄 ----------
  saveCatalog(catalog: Record<string | number, GiftCatalogEntry>): void {
    const entries = Object.entries(catalog ?? {});
    if (entries.length === 0) return;
    const now = this.now();
    const stmt = this.db.prepare(
      `INSERT INTO gift_catalog(gift_id,name,diamond,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(gift_id) DO UPDATE SET name=excluded.name, diamond=excluded.diamond, updated_at=excluded.updated_at`
    );
    const tx = this.db.transaction(() => {
      for (const [gid, v] of entries) stmt.run(Number(gid), v.name, v.diamond, now);
    });
    tx();
  }

  getCatalog(giftId: number): GiftCatalogEntry | undefined {
    return this.db.prepare("SELECT name, diamond FROM gift_catalog WHERE gift_id=?").get(giftId) as
      | GiftCatalogEntry
      | undefined;
  }

  // ---------- 名單 ----------
  unresolvedMystery(sid: number, limit = 4): EntrantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM entrants
          WHERE session_id=? AND mark='mystery'
            AND uid NOT LIKE 'anon:%'
            AND (real_nickname IS NULL OR real_nickname='')
            AND resolve_tries < 3
          ORDER BY last_ts DESC LIMIT ?`
      )
      .all(sid, limit) as EntrantRow[];
  }

  setReal(sid: number, uid: string, hit: ProfileHit): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE entrants SET real_nickname=?, real_unique_id=?, real_short_id=?,
                             resolved_at=?, resolve_tries=resolve_tries+1
         WHERE session_id=? AND uid=?`
      )
      .run(hit.nickname, hit.uniqueId, hit.shortId, now, sid, uid);
    this.upsertProfile(hit);
  }

  bumpResolveTry(sid: number, uid: string): void {
    this.db
      .prepare("UPDATE entrants SET resolve_tries=resolve_tries+1 WHERE session_id=? AND uid=?")
      .run(sid, uid);
  }

  getProfile(uid: string): ProfileRow | undefined {
    return this.db.prepare("SELECT * FROM profiles WHERE uid=?").get(uid) as ProfileRow | undefined;
  }

  upsertProfile(hit: ProfileHit): void {
    this.db
      .prepare(
        `INSERT INTO profiles(uid,nickname,unique_id,short_id,sec_uid,followers,awemes,signature,resolved_at)
         VALUES(@uid,@nickname,@unique_id,@short_id,@sec_uid,@followers,@awemes,@signature,@resolved_at)
         ON CONFLICT(uid) DO UPDATE SET
           nickname=excluded.nickname, unique_id=excluded.unique_id, short_id=excluded.short_id,
           sec_uid=excluded.sec_uid, followers=excluded.followers, awemes=excluded.awemes,
           signature=excluded.signature, resolved_at=excluded.resolved_at`
      )
      .run({
        uid: hit.uid,
        nickname: hit.nickname,
        unique_id: hit.uniqueId,
        short_id: hit.shortId,
        sec_uid: hit.secUid,
        followers: hit.followers,
        awemes: hit.awemes,
        signature: hit.signature,
        resolved_at: this.now(),
      });
  }

  entrants(
    sid: number,
    opts: { mark?: EntrantMarkLike; q?: string; limit?: number; offset?: number } = {}
  ): EntrantRow[] {
    const limit = Math.min(opts.limit ?? 500, 2000);
    const offset = opts.offset ?? 0;
    const where = ["session_id=?"];
    const args: unknown[] = [sid];
    if (opts.mark === "hidden") {
      where.push("(mark='suspect_hidden' OR hidden_flag=1)");
    } else if (opts.mark) {
      where.push("mark=?");
      args.push(opts.mark);
    }
    const q = (opts.q ?? "").trim();
    if (q) {
      where.push("(COALESCE(nickname,'') LIKE ? OR uid LIKE ? OR COALESCE(display_id,'') LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    return this.db
      .prepare(
        `SELECT * FROM entrants WHERE ${where.join(" AND ")}
         ORDER BY last_ts DESC LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as EntrantRow[];
  }

  getEntrant(sid: number, uid: string): EntrantRow | undefined {
    return this.db
      .prepare("SELECT * FROM entrants WHERE session_id=? AND uid=?")
      .get(sid, uid) as EntrantRow | undefined;
  }

  stats(sid: number): EntrantStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN mark='mystery' THEN 1 ELSE 0 END) AS mystery,
                SUM(CASE WHEN mark='suspect_hidden' THEN 1 ELSE 0 END) AS suspect,
                SUM(CASE WHEN hidden_flag=1 THEN 1 ELSE 0 END) AS hidden,
                SUM(CASE WHEN uid LIKE 'anon:%' THEN 1 ELSE 0 END) AS anon,
                SUM(visits) AS visits,
                SUM(chat_count) AS chats,
                SUM(diamonds) AS diamonds
         FROM entrants WHERE session_id=?`
      )
      .get(sid) as {
      total: number;
      mystery: number | null;
      suspect: number | null;
      hidden: number | null;
      anon: number | null;
      visits: number | null;
      chats: number | null;
      diamonds: number | null;
    };
    return {
      total: row.total ?? 0,
      mystery: row.mystery ?? 0,
      suspect_hidden: row.suspect ?? 0,
      hidden_chat_only: row.hidden ?? 0,
      anon: row.anon ?? 0,
      visits: row.visits ?? 0,
      chats: row.chats ?? 0,
      diamonds: row.diamonds ?? 0,
    };
  }

  entrantEvents(
    sid: number,
    uid: string,
    opts: { type?: string; limit?: number; offset?: number } = {}
  ): Record<string, unknown>[] {
    const limit = Math.min(opts.limit ?? 200, 500);
    const offset = opts.offset ?? 0;
    const where = ["session_id=?", "user_id=?"];
    const args: unknown[] = [sid, uid];
    if (opts.type) {
      where.push("type=?");
      args.push(opts.type);
    }
    return this.db
      .prepare(
        `SELECT ts,type,nickname,content,gift_name,repeat,diamonds
         FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as Record<string, unknown>[];
  }

  deleteEntrant(sid: number, uid: string): { removed: number; events: number } {
    const tx = this.db.transaction((s: number, u: string) => {
      const events = this.db.prepare("DELETE FROM events WHERE session_id=? AND user_id=?").run(s, u).changes;
      const removed = this.db.prepare("DELETE FROM entrants WHERE session_id=? AND uid=?").run(s, u).changes;
      return { removed, events };
    });
    return tx(sid, uid) as { removed: number; events: number };
  }

  deleteSession(sid: number): { removed: number; events: number; entrants: number } {
    const tx = this.db.transaction((s: number) => {
      const events = this.db.prepare("DELETE FROM events WHERE session_id=?").run(s).changes;
      const entrants = this.db.prepare("DELETE FROM entrants WHERE session_id=?").run(s).changes;
      this.db.prepare("DELETE FROM snapshots WHERE session_id=?").run(s);
      this.db.prepare("DELETE FROM rank_snapshots WHERE session_id=?").run(s);
      this.db.prepare("DELETE FROM fans_snapshots WHERE session_id=?").run(s);
      const removed = this.db.prepare("DELETE FROM sessions WHERE id=?").run(s).changes;
      return { removed, events, entrants };
    });
    return tx(sid) as { removed: number; events: number; entrants: number };
  }

  // ---------- 監控目標 ----------
  ensureTarget(webRid: string, label = "", anchorName = ""): TargetRow | undefined {
    this.db
      .prepare(
        `INSERT INTO targets(web_rid,label,anchor_name,added_at) VALUES(?,?,?,?)
         ON CONFLICT(web_rid) DO UPDATE SET
           label=CASE WHEN excluded.label<>'' THEN excluded.label ELSE targets.label END,
           anchor_name=CASE WHEN excluded.anchor_name<>'' THEN excluded.anchor_name ELSE targets.anchor_name END`
      )
      .run(webRid, label || "", anchorName || "", this.now());
    return this.getTarget(webRid);
  }

  getTarget(webRid: string): TargetRow | undefined {
    return this.db.prepare("SELECT * FROM targets WHERE web_rid=?").get(webRid) as TargetRow | undefined;
  }

  listTargets(): TargetRow[] {
    return this.db.prepare("SELECT * FROM targets ORDER BY added_at").all() as TargetRow[];
  }

  updateTarget(webRid: string, fields: Record<string, unknown>): void {
    const allowed = new Set([
      "label",
      "anchor_name",
      "notify_live",
      "notify_end",
      "enabled",
      "last_status",
      "last_notify_at",
      "last_checked_at",
    ]);
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.has(k)) continue;
      sets.push(`${k}=?`);
      args.push(v);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE targets SET ${sets.join(", ")} WHERE web_rid=?`).run(...args, webRid);
  }

  deleteTarget(webRid: string): void {
    this.db.prepare("DELETE FROM targets WHERE web_rid=?").run(webRid);
  }

  // ---------- 通知 ----------
  addNotification(webRid: string, kind: string, ok: boolean, error = "", text = ""): void {
    this.db
      .prepare("INSERT INTO notifications(ts,web_rid,kind,ok,error,text) VALUES(?,?,?,?,?,?)")
      .run(this.now(), webRid, kind, ok ? 1 : 0, error || "", (text || "").slice(0, 2000));
  }

  listNotifications(limit = 20): NotificationRow[] {
    return this.db
      .prepare("SELECT * FROM notifications ORDER BY ts DESC, id DESC LIMIT ?")
      .all(limit) as NotificationRow[];
  }

  // ---------- 設定 ----------
  getSetting(key: string, fallback = ""): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  setSetting(key: string, value: string | number): void {
    this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key, String(value));
  }

  // ---------- 維運 ----------
  sizeBytes(): number {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += fs.statSync(this.path + suffix).size;
      } catch {
        /* 檔案不存在屬正常 */
      }
    }
    return total;
  }

  checkSize(): boolean {
    if (this.now() - this.lastSizeCheck < 3600) return this.sizeWarning;
    this.lastSizeCheck = this.now();
    const size = this.sizeBytes();
    const warn = size >= this.maxBytes;
    if (warn !== this.sizeWarning) {
      this.sizeWarning = warn;
      this.log(`[db] 目前 ${(size / GB).toFixed(2)} GB${warn ? "（已超過提醒門檻）" : ""}`);
    }
    return warn;
  }

  walCheckpoint(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      this.log(`[db] wal_checkpoint 失敗：${(err as Error).message}`);
    }
  }
}
