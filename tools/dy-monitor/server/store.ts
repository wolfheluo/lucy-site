// =====================================================================
//  dy-monitor 落地層（逐行為對照 Python 版 db.py）
//  - 單一 better-sqlite3 連線（同步 API）；寫入走記憶體佇列 + 每 N 秒
//    一次 transaction，避免每筆 INSERT 阻塞 Hono 的事件迴圈。
//  - 切場「寬容合併」：離開直播 5 分鐘內復播 → 同場續寫
//  - 切房來回：場次結束 900 秒內重開同一場（partial=1），不拆成多筆
//  - events 以 (session_id, msg_id) 部分唯一索引防重（INSERT OR IGNORE）
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Db } from "../../../server/db.js";
import { applySchema } from "./schema.js";
import {
  CAPTURE_KEYS,
  type RankMember,
  type CaptureFlags,
  type FansMeta,
  type FansMember,
  type GiftCatalogEntry,
  type NotificationRow,
  type RoomSnapshot,
  type SessionRow,
  type SessionSummary,
  type TargetRow,
} from "../types.js";

const GB = 1024 ** 3;

type WriteOp =
  | { kind: "event"; args: unknown[] }
  | { kind: "snapshot"; args: unknown[] }
  | { kind: "rank"; args: unknown[] }
  | { kind: "fans"; args: unknown[] };

export interface StoreOptions {
  /** 批次 flush 間隔（秒） */
  flushSecs?: number;
  /** DB 大小警告門檻（bytes） */
  maxBytes?: number;
  /** 同房離開直播後仍視為同場的寬限（秒） */
  liveTolerance?: number;
  log?: (message: string) => void;
  /** 時間來源（epoch 秒），測試可注入 */
  now?: () => number;
}

export class DyMonitorStore {
  readonly path: string;
  readonly db: Db;
  readonly resumeWindow = 900;

  private readonly flushSecs: number;
  private readonly maxBytes: number;
  readonly liveTolerance: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  private queue: WriteOp[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sizeWarning = false;
  private lastSizeCheck = 0;

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
  }

