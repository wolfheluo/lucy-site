// =====================================================================
//  dy-monitor 引擎（Monitor + Warden 合一，in-process 定時器）
//  - Monitor：選中房 3s（離線 60s）快照、彈幕 4s、觀眾榜 30s、親密度 60s
//  - Warden：背景房狀態 60s、擷取 10s、快照 60s、榜單 60s
//  - 面板顯示與 DB 收錄脫鉤：顯示永遠全量，寫 DB 受 v4 五項 flags 控制
//  - pm2 instance 鎖：只有 NODE_APP_INSTANCE=0（或未設）才啟動引擎，
//    避免 cluster 多實例各自抓同一批房、重複送通知、重複建場次。
// =====================================================================
import type { DyMonitorStore } from "./store.js";
import type { AudienceResult } from "./dycore.js";
import type {
  CaptureFlags,
  DecodedIm,
  DyMessage,
  FansMeta,
  FansRank,
  GiftCatalogEntry,
  RankMember,
  RoomSnapshot,
  TargetRow,
} from "../types.js";
import { buildEndMessage, buildLiveMessage, formatTime, type EndSummaryLike } from "./line.js";

export interface DyClientLike {
  roomSnapshot(
    webRid: string,
    opts?: { timeoutMs?: number; retries?: number }
  ): Promise<RoomSnapshot | null>;
  fetchChat(roomId: string, cursor?: string): Promise<DecodedIm>;
  audienceList(snap: RoomSnapshot, count?: number): Promise<AudienceResult>;
  fansClubRank(anchorId: string, count?: number): Promise<FansRank>;
  fansClubMeta(anchorId: string): Promise<Partial<FansMeta>>;
  giftCatalog(roomId: string, anchorId: string): Promise<Record<string, GiftCatalogEntry>>;
}

export type NotifyKind = "live" | "end" | "test";
export type DyNotifier = (
  kind: NotifyKind,
  webRid: string | null,
  text: string
) => Promise<{ ok: boolean; error: string }>;

export interface DyIntervals {
  statsLive: number;
  statsOffline: number;
  chat: number;
  rank: number;
  fans: number;
  status: number;
  capture: number;
  snapshot: number;
  snapshotBg: number;
  rankBg: number;
  catalogTtl: number;
  cooldown: number;
  touch: number;
  maintenance: number;
}

export const DEFAULT_INTERVALS: DyIntervals = {
  statsLive: 3,
  statsOffline: 60,
  chat: 4,
  rank: 30,
  fans: 60,
  status: 60,
  capture: 10,
  snapshot: 30,
  snapshotBg: 60,
  rankBg: 60,
  catalogTtl: 3600,
  cooldown: 300,
  touch: 15,
  maintenance: 600,
};

/** 軟上限：需求是 1~3 間；超過就拒絕，避免同 IP 高頻被風控 */
export const MAX_TARGETS = 5;
const SERIES_MAX = 400;
const CHAT_MAX = 300;
const SEEN_MAX = 800;

export interface DyEngineOptions {
  store: DyMonitorStore;
  client: DyClientLike;
  notifier?: DyNotifier;
  dashboardUrl?: string;
  log?: (message: string) => void;
  intervals?: Partial<DyIntervals>;
  maxTargets?: number;
  chatConcurrency?: number;
  /** pm2 cluster 的 NODE_APP_INSTANCE；非 "0" 時不啟動引擎 */
  instanceId?: string | null;
  /** a_bogus 簽名是否已可用（P1=false，P2 接上後 true） */
  abogusReady?: boolean;
  now?: () => number;
}

interface ChatRow extends DyMessage {
  id: number;
  diamonds?: number;
}

type SeriesPoint = { ts: number; viewers: number; likes: number; status: number };

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

export class DyEngine {
  readonly store: DyMonitorStore;
  readonly client: DyClientLike;
  readonly intervals: DyIntervals;
  readonly maxTargets: number;

  private readonly notifier: DyNotifier;
  private readonly dashboardUrl: string;
  private readonly log: (message: string) => void;
  private readonly instanceId: string | null;
  private readonly now: () => number;
  private readonly chatSlots: Semaphore;
  private readonly abogusReady: boolean;

  // ── Monitor（選中房）──
  selectedRid = "";
  roomUrl = "";
  snapshot: RoomSnapshot | null = null;
  stale = false;
  private series: SeriesPoint[] = [];
  private chat: ChatRow[] = [];
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private chatId = 0;
  rank: RankMember[] = [];
  fans: Partial<FansRank> = {};
  fansMeta: Partial<FansMeta> = {};
  fansOk = false;
  rankOk = false;
  chatOk = false;
  private catalog: Record<string, GiftCatalogEntry> = {};
  private catalogTs = 0;
  private catalogBusy = false;
  private giftTotal = 0;
  private giftEvents = 0;
  private gifters = new Map<string, { diamonds: number; count: number }>();
  private inter = {
    chat: 0,
    chatUsers: new Set<string>(),
    member: 0,
    like: 0,
    since: Date.now() / 1000,
  };
  private sid: number | null = null;
  private chatCursor = "";
  private lastRank = 0;
  private lastFans = 0;
  private lastTouch = 0;
  private lastDbSnap = 0;
  private flagsCache: { at: number; flags: CaptureFlags } | null = null;
  private readonly cache = new Map<string, RoomSnapshot>();
  private startedAt = Date.now() / 1000;
  private errors: { ts: number; msg: string }[] = [];
  private ts = { rank: 0, fans: 0, gift: 0, chat: 0 };

  // ── Warden（背景房）──
  private wardenCursors = new Map<string, string>();
  private wardenSids = new Map<string, number>();
  private wardenSnaps = new Map<string, RoomSnapshot>();
  private wardenLastSnap = new Map<string, number>();
  private wardenLastRank = new Map<string, number>();

  private timers: Record<string, NodeJS.Timeout | undefined> = {};
  private stopped = true;

  constructor(opts: DyEngineOptions) {
    this.store = opts.store;
    this.client = opts.client;
    this.intervals = { ...DEFAULT_INTERVALS, ...(opts.intervals ?? {}) };
    this.maxTargets = opts.maxTargets ?? MAX_TARGETS;
    this.notifier = opts.notifier ?? (async () => ({ ok: false, error: "LINE 未設定（未送出）" }));
    this.dashboardUrl = opts.dashboardUrl ?? "";
    this.log = opts.log ?? ((m) => console.log(m));
    this.instanceId = opts.instanceId ?? process.env.NODE_APP_INSTANCE ?? null;
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.chatSlots = new Semaphore(opts.chatConcurrency ?? 3);
    this.abogusReady = opts.abogusReady ?? false;
  }

  // ---------- 生命週期 ----------
  start(initialRid = ""): void {
    if (!this.stopped) return;
    if (this.instanceId !== null && this.instanceId !== "" && this.instanceId !== "0") {
      this.log(`[dy] NODE_APP_INSTANCE=${this.instanceId} → 本實例不啟動引擎（避免重複收錄）`);
      return;
    }
    const stored = this.store.getSetting("selected_web_rid", "");
    this.selectedRid = initialRid || stored;
    this.roomUrl = this.selectedRid ? `https://live.douyin.com/${this.selectedRid}` : "";
    this.startedAt = this.now();
    this.stopped = false;
    this.store.start();
    this.store.setSetting("engine_owner", `${process.pid}@${new Date().toISOString()}`);
    this.loop("stats", () => this.statsDelay(), () => this.tickStats());
    this.loop("chat", () => this.intervals.chat, () => this.tickChat());
    this.loop("status", () => this.intervals.status, () => this.tickStatus());
    this.loop("capture", () => this.intervals.capture, () => this.tickCapture());
    this.loop("maintenance", () => this.intervals.maintenance, () => this.tickMaintenance());
    this.log(`[dy] 引擎啟動（selected=${this.selectedRid || "未指定"}）`);
  }