  // ---------- 生命週期 ----------
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushSecs * 1000);
    // 不 unref：引擎靠它維持節奏，但 stop() 會清掉
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    this.db.close();
  }

  /** 立即把佇列寫入（部署/測試/程序結束前用） */
  flushNow(): boolean {
    try {
      this.flush();
      return true;
    } catch (err) {
      this.log(`[db] flushNow 失敗：${(err as Error).message}`);
      return false;
    }
  }

  // ---------- 寫入佇列 ----------
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
    const insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO events
        (session_id,ts,type,nickname,user_id,content,gift_id,gift_name,repeat,diamonds,msg_id,extra)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insertSnapshot = this.db.prepare(
      `INSERT INTO snapshots(session_id,ts,status,viewers,like_count,total_user) VALUES (?,?,?,?,?,?)`
    );
    const insertRank = this.db.prepare(
      `INSERT INTO rank_snapshots(session_id,ts,kind,rank,nickname,score,level,payload)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    const insertFans = this.db.prepare(
      `INSERT INTO fans_snapshots(session_id,ts,club_name,fans_name,active,total,today_new,guard,members)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    const tx = this.db.transaction((ops: WriteOp[]) => {
      for (const op of ops) {
        if (op.kind === "event") insertEvent.run(op.args);
        else if (op.kind === "snapshot") insertSnapshot.run(op.args);
        else if (op.kind === "rank") insertRank.run(op.args);
        else insertFans.run(op.args);
      }
    });
    try {
      tx(items);
    } catch (err) {
      this.log(`[db] flush 失敗：${(err as Error).message}`);
    }
  }

  // ---------- 場次 ----------
  ensureSession(
    snap: RoomSnapshot,
    opts: { firstSeenLive?: boolean; source?: string; flags?: CaptureFlags | null } = {}
  ): { id: number; resumed: boolean } {
    const now = this.now();
    const source = opts.source ?? "app";
    const rid = snap.web_rid;

    const open = this.db
      .prepare(
        `SELECT id, room_id, last_seen_live_at FROM sessions
         WHERE web_rid=? AND source=? AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(rid, source) as
      | { id: number; room_id: string | null; last_seen_live_at: number | null }
      | undefined;

    if (open) {
      const sameRoom = !open.room_id || open.room_id === snap.room_id;
      if (sameRoom && now - (open.last_seen_live_at ?? 0) <= this.liveTolerance) {
        this.db
          .prepare("UPDATE sessions SET last_seen_live_at=? WHERE id=?")
          .run(now, open.id);
        return { id: open.id, resumed: true };
      }
      this.closeSession(open.id);
    } else {
      const prev = this.db
        .prepare(
          `SELECT id, room_id, ended_at FROM sessions
           WHERE web_rid=? AND source=? AND ended_at IS NOT NULL
           ORDER BY ended_at DESC LIMIT 1`
        )
        .get(rid, source) as
        | { id: number; room_id: string | null; ended_at: number | null }
        | undefined;
      if (prev) {
        const sameRoom = !prev.room_id || prev.room_id === snap.room_id;
        if (sameRoom && now - (prev.ended_at ?? 0) <= this.resumeWindow) {
          this.db
            .prepare(
              "UPDATE sessions SET ended_at=NULL, last_seen_live_at=?, partial=1 WHERE id=?"
            )
            .run(now, prev.id);
          return { id: prev.id, resumed: true };
        }
      }
    }

    const info = this.db
      .prepare(
        `INSERT INTO sessions
          (web_rid, source, room_id, anchor_id, anchor_name, title, started_at, last_seen_live_at,
           partial, likes_start, likes_end, peak_viewers, avg_viewers, total_user, flags)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        rid,
        source,
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
        snap.total_user || "",
        opts.flags ? JSON.stringify(opts.flags) : null
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

  /** 依事件/快照重算彙總（live 期間每 30 秒也跑，讓複盤頁即時有數字） */
  refreshSummary(
    sid: number,
    finalSnap?: RoomSnapshot | null,
    close = false
  ): SessionSummary {
    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='Gift' THEN diamonds ELSE 0 END),0) AS gift_diamonds,
           SUM(CASE WHEN type='Gift' THEN 1 ELSE 0 END)                    AS gift_events,
           SUM(CASE WHEN type='Chat' THEN 1 ELSE 0 END)                    AS chat_count,
           COUNT(DISTINCT CASE WHEN type='Chat' THEN nickname END)         AS chat_users,
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
        `SELECT COUNT(*)        AS snap_count,
                AVG(viewers)    AS avg_viewers,
                MAX(viewers)    AS peak_viewers,
                MIN(like_count) AS min_like,
                MAX(like_count) AS max_like
         FROM snapshots WHERE session_id=?`
      )
      .get(sid) as {
      snap_count: number | null;
      avg_viewers: number | null;
      peak_viewers: number | null;
      min_like: number | null;
      max_like: number | null;
    };

    const firstLike = this.db
      .prepare("SELECT like_count FROM snapshots WHERE session_id=? ORDER BY ts LIMIT 1")
      .get(sid) as { like_count: number | null } | undefined;

    const summary: SessionSummary = {
      gift_diamonds: agg.gift_diamonds || 0,
      gift_events: agg.gift_events || 0,
      chat_count: agg.chat_count || 0,
      chat_users: agg.chat_users || 0,
      member_count: agg.member_count || 0,
      snapshot_count: snaps.snap_count || 0,
      avg_viewers: Math.round((snaps.avg_viewers || 0) * 10) / 10,
      peak_viewers: snaps.peak_viewers || 0,
      likes_start: (firstLike?.like_count ?? 0) || snaps.min_like || 0,
      likes_end: finalSnap?.like_count || snaps.max_like || 0,
    };
    if (close) summary.ended_at = this.now();

    const sets = Object.keys(summary)
      .map((k) => `${k}=?`)
      .join(", ");
    this.db
      .prepare(`UPDATE sessions SET ${sets} WHERE id=?`)
      .run(...Object.values(summary), sid);
    return summary;
  }

  closeSession(sid: number, finalSnap?: RoomSnapshot | null): SessionSummary {
    return this.refreshSummary(sid, finalSnap, true);
  }

  getSession(sid: number): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id=?").get(sid) as
      | SessionRow
      | undefined;
  }

  /** 某房最近一場（下播小結用；不分 source） */
  latestSession(webRid: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE web_rid=? ORDER BY started_at DESC LIMIT 1")
      .get(webRid) as SessionRow | undefined;
  }

  // ---------- 寫入 API ----------
  addEvent(sid: number, ev: Record<string, unknown>): void {
    this.put({
      kind: "event",
      args: [
        sid,
        (ev.ts as number) || this.now(),
        ev.type,
        ev.nickname ?? null,
        ev.user_id ?? null,
        ev.content ?? null,
        ev.gift_id ?? null,
        ev.gift_name ?? null,
        ev.repeat ?? null,
        ev.diamonds ?? null,
        (ev.msg_id as string) || "",
        null,
      ],
    });
  }

  addSnapshot(sid: number, snap: RoomSnapshot): void {
    this.put({
      kind: "snapshot",
      args: [sid, snap.ts || this.now(), snap.status, snap.viewers, snap.like_count, snap.total_user],
    });
  }

  addRank(
    sid: number,
    kind: string,
    rows: ReadonlyArray<Partial<RankMember> & { count?: number }>,
    ts?: number
  ): void {
    const at = ts ?? this.now();
    for (const r of rows || []) {
      this.put({
        kind: "rank",
        args: [
          sid,
          at,
          kind,
          r.rank ?? null,
          r.nickname ?? null,
          r.score ?? r.diamonds ?? 0,
          r.level ?? r.pay_level ?? 0,
          JSON.stringify(r),
        ],
      });
    }
  }

  addFans(sid: number, meta: Partial<FansMeta>, members: FansMember[]): void {
    this.put({
      kind: "fans",
      args: [
        sid,
        this.now(),
        meta.club_name ?? null,
        meta.fans_name ?? null,
        meta.active ?? null,
        meta.total ?? null,
        meta.today_new ?? null,
        meta.guard ? 1 : 0,
        JSON.stringify(members || []),
      ],
    });
  }

  saveCatalog(catalog: Record<string | number, GiftCatalogEntry>): void {
    const entries = Object.entries(catalog ?? {});
    if (entries.length === 0) return;
    const now = this.now();
    const stmt = this.db.prepare(
      `INSERT INTO gift_catalog(gift_id,name,diamond,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(gift_id) DO UPDATE SET
         name=excluded.name, diamond=excluded.diamond, updated_at=excluded.updated_at`
    );
    const tx = this.db.transaction(() => {
      for (const [gid, v] of entries) {
        stmt.run(Number(gid), v.name, v.diamond, now);
      }
    });
    tx();
  }

  getCatalog(giftId: number): GiftCatalogEntry | undefined {
    return this.db
      .prepare("SELECT name, diamond FROM gift_catalog WHERE gift_id=?")
      .get(giftId) as GiftCatalogEntry | undefined;
  }

  catalogSize(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM gift_catalog").get() as { c: number }).c;
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
    return this.db.prepare("SELECT * FROM targets WHERE web_rid=?").get(webRid) as
      | TargetRow
      | undefined;
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
      "capture",
      "cap_chat",
      "cap_gift",
      "cap_member",
      "cap_snap",
      "cap_rank",
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
    this.db
      .prepare(`UPDATE targets SET ${sets.join(", ")} WHERE web_rid=?`)
      .run(...args, webRid);
  }

  deleteTarget(webRid: string): void {
    this.db.prepare("DELETE FROM targets WHERE web_rid=?").run(webRid);
  }

  /** 該房有效的收錄 flags；沒設定或總開關關閉 → 全部 0 */
  targetFlags(webRid: string): CaptureFlags {
    const t = this.getTarget(webRid);
    if (!t) return { chat: 1, gift: 1, member: 1, snap: 1, rank: 1 };
    if (!t.capture) return { chat: 0, gift: 0, member: 0, snap: 0, rank: 0 };
    const out = {} as CaptureFlags;
    for (const k of CAPTURE_KEYS) {
      out[k] = Number(t[`cap_${k}` as keyof TargetRow] ?? 1) ? 1 : 0;
    }
    return out;
  }

  static flagsAny(flags: Partial<CaptureFlags> | null | undefined): boolean {
    return Object.values(flags ?? {}).some(Boolean);
  }

  /** 五項全關 → capture=0；任一開啟 → capture=1（後端自動同步） */
  syncCaptureSwitch(webRid: string): void {
    const t = this.getTarget(webRid);
    if (!t) return;
    const any = CAPTURE_KEYS.some((k) => Number(t[`cap_${k}` as keyof TargetRow] ?? 1));
    this.updateTarget(webRid, { capture: any ? 1 : 0 });
  }

  // ---------- 通知紀錄 ----------
  addNotification(
    webRid: string,
    kind: string,
    ok: boolean,
    error = "",
    text = ""
  ): void {
    this.db
      .prepare("INSERT INTO notifications(ts,web_rid,kind,ok,error,text) VALUES(?,?,?,?,?,?)")
      .run(this.now(), webRid, kind, ok ? 1 : 0, error || "", (text || "").slice(0, 2000));
  }

  listNotifications(limit = 20): NotificationRow[] {
    return this.db
      .prepare("SELECT * FROM notifications ORDER BY ts DESC, id DESC LIMIT ?")
      .all(limit) as NotificationRow[];
  }

  // ---------- 設定（meta） ----------
  getSetting(key: string, fallback = ""): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  setSetting(key: string, value: string | number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)")
      .run(key, String(value));
  }

  // ---------- 維運 ----------
  sizeBytes(): number {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += fs.statSync(this.path + suffix).size;
      } catch {
        // 檔案不存在屬正常
      }
    }
    return total;
  }

  /** 每小時最多檢查一次；回傳目前是否超標 */
  checkSize(): boolean {
    if (this.now() - this.lastSizeCheck < 3600) return this.sizeWarning;
    this.lastSizeCheck = this.now();
    const size = this.sizeBytes();
    const warn = size >= this.maxBytes;
    if (warn !== this.sizeWarning) {
      this.sizeWarning = warn;
      this.log(
        `[db] 目前 ${(size / GB).toFixed(2)} GB${warn ? "（已超過提醒門檻）" : ""}`
      );
    }
    return warn;
  }

  /** WAL 定期截斷（104MB/日 的寫入量不 checkpoint 會失控） */
  walCheckpoint(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      this.log(`[db] wal_checkpoint 失敗：${(err as Error).message}`);
    }
  }

  // ---------- 對帳 ----------
  selfcheck(sid: number): {
    ok: boolean;
    session?: SessionRow;
    events_agg?: Record<string, number>;
    diff?: Record<string, number>;
    error?: string;
  } {
    const session = this.getSession(sid);
    if (!session) return { ok: false, error: "session 不存在" };
    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='Gift' THEN diamonds ELSE 0 END),0) AS gift_diamonds,
           SUM(CASE WHEN type='Gift' THEN 1 ELSE 0 END)                    AS gift_events,
           SUM(CASE WHEN type='Chat' THEN 1 ELSE 0 END)                    AS chat_count,
           COUNT(DISTINCT CASE WHEN type='Chat' THEN nickname END)         AS chat_users,
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
    const diff = {
      gift_diamonds: (session.gift_diamonds || 0) - (agg.gift_diamonds || 0),
      gift_events: (session.gift_events || 0) - (agg.gift_events || 0),
      chat_count: (session.chat_count || 0) - (agg.chat_count || 0),
      chat_users: (session.chat_users || 0) - (agg.chat_users || 0),
      member_count: (session.member_count || 0) - (agg.member_count || 0),
    };
    return {
      ok: Object.values(diff).every((v) => v === 0),
      session,
      events_agg: {
        gift_diamonds: agg.gift_diamonds || 0,
        gift_events: agg.gift_events || 0,
        chat_count: agg.chat_count || 0,
        chat_users: agg.chat_users || 0,
        member_count: agg.member_count || 0,
      },
      diff,
    };
  }
}