  stop(): void {
    this.stopped = true;
    for (const key of Object.keys(this.timers)) {
      const t = this.timers[key];
      if (t) clearTimeout(t);
      this.timers[key] = undefined;
    }
    if (this.sid) {
      try {
        this.store.closeSession(this.sid, this.snapshot);
      } catch {
        // 結案失敗不影響關機
      }
      this.sid = null;
    }
  }

  get running(): boolean {
    return !this.stopped;
  }

  private loop(name: string, delayMs: () => number, fn: () => Promise<void>): void {
    const run = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        this.err(`${name} 失敗：${(err as Error).name} ${(err as Error).message}`);
      }
      if (this.stopped) return;
      this.timers[name] = setTimeout(run, Math.max(0.5, delayMs()) * 1000);
    };
    this.timers[name] = setTimeout(run, 0);
  }

  private statsDelay(): number {
    return this.snapshot?.status === 2 ? this.intervals.statsLive : this.intervals.statsOffline;
  }

  private err(msg: string): void {
    this.errors = [{ ts: this.now(), msg }, ...this.errors].slice(0, 8);
    this.log(`[dy] ${msg}`);
  }

  // ---------- 選中房切換 ----------
  select(roomUrlOrRid: string): boolean {
    const rid = parseRid(roomUrlOrRid);
    if (!rid) return false;
    if (this.sid) {
      try {
        this.store.closeSession(this.sid, this.snapshot);
      } catch {
        // 忽略
      }
      this.sid = null;
    }
    if (this.snapshot?.web_rid) this.cache.set(this.snapshot.web_rid, this.snapshot);
    this.selectedRid = rid;
    this.roomUrl = rid ? `https://live.douyin.com/${rid}` : "";
    this.snapshot = this.cache.get(rid) ?? null;
    this.stale = Boolean(this.snapshot);
    this.series = [];
    this.rank = [];
    this.fans = {};
    this.fansMeta = {};
    this.fansOk = false;
    this.rankOk = false;
    this.chatOk = false;
    this.ts = { rank: 0, fans: 0, gift: 0, chat: 0 };
    this.catalog = {};
    this.catalogTs = 0;
    this.giftTotal = 0;
    this.giftEvents = 0;
    this.gifters = new Map();
    this.inter = { chat: 0, chatUsers: new Set(), member: 0, like: 0, since: this.now() };
    this.chat = [];
    this.seen = [];
    this.seenSet = new Set();
    this.chatCursor = "";
    this.flagsCache = null;
    this.store.setSetting("selected_web_rid", rid);
    this.log(`[dy] 切換選中房 → ${rid}`);
    return true;
  }

  // ---------- flags（10 秒快取；只影響寫 DB，不影響面板）----------
  private flags(): CaptureFlags {
    const now = this.now();
    if (!this.flagsCache || now - this.flagsCache.at > 10) {
      try {
        this.flagsCache = { at: now, flags: this.store.targetFlags(this.selectedRid) };
      } catch {
        this.flagsCache = { at: now, flags: { chat: 1, gift: 1, member: 1, snap: 1, rank: 1 } };
      }
    }
    return this.flagsCache.flags;
  }

  // ---------- Monitor：房間快照 ----------
  async tickStats(): Promise<void> {
    const rid = this.selectedRid;
    if (!rid) return;
    try {
      const snap = await this.client.roomSnapshot(rid, { timeoutMs: 10_000, retries: 1 });
      if (rid !== this.selectedRid) return; // 抓取途中被切房 → 丟棄
      if (!snap) {
        this.stale = true;
        this.err("房間快照為空（房間不存在或已下播）");
        return;
      }
      this.trackSession(snap);
      this.snapshot = snap;
      this.cache.set(rid, snap);
      this.stale = false;
      this.series.push({
        ts: snap.ts,
        viewers: snap.viewers,
        likes: snap.like_count,
        status: snap.status,
      });
      if (this.series.length > SERIES_MAX) this.series.splice(0, this.series.length - SERIES_MAX);

      const now = this.now();
      if (snap.status === 2 && now - this.lastRank > this.intervals.rank) {
        await this.refreshRank(snap);
        this.snapshotContribution();
      }
      if (snap.status === 2 && now - this.lastFans > this.intervals.fans) {
        await this.refreshFans(snap);
      }
      this.ensureCatalog(snap);
    } catch (err) {
      this.stale = true;
      this.err(`快照失敗：${(err as Error).name}（保留上次資料）`);
    }
  }

  private trackSession(snap: RoomSnapshot): void {
    try {
      const now = this.now();
      if (snap.status === 2) {
        const flags = this.flags();
        const { id, resumed } = this.store.ensureSession(snap, { source: "app", flags });
        if (id !== this.sid) {
          this.sid = id;
          this.log(`[dy] ${resumed ? "續接" : "新開"}場次 #${id}（${snap.web_rid}）`);
          // 續接同一場：先把 DB 已收錄的禮物接回記憶體，避免重啟後面板從 0 起算
          if (resumed) this.hydrateGifts(id);
        }
        if (now - this.lastTouch > this.intervals.touch) {
          this.store.touchSession(id, snap);
          this.lastTouch = now;
        }
        if (flags.snap && now - this.lastDbSnap > this.intervals.snapshot) {
          this.store.addSnapshot(id, snap);
          this.lastDbSnap = now;
          this.store.refreshSummary(id, snap);
        }
      } else if (this.sid) {
        const last = this.snapshot?.ts ?? 0;
        if (now - last > this.store.liveTolerance) {
          this.store.closeSession(this.sid, this.snapshot);
          this.log(`[dy] 場次 #${this.sid} 結案（離開直播超過 ${this.store.liveTolerance}s）`);
          this.sid = null;
        }
      }
    } catch (err) {
      this.err(`DB 場次失敗：${(err as Error).name}`);
    }
  }

  private async refreshRank(snap: RoomSnapshot): Promise<void> {
    this.lastRank = this.now();
    if (!this.abogusReady) return; // 簽名未啟用：直接跳過，不打端點也不記錯誤
    const rid = snap.web_rid;
    try {
      const res = await this.client.audienceList(snap);
      const ranks = res.members ?? [];
      if (rid !== this.selectedRid) return;
      if (ranks.length > 0) {
        this.rank = ranks;
        this.rankOk = true;
        this.ts.rank = this.now();
        if (this.sid && this.flags().rank) this.store.addRank(this.sid, "audience", ranks);
      } else {
        this.rankOk = false;
      }
    } catch (err) {
      this.rankOk = false;
      this.err(`榜單失敗：${(err as Error).message}`);
    }
  }

  private async refreshFans(snap: RoomSnapshot): Promise<void> {
    this.lastFans = this.now();
    const rid = snap.web_rid;
    try {
      const fans = await this.client.fansClubRank(snap.anchor_id);
      if (rid !== this.selectedRid) return;
      let meta: Partial<FansMeta> = {};
      try {
        meta = await this.client.fansClubMeta(snap.anchor_id);
      } catch {
        meta = {};
      }
      if (fans && fans.members.length > 0) {
        this.fans = fans;
        this.fansMeta = meta;
        this.fansOk = true;
        this.ts.fans = this.now();
        if (this.sid) {
          const merged: Partial<FansMeta> = { ...meta };
          if (!merged.club_name) merged.club_name = fans.club_name;
          if (!merged.fans_name) merged.fans_name = fans.fans_name;
          if (!merged.active) merged.active = fans.active;
          if (!merged.total) merged.total = fans.total;
          if (this.flags().rank) this.store.addFans(this.sid, merged, fans.members);
        }
      } else {
        this.fansOk = false;
      }
    } catch (err) {
      this.fansOk = false;
      this.err(`親密度榜失敗：${(err as Error).name}`);
    }
  }

  /** 續接既有場次時，把 DB 已收錄的禮物接回記憶體（重啟後面板與複盤才會一致） */
  private hydrateGifts(sid: number): void {
    try {
      const g = this.store.giftSummary(sid);
      if (!g.events) return;
      this.gifters = new Map(g.top.map((r) => [r.nickname, { diamonds: r.diamonds, count: r.count }]));
      this.giftTotal = g.total;
      this.giftEvents = g.events;
      this.log(
        `[dy] 場次 #${sid} 禮物回填：${g.events} 次 / ${g.total} 鑽 / ${g.top.length} 人`
      );
    } catch (err) {
      this.err(`禮物回填失敗：${(err as Error).message}`);
    }
  }

  private snapshotContribution(): void {
    if (!this.sid || this.gifters.size === 0) return;
    const rows = [...this.gifters.entries()]
      .map(([nickname, v]) => ({ nickname, diamonds: v.diamonds, count: v.count }))
      .sort((a, b) => b.diamonds - a.diamonds)
      .slice(0, 20)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    if (this.flags().gift) this.store.addRank(this.sid, "contribution", rows);
  }

  private ensureCatalog(snap: RoomSnapshot): void {
    const now = this.now();
    if (Object.keys(this.catalog).length > 0 && now - this.catalogTs < this.intervals.catalogTtl) return;
    if (this.catalogBusy) return;
    this.catalogBusy = true;
    const rid = snap.web_rid;
    void (async () => {
      try {
        const cat = await this.client.giftCatalog(snap.room_id, snap.anchor_id);
        if (rid === this.selectedRid && Object.keys(cat).length > 0) {
          this.catalog = cat;
          this.catalogTs = this.now();
          try {
            this.store.saveCatalog(cat);
          } catch {
            // 目錄寫入失敗不影響輪詢
          }
        }
      } catch (err) {
        this.err(`禮物目錄失敗：${(err as Error).name}`);
      } finally {
        this.catalogBusy = false;
      }
    })();
  }

  // ---------- Monitor：彈幕 ----------
  async tickChat(): Promise<void> {
    const snap = this.snapshot;
    if (!snap || !snap.room_id || snap.status !== 2) return;
    try {
      const { messages, cursor } = await this.chatSlots.run(() =>
        this.client.fetchChat(snap.room_id, this.chatCursor)
      );
      if (cursor) this.chatCursor = cursor;
      this.chatOk = true;
      this.pushChat(messages);
    } catch (err) {
      this.chatOk = false;
      this.err(`彈幕失敗：${(err as Error).name}`);
    }
  }

  private giftDiamonds(giftId: number, repeat: number): { diamonds: number; name: string } {
    const g = this.catalog[String(giftId)] ?? this.store.getCatalog(giftId);
    const rep = repeat || 1;
    return { diamonds: (g?.diamond ?? 0) * rep, name: g?.name ?? "" };
  }

  private pushChat(messages: DyMessage[]): void {
    for (const raw of messages) {
      const m: DyMessage = { ...raw };
      if (m.type === "Chat") {
        this.inter.chat += 1;
        if (m.nickname) this.inter.chatUsers.add(m.nickname);
      } else if (m.type === "Member") {
        this.inter.member += 1;
      } else if (m.type === "Like") {
        this.inter.like += 1;
      } else if (m.type === "Gift") {
        const rep = m.repeat || 1;
        const { diamonds, name } = this.giftDiamonds(m.gift_id || 0, rep);
        this.giftTotal += diamonds;
        this.giftEvents += 1;
        if (m.nickname) {
          const row = this.gifters.get(m.nickname) ?? { diamonds: 0, count: 0 };
          row.diamonds += diamonds;
          row.count += rep;
          this.gifters.set(m.nickname, row);
        }
        this.ts.gift = this.now();
        m.gift_name = m.gift_name || name || m.content || "禮物";
        m.diamonds = diamonds;
        m.content = m.gift_name + (rep > 1 ? ` ×${rep}` : "");
      }

      const key = m.msg_id || `${m.type}|${m.nickname}|${m.content}`;
      if (this.seenSet.has(key)) continue;
      this.seenSet.add(key);
      this.seen.push(key);
      if (this.seen.length >= SEEN_MAX) {
        const dropped = this.seen.shift();
        if (dropped) this.seenSet.delete(dropped);
      }
      this.chatId += 1;
      this.chat.push({ ...m, id: this.chatId });
      if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);

      if (this.sid && this.keepEvent(m)) {
        this.store.addEvent(this.sid, { ...m, diamonds: m.diamonds ?? null });
      }
    }
  }

  private keepEvent(m: DyMessage): boolean {
    const f = this.flags();
    if (m.type === "Chat") return Boolean(f.chat);
    if (m.type === "Gift") return Boolean(f.gift);
    if (m.type === "Member" || m.type === "Like") return Boolean(f.member);
    return false;
  }

  // ---------- Warden：狀態輪詢與通知 ----------
  async tickStatus(): Promise<void> {
    const targets = this.store.listTargets();
    for (const t of targets) {
      const rid = t.web_rid;
      let snap: RoomSnapshot | null = null;
      try {
        snap = await this.client.roomSnapshot(rid, { timeoutMs: 10_000, retries: 1 });
      } catch {
        continue;
      }
      if (!snap) continue;
      this.wardenSnaps.set(rid, snap);
      const now = this.now();
      const status = snap.status;
      const prev = t.last_status;
      if ((t.anchor_name ?? "") !== (snap.anchor_name ?? "")) {
        this.store.updateTarget(rid, { anchor_name: snap.anchor_name });
      }
      if (prev !== null && prev !== undefined && status !== prev) {
        const gap = now - (t.last_notify_at ?? 0);
        if (status === 2 && t.notify_live && gap > this.intervals.cooldown) {
          await this.send("live", rid, buildLiveMessage(snap, t, this.dashboardUrl));
          this.store.updateTarget(rid, { last_notify_at: now });
        } else if (status !== 2 && prev === 2 && t.notify_end && gap > this.intervals.cooldown) {
          await this.send(
            "end",
            rid,
            buildEndMessage(snap, t, this.latestSummary(rid), this.dashboardUrl)
          );
          this.store.updateTarget(rid, { last_notify_at: now });
        }
      }
      this.store.updateTarget(rid, { last_status: status, last_checked_at: now });
    }
  }

  private latestSummary(rid: string): EndSummaryLike | null {
    try {
      const row = this.store.latestSession(rid);
      if (!row) return null;
      return {
        gift_diamonds: row.gift_diamonds,
        gift_events: row.gift_events,
        chat_count: row.chat_count,
        chat_users: row.chat_users,
        member_count: row.member_count,
        snapshot_count: row.snapshot_count,
        avg_viewers: row.avg_viewers,
        peak_viewers: row.peak_viewers,
        likes_start: row.likes_start,
        likes_end: row.likes_end,
        started_at: row.started_at,
        ended_at: row.ended_at,
        partial: row.partial,
        flags: row.flags,
      };
    } catch {
      return null;
    }
  }

  private async send(kind: NotifyKind, rid: string | null, text: string): Promise<void> {
    let ok = false;
    let error = "";
    try {
      const res = await this.notifier(kind, rid, text);
      ok = res.ok;
      error = res.error;
    } catch (err) {
      error = `${(err as Error).name}: ${(err as Error).message}`;
    }
    try {
      this.store.addNotification(rid ?? "", kind, ok, error, text);
    } catch {
      // 記錄失敗不影響通知流程
    }
    this.log(`[dy] 通知 ${kind} ${rid ?? "-"} → ${ok ? "OK" : `FAIL ${error}`}`);
  }

  async testPush(): Promise<{ ok: boolean; error: string }> {
    const text =
      `✅ 抖音監控台測試推播\n時間 ${formatTime(this.now())}\n` +
      `監控清單 ${this.store.listTargets().length} 間` +
      (this.dashboardUrl ? `\n🖥 ${this.dashboardUrl}` : "");
    let ok = false;
    let error = "";
    try {
      const res = await this.notifier("test", null, text);
      ok = res.ok;
      error = res.error;
    } catch (err) {
      error = `${(err as Error).name}: ${(err as Error).message}`;
    }
    this.store.addNotification("", "test", ok, error, text);
    return { ok, error };
  }

  // ---------- Warden：背景房擷取 ----------
  async tickCapture(): Promise<void> {
    const now = this.now();
    const targets = this.store.listTargets();
    const jobs: Promise<void>[] = [];
    for (const t of targets) {
      const rid = t.web_rid;
      if (rid === this.selectedRid) continue; // 選中房由 Monitor 收錄
      const flags = this.store.targetFlags(rid);
      if (!flagsAny(flags) || t.last_status !== 2) {
        this.closeBackground(rid);
        continue;
      }
      jobs.push(this.captureOne(t, flags, now));
    }
    await Promise.all(jobs);
  }

  private async captureOne(t: TargetRow, flags: CaptureFlags, now: number): Promise<void> {
    const rid = t.web_rid;
    let snap = this.wardenSnaps.get(rid) ?? null;
    if (!snap || !snap.room_id) {
      try {
        snap = await this.client.roomSnapshot(rid, { timeoutMs: 10_000, retries: 1 });
        if (snap) this.wardenSnaps.set(rid, snap);
      } catch {
        return;
      }
    }
    if (!snap) return;

    const { id: sid } = this.store.ensureSession(snap, { source: "app", flags });
    this.wardenSids.set(rid, sid);

    if (flags.snap && now - (this.wardenLastSnap.get(rid) ?? 0) >= this.intervals.snapshotBg) {
      this.store.addSnapshot(sid, snap);
      this.store.flushNow();
      this.store.refreshSummary(sid, snap);
      this.wardenLastSnap.set(rid, now);
    }

    if (flags.rank && now - (this.wardenLastRank.get(rid) ?? 0) >= this.intervals.rankBg) {
      await this.captureRank(sid, snap);
      this.wardenLastRank.set(rid, now);
    }

    if (!(flags.chat || flags.gift || flags.member)) return;

    try {
      const { messages, cursor } = await this.chatSlots.run(() =>
        this.client.fetchChat(snap.room_id, this.wardenCursors.get(rid) ?? "")
      );
      if (cursor) this.wardenCursors.set(rid, cursor);
      for (const raw of messages) {
        if (!keepByFlags(raw, flags)) continue;
        const m: DyMessage = { ...raw };
        if (m.type === "Gift") {
          const { diamonds, name } = this.giftDiamonds(m.gift_id || 0, m.repeat || 1);
          m.gift_name = m.gift_name || name || "禮物";
          m.diamonds = diamonds;
          if (!m.content) m.content = m.gift_name + ((m.repeat || 1) > 1 ? ` ×${m.repeat}` : "");
        }
        this.store.addEvent(sid, { ...m, diamonds: m.diamonds ?? null });
      }
      this.store.flushNow();
    } catch (err) {
      this.log(`[dy] chat ${rid} 失敗：${(err as Error).name}`);
    }
  }

  private async captureRank(sid: number, snap: RoomSnapshot): Promise<void> {
    if (!this.abogusReady) return;
    try {
      const res = await this.client.audienceList(snap);
      if (res.members.length > 0) this.store.addRank(sid, "audience", res.members);
    } catch {
      // 簽名未啟用或端點失敗：不影響擷取
    }
    try {
      const fans = await this.client.fansClubRank(snap.anchor_id);
      if (fans && fans.members.length > 0) {
        let meta: Partial<FansMeta> = {};
        try {
          meta = (await this.client.fansClubMeta(snap.anchor_id)) ?? {};
        } catch {
          meta = {};
        }
        const merged: Partial<FansMeta> = { ...meta };
        for (const k of ["club_name", "fans_name", "active", "total"] as const) {
          if (!merged[k]) (merged as Record<string, unknown>)[k] = fans[k];
        }
        this.store.addFans(sid, merged, fans.members);
      }
    } catch {
      // 同上
    }
    this.store.flushNow();
  }

  private closeBackground(rid: string): void {
    const sid = this.wardenSids.get(rid);
    if (sid) {
      this.store.closeSession(sid);
      this.wardenSids.delete(rid);
    }
    this.wardenCursors.delete(rid);
  }

  // ---------- 維運 ----------
  async tickMaintenance(): Promise<void> {
    this.store.checkSize();
    this.store.walCheckpoint();
    this.store.setSetting("engine_heartbeat", String(Math.floor(this.now())));
  }

  // ---------- 對外查詢 ----------
  targetsWithState(): (TargetRow & { selected: boolean; status_text: string; caps_on: number })[] {
    return this.store.listTargets().map((t) => {
      const live = t.last_status === 2;
      const statusText = live
        ? "直播中"
        : t.last_status === 4
          ? "已下播"
          : t.last_status === 0
            ? "未開播"
            : "未知";
      const capsOn = ["cap_chat", "cap_gift", "cap_member", "cap_snap", "cap_rank"].filter((k) =>
        Number(t[k as keyof TargetRow] ?? 0)
      ).length;
      return { ...t, selected: t.web_rid === this.selectedRid, status_text: statusText, caps_on: capsOn };
    });
  }

  private interStats(): Record<string, number> {
    const mins = Math.max((this.now() - this.inter.since) / 60, 0.5);
    let likes = 0;
    let minsLike = mins;
    if (this.series.length >= 2) {
      const first = this.series[0]!;
      const last = this.series[this.series.length - 1]!;
      likes = Math.max(last.likes - first.likes, 0);
      minsLike = Math.max((last.ts - first.ts) / 60, 0.5);
    }
    const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      minutes: round(mins),
      chat: this.inter.chat,
      chat_users: this.inter.chatUsers.size,
      member: this.inter.member,
      like_events: this.inter.like,
      chat_per_min: round(this.inter.chat / mins),
      member_per_min: round(this.inter.member / mins),
      gift_per_min: round(this.giftEvents / mins, 2),
      likes_per_min: round(likes / minsLike),
    };
  }

  state(sinceId = 0): Record<string, unknown> {
    const giftTop = [...this.gifters.entries()]
      .map(([nickname, v]) => ({ nickname, ...v }))
      .sort((a, b) => b.diamonds - a.diamonds)
      .slice(0, 10);
    return {
      room: this.snapshot ?? {},
      loading: this.snapshot === null,
      stale: this.stale,
      series: this.series.slice(-240),
      rank: this.rank,
      fans: this.fans,
      fans_ok: this.fansOk,
      fans_meta: this.fansMeta,
      ts: { ...this.ts, now: this.now() },
      db: {
        session_id: this.sid,
        size_mb: Math.round((this.store.sizeBytes() / 1048576) * 10) / 10,
        warning: this.store.checkSize(),
      },
      gifts: {
        total_diamonds: this.giftTotal,
        events: this.giftEvents,
        catalog: Object.keys(this.catalog).length,
        top: giftTop,
      },
      inter: this.interStats(),
      chat: this.chat.filter((c) => c.id > sinceId).slice(-120),
      chat_cursor: this.chatId,
      api: { rank_ok: this.rankOk, chat_ok: this.chatOk, abogus: this.abogusReady },
      uptime: Math.floor(this.now() - this.startedAt),
      errors: this.errors.slice(0, 4),
      intervals: {
        stats: this.statsDelay(),
        chat: this.intervals.chat,
        rank: this.intervals.rank,
        fans: this.intervals.fans,
      },
      selected_web_rid: this.selectedRid,
    };
  }
}

export function parseRid(text: string | null | undefined): string | null {
  const m = /(\d{6,})/.exec(text ?? "");
  return m ? m[1]! : null;
}

function flagsAny(flags: CaptureFlags): boolean {
  return Boolean(flags.chat || flags.gift || flags.member || flags.snap || flags.rank);
}

export function keepByFlags(m: DyMessage, flags: CaptureFlags): boolean {
  if (m.type === "Chat") return Boolean(flags.chat);
  if (m.type === "Gift") return Boolean(flags.gift);
  if (m.type === "Member" || m.type === "Like") return Boolean(flags.member);
  return false;
}
