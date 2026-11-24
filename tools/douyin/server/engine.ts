// =====================================================================
//  DOUYIN 引擎（單一引擎：選中房 Monitor + 背景房 Warden）
//  - 選中房：快照 3s（離線 60s）、彈幕 4s、榜單 30s、親密度 60s
//  - 背景房：狀態 60s、快照 60s、榜單 60s、彈幕 10s（共用 semaphore）
//  - 一律先簽 a_bogus 的端點由 DyClient 處理；失敗退避（上限 5 分鐘）
//  - 反查只做 mark='mystery'，優先用 profiles 快取
// =====================================================================
import type { DyClient } from "./dycore.js";
import type { DyStore } from "./store.js";
import type {
  DyMessage,
  FansMeta,
  FansRank,
  GiftCatalogEntry,
  ProfileHit,
  RankMember,
  RoomSnapshot,
  TargetRow,
} from "../types.js";
import { canonicalIdentity } from "./identity.js";
import { buildEndMessage, buildLiveMessage, formatTime, type EndSummaryLike } from "./line.js";

export interface ProfileResolverLike {
  resolve(idOrHandle: string): Promise<ProfileHit | null>;
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
  resolve: number;
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
  resolve: 8,
};

export const MAX_TARGETS = 3;
const SERIES_MAX = 400;
const CHAT_MAX = 300;
const SEEN_MAX = 800;
const PROFILE_TTL_SEC = 30 * 86400;

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
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

interface ChatRow extends DyMessage {
  id: number;
  uid: string;
}

type SeriesPoint = { ts: number; viewers: number; likes: number; status: number };

interface WardenState {
  snap: RoomSnapshot | null;
  cursor: string;
  sid: number | null;
  lastSnap: number;
  lastRank: number;
  failures: number;
  nextAt: number;
  observable: boolean;
}

export interface DyEngineOptions {
  store: DyStore;
  client: DyClient;
  resolver: ProfileResolverLike;
  notifier?: DyNotifier;
  dashboardUrl?: string;
  log?: (message: string) => void;
  intervals?: Partial<DyIntervals>;
  maxTargets?: number;
  chatConcurrency?: number;
  instanceId?: string | null;
  abogusReady?: boolean;
  now?: () => number;
}

export class DyEngine {
  readonly store: DyStore;
  readonly client: DyClient;
  readonly intervals: DyIntervals;
  readonly maxTargets: number;

  private readonly resolver: ProfileResolverLike;
  private readonly notifier: DyNotifier;
  private readonly dashboardUrl: string;
  private readonly log: (message: string) => void;
  private readonly instanceId: string | null;
  private readonly now: () => number;
  private readonly chatSlots: Semaphore;
  private readonly abogusReady: boolean;

  // ── 選中房 ──
  selectedRid = "";
  roomUrl = "";
  snapshot: RoomSnapshot | null = null;
  stale = false;
  private series: SeriesPoint[] = [];
  private chat: ChatRow[] = [];
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private chatId = 0;
  private chatCursor = "";
  private sid: number | null = null;
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
  private gifterNames = new Map<string, string>();
  private inter = {
    chat: 0,
    chatUsers: new Set<string>(),
    member: 0,
    like: 0,
    since: Date.now() / 1000,
  };
  private lastRank = 0;
  private lastFans = 0;
  private lastTouch = 0;
  private lastDbSnap = 0;
  private lastChatErrAt = 0;
  private ts = { rank: 0, fans: 0, gift: 0, chat: 0 };

  // ── 背景房 ──
  private warden = new Map<string, WardenState>();
  private wardenSnaps = new Map<string, RoomSnapshot>();

  // ── 反查 ──
  private resolveQueue: string[] = [];
  private resolveSet = new Set<string>();

  // ── 維運 ──
  private failures = new Map<string, number>();
  private errors: { ts: number; msg: string }[] = [];
  private timers: Record<string, NodeJS.Timeout | undefined> = {};
  private startedAt = Date.now() / 1000;
  private stopped = true;

  constructor(opts: DyEngineOptions) {
    this.store = opts.store;
    this.client = opts.client;
    this.resolver = opts.resolver;
    this.intervals = { ...DEFAULT_INTERVALS, ...(opts.intervals ?? {}) };
    this.maxTargets = opts.maxTargets ?? MAX_TARGETS;
    this.notifier = opts.notifier ?? (async () => ({ ok: false, error: "LINE 未設定（未送出）" }));
    this.dashboardUrl = opts.dashboardUrl ?? "";
    this.log = opts.log ?? ((m) => console.log(m));
    this.instanceId = opts.instanceId ?? process.env.NODE_APP_INSTANCE ?? null;
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.chatSlots = new Semaphore(opts.chatConcurrency ?? 3);
    this.abogusReady = opts.abogusReady ?? true;
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
    this.loop("resolve", () => this.intervals.resolve, () => this.tickResolve());
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
        /* 關機路徑不拋錯 */
      }
      this.sid = null;
    }
  }

  get running(): boolean {
    return !this.stopped;
  }

  private loop(name: string, delaySec: () => number, fn: () => Promise<void>): void {
    const run = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        this.err(`${name} 失敗：${(err as Error).name} ${(err as Error).message}`);
      }
      if (this.stopped) return;
      const delay = Math.max(0.5, Math.min(300, delaySec()));
      this.timers[name] = setTimeout(run, delay * 1000);
    };
    this.timers[name] = setTimeout(run, 0);
  }

  private statsDelay(): number {
    const base = this.snapshot?.status === 2 ? this.intervals.statsLive : this.intervals.statsOffline;
    const f = this.failures.get(this.selectedRid) ?? 0;
    return Math.min(300, base * 2 ** Math.min(f, 4));
  }

  private err(msg: string): void {
    this.errors = [{ ts: this.now(), msg }, ...this.errors].slice(0, 8);
    this.log(`[dy] ${msg}`);
  }

  private fail(rid: string): void {
    this.failures.set(rid, Math.min(4, (this.failures.get(rid) ?? 0) + 1));
  }

  private resetFail(rid: string): void {
    this.failures.delete(rid);
  }

  // ---------- 選中房切換 ----------
  select(roomUrlOrRid: string): boolean {
    const rid = parseRid(roomUrlOrRid);
    if (!rid) return false;
    if (this.sid) {
      try {
        this.store.closeSession(this.sid, this.snapshot);
      } catch {
        /* ignore */
      }
      this.sid = null;
    }
    if (this.snapshot?.web_rid) this.wardenSnaps.set(this.snapshot.web_rid, this.snapshot);
    this.selectedRid = rid;
    this.roomUrl = `https://live.douyin.com/${rid}`;
    this.snapshot = this.wardenSnaps.get(rid) ?? null;
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
    this.gifterNames = new Map();
    this.inter = { chat: 0, chatUsers: new Set(), member: 0, like: 0, since: this.now() };
    this.chat = [];
    this.seen = [];
    this.seenSet = new Set();
    this.chatCursor = "";
    this.store.setSetting("selected_web_rid", rid);
    this.log(`[dy] 切換選中房 → ${rid}`);
    return true;
  }

  // ---------- 選中房：快照 ----------
  async tickStats(): Promise<void> {
    const rid = this.selectedRid;
    if (!rid) return;
    const target = this.store.getTarget(rid);
    if (target && !target.enabled) return;
    try {
      const snap = await this.client.roomSnapshot(rid, { timeoutMs: 10_000, retries: 1 });
      if (rid !== this.selectedRid) return;
      if (!snap) {
        // 端點回空＝房間不存在／已下播，不是網路錯誤：不要退避，改用離線節奏。
        this.stale = true;
        this.resetFail(rid);
        if (this.snapshot) {
          const off = { ...this.snapshot, status: 4, status_text: "已下播" };
          this.trackSelected(off);
          this.snapshot = off;
        }
        return;
      }
      this.trackSelected(snap);
      this.snapshot = snap;
      this.wardenSnaps.set(rid, snap);
      this.stale = false;
      this.resetFail(rid);
      this.series.push({ ts: snap.ts, viewers: snap.viewers, likes: snap.like_count, status: snap.status });
      if (this.series.length > SERIES_MAX) this.series.splice(0, this.series.length - SERIES_MAX);

      const now = this.now();
      if (snap.status === 2 && now - this.lastRank > this.intervals.rank) {
        await this.refreshRank(snap);
      }
      if (snap.status === 2 && now - this.lastFans > this.intervals.fans) {
        await this.refreshFans(snap);
      }
      await this.ensureCatalog(snap);
    } catch (err) {
      this.stale = true;
      this.fail(rid);
      this.err(`快照失敗：${(err as Error).name}（保留上次資料）`);
    }
  }

  private trackSelected(snap: RoomSnapshot): void {
    try {
      const now = this.now();
      if (snap.status === 2) {
        const { id, resumed } = this.store.ensureSession(snap);
        if (id !== this.sid) {
          this.sid = id;
          this.log(`[dy] ${resumed ? "續接" : "新開"}場次 #${id}（${snap.web_rid}）`);
          if (resumed) this.hydrateGifts(id);
        }
        if (now - this.lastTouch > this.intervals.touch) {
          this.store.touchSession(id, snap);
          this.lastTouch = now;
        }
        if (snap.viewers > 0 && now - this.lastDbSnap > this.intervals.snapshot) {
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

  private hydrateGifts(sid: number): void {
    try {
      const g = this.store.giftSummary(sid);
      if (!g.events) return;
      this.gifters = new Map(g.top.map((r) => [r.uid, { diamonds: r.diamonds, count: r.count }]));
      this.gifterNames = new Map(g.top.map((r) => [r.uid, r.nickname]));
      this.giftTotal = g.total;
      this.giftEvents = g.events;
      this.log(`[dy] 場次 #${sid} 禮物回填：${g.events} 次 / ${g.total} 鑽`);
    } catch (err) {
      this.err(`禮物回填失敗：${(err as Error).message}`);
    }
  }

  private async refreshRank(snap: RoomSnapshot): Promise<void> {
    this.lastRank = this.now();
    if (!this.abogusReady) return;
    try {
      const res = await this.client.audienceList(snap);
      if (snap.web_rid !== this.selectedRid) return;
      if (res.members.length > 0) {
        this.rank = res.members;
        this.rankOk = true;
        this.ts.rank = this.now();
        if (this.sid) this.store.addRank(this.sid, "audience", res.members);
        if (this.sid && this.gifters.size > 0) this.snapshotContribution(this.sid);
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
    try {
      const fans = await this.client.fansClubRank(snap.anchor_id);
      if (snap.web_rid !== this.selectedRid) return;
      let meta: Partial<FansMeta> = {};
      try {
        meta = await this.client.fansClubMeta(snap.anchor_id);
      } catch {
        meta = {};
      }
      if (fans.members.length > 0) {
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
          this.store.addFans(this.sid, merged, fans.members);
        }
      } else {
        this.fansOk = false;
      }
    } catch (err) {
      this.fansOk = false;
      this.err(`親密度榜失敗：${(err as Error).name}`);
    }
  }

  private snapshotContribution(sid: number): void {
    const rows = [...this.gifters.entries()]
      .map(([uid, v]) => ({
        nickname: this.gifterNames.get(uid) ?? uid,
        diamonds: v.diamonds,
        count: v.count,
      }))
      .sort((a, b) => b.diamonds - a.diamonds)
      .slice(0, 20)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    this.store.addRank(sid, "contribution", rows);
  }

  private async ensureCatalog(snap: RoomSnapshot): Promise<void> {
    const now = this.now();
    if (Object.keys(this.catalog).length > 0 && now - this.catalogTs < this.intervals.catalogTtl) return;
    if (this.catalogBusy || !snap.room_id) return;
    this.catalogBusy = true;
    try {
      const cat = await this.client.giftCatalog(snap.room_id, snap.anchor_id);
      if (Object.keys(cat).length > 0) {
        this.catalog = { ...this.catalog, ...cat };
        this.catalogTs = now;
        this.store.saveCatalog(cat);
      }
    } catch (err) {
      this.err(`禮物目錄失敗：${(err as Error).name}`);
    } finally {
      this.catalogBusy = false;
    }
  }

  private giftValue = (giftId: number, repeat: number): { diamonds: number; name: string } => {
    const g = this.catalog[String(giftId)] ?? this.store.getCatalog(giftId);
    const rep = repeat || 1;
    return { diamonds: (g?.diamond ?? 0) * rep, name: g?.name ?? "" };
  };

  // ---------- 選中房：彈幕 ----------
  async tickChat(): Promise<void> {
    const snap = this.snapshot;
    if (!snap || !snap.room_id || snap.status !== 2 || !this.sid) return;
    const target = this.store.getTarget(snap.web_rid);
    if (target && !target.enabled) return;
    try {
      const { messages, cursor } = await this.chatSlots.run(() =>
        this.client.fetchChat(snap.room_id, this.chatCursor)
      );
      if (cursor) this.chatCursor = cursor;
      this.chatOk = true;
      const startedAt = this.store.getSession(this.sid)?.started_at ?? this.now();
      const observable =
        snap.viewers > 0 && snap.viewers <= 300 && this.now() - startedAt >= 120;
      this.handleMessages(snap, this.sid, messages, { selected: true, hiddenFlag: observable });
    } catch (err) {
      this.chatOk = false;
      const now = this.now();
      if (now - this.lastChatErrAt > 60) {
        this.lastChatErrAt = now;
        this.err(`彈幕失敗：${(err as Error).name}`);
      }
    }
  }

  /**
   * 事件入庫 + 記憶體累計。
   * 去重一定在累計之前（修正舊實作面板虛高）；DB 再做第二層去重。
   */
  private handleMessages(
    snap: RoomSnapshot,
    sid: number,
    messages: DyMessage[],
    opts: { selected: boolean; hiddenFlag: boolean }
  ): number {
    const accepted: { m: DyMessage; uid: string }[] = [];
    for (const raw of messages) {
      const m: DyMessage = { ...raw };
      if (m.type === "Like") {
        if (opts.selected) this.inter.like += 1;
        continue;
      }
      const identity = canonicalIdentity(m);
      if (!identity) continue;

      const key = m.msg_id || `${m.type}|${identity.uid}|${m.content}`;
      if (opts.selected) {
        if (this.seenSet.has(key)) continue;
        this.seenSet.add(key);
        this.seen.push(key);
        if (this.seen.length >= SEEN_MAX) {
          const dropped = this.seen.shift();
          if (dropped) this.seenSet.delete(dropped);
        }
      }

      if (opts.selected) {
        if (m.type === "Chat") {
          this.inter.chat += 1;
          this.inter.chatUsers.add(identity.uid);
        } else if (m.type === "Member") {
          this.inter.member += 1;
        } else if (m.type === "Gift") {
          const rep = m.repeat || 1;
          const g = this.giftValue(m.gift_id || 0, rep);
          this.giftTotal += g.diamonds;
          this.giftEvents += 1;
          const row = this.gifters.get(identity.uid) ?? { diamonds: 0, count: 0 };
          row.diamonds += g.diamonds;
          row.count += rep;
          this.gifters.set(identity.uid, row);
          if (m.nickname) this.gifterNames.set(identity.uid, m.nickname);
          this.ts.gift = this.now();
          m.gift_name = m.gift_name || g.name || "禮物";
          m.diamonds = g.diamonds;
          m.content = m.gift_name + (rep > 1 ? ` ×${rep}` : "");
        }
      } else if (m.type === "Gift" && !this.catalog[String(m.gift_id ?? 0)]) {
        void this.ensureCatalog(snap);
      }

      accepted.push({ m, uid: identity.uid });
      if (identity.mark === "mystery" && !identity.anonymous) this.enqueueResolve(sid, identity.uid);
    }

    const n = this.store.addMessages(
      sid,
      accepted.map((a) => a.m),
      { hiddenFlag: opts.hiddenFlag, giftValue: this.giftValue }
    );

    if (opts.selected) {
      for (const a of accepted) {
        this.chatId += 1;
        this.chat.push({ ...a.m, id: this.chatId, uid: a.uid });
      }
      if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
    }
    return n;
  }

  // ---------- 背景房：狀態與通知 ----------
  async tickStatus(): Promise<void> {
    const targets = this.store.listTargets();
    for (const t of targets) {
      if (!t.enabled) continue;
      const rid = t.web_rid;
      let snap: RoomSnapshot | null = null;
      try {
        snap = await this.client.roomSnapshot(rid, { timeoutMs: 10_000, retries: 1 });
      } catch {
        continue;
      }
      if (!snap) continue;
      this.wardenSnaps.set(rid, snap);
      const w = this.wardenState(rid);
      w.snap = snap;
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
          await this.send("end", rid, buildEndMessage(snap, t, this.latestSummary(rid), this.dashboardUrl));
          this.store.updateTarget(rid, { last_notify_at: now });
        }
      }
      this.store.updateTarget(rid, { last_status: status, last_checked_at: now });
      if (status !== 2) this.closeBackground(rid);
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
      /* 記錄失敗不影響通知流程 */
    }
    this.log(`[dy] 通知 ${kind} ${rid ?? "-"} → ${ok ? "OK" : `FAIL ${error}`}`);
  }

  async testPush(): Promise<{ ok: boolean; error: string }> {
    const text =
      `✅ 抖音直播測試推播\n時間 ${formatTime(this.now())}\n` +
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

  // ---------- 背景房：擷取 ----------
  private wardenState(rid: string): WardenState {
    let w = this.warden.get(rid);
    if (!w) {
      w = { snap: null, cursor: "", sid: null, lastSnap: 0, lastRank: 0, failures: 0, nextAt: 0, observable: false };
      this.warden.set(rid, w);
    }
    return w;
  }

  async tickCapture(): Promise<void> {
    const now = this.now();
    const jobs: Promise<void>[] = [];
    for (const t of this.store.listTargets()) {
      const rid = t.web_rid;
      if (!t.enabled || rid === this.selectedRid || t.last_status !== 2) {
        this.closeBackground(rid);
        continue;
      }
      const w = this.wardenState(rid);
      if (now < w.nextAt) continue;
      jobs.push(
        this.captureOne(t, w, now).catch((err) => {
          w.failures += 1;
          w.nextAt = now + Math.min(10 * 2 ** Math.min(w.failures, 4), 300);
          this.err(`背景房 ${rid} 擷取失敗：${(err as Error).name}`);
        })
      );
    }
    await Promise.all(jobs);
  }

  private async captureOne(t: TargetRow, w: WardenState, now: number): Promise<void> {
    const rid = t.web_rid;
    let snap = w.snap ?? this.wardenSnaps.get(rid) ?? null;
    if (!snap || !snap.room_id) {
      snap = await this.client.roomSnapshot(rid, { timeoutMs: 10_000, retries: 1 });
      if (snap) {
        w.snap = snap;
        this.wardenSnaps.set(rid, snap);
      }
    }
    if (!snap) return;

    const { id: sid } = this.store.ensureSession(snap);
    w.sid = sid;
    const startedAt = this.store.getSession(sid)?.started_at ?? now;
    w.observable = snap.viewers > 0 && snap.viewers <= 300 && now - startedAt >= 120;

    if (now - w.lastSnap >= this.intervals.snapshotBg) {
      this.store.addSnapshot(sid, snap);
      this.store.flushNow();
      this.store.refreshSummary(sid, snap);
      w.lastSnap = now;
    }
    if (now - w.lastRank >= this.intervals.rankBg) {
      await this.captureRank(sid, snap);
      w.lastRank = now;
    }
    if (!snap.room_id) return;

    const { messages, cursor } = await this.chatSlots.run(() =>
      this.client.fetchChat(snap.room_id, w.cursor)
    );
    if (cursor) w.cursor = cursor;
    this.handleMessages(snap, sid, messages, { selected: false, hiddenFlag: w.observable });
    this.store.flushNow();
    w.failures = 0;
    w.nextAt = 0;
  }

  private async captureRank(sid: number, snap: RoomSnapshot): Promise<void> {
    if (this.abogusReady) {
      try {
        const res = await this.client.audienceList(snap);
        if (res.members.length > 0) this.store.addRank(sid, "audience", res.members);
      } catch {
        /* 榜單失敗不影響擷取 */
      }
    }
    try {
      const fans = await this.client.fansClubRank(snap.anchor_id);
      if (fans.members.length > 0) {
        let meta: Partial<FansMeta> = {};
        try {
          meta = await this.client.fansClubMeta(snap.anchor_id);
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
      /* 同上 */
    }
    this.store.flushNow();
  }

  private closeBackground(rid: string): void {
    const w = this.warden.get(rid);
    if (!w) return;
    if (w.sid) {
      try {
        this.store.closeSession(w.sid);
      } catch {
        /* ignore */
      }
      w.sid = null;
    }
    w.cursor = "";
  }

  // ---------- 反查（只做 mystery） ----------
  private enqueueResolve(sid: number, uid: string): void {
    const p = this.store.getProfile(uid);
    if (p && this.now() - p.resolved_at < PROFILE_TTL_SEC) {
      try {
        this.store.setReal(sid, uid, p);
      } catch {
        /* 不在名單就忽略 */
      }
      return;
    }
    if (this.resolveSet.has(uid)) return;
    this.resolveSet.add(uid);
    this.resolveQueue.push(uid);
  }

  async tickResolve(): Promise<void> {
    const sid = this.sid;
    if (!sid) return;
    let done = 0;
    while (this.resolveQueue.length > 0 && done < 4) {
      const uid = this.resolveQueue.shift();
      if (!uid) break;
      this.resolveSet.delete(uid);
      try {
        const hit = await this.resolver.resolve(uid);
        if (hit) {
          this.store.setReal(sid, uid, hit);
          this.log(`[dy] 反查 ${uid} → ${hit.nickname}`);
        } else {
          this.store.bumpResolveTry(sid, uid);
        }
      } catch {
        // 暫時性錯誤：放回佇列，不計次
        this.enqueueResolve(sid, uid);
        break;
      }
      done += 1;
    }
  }

  // ---------- 維運 ----------
  async tickMaintenance(): Promise<void> {
    this.store.checkSize();
    this.store.walCheckpoint();
    this.store.setSetting("engine_heartbeat", String(Math.floor(this.now())));
  }

  // ---------- 對外查詢 ----------
  targetsWithState(): (TargetRow & { selected: boolean; status_text: string })[] {
    return this.store.listTargets().map((t) => ({
      ...t,
      selected: t.web_rid === this.selectedRid,
      status_text: statusText(t.last_status),
    }));
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
      .map(([uid, v]) => ({ uid, nickname: this.gifterNames.get(uid) ?? "", ...v }))
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

export function statusText(status: number | null | undefined): string {
  if (status === 2) return "直播中";
  if (status === 4) return "已下播";
  if (status === 0) return "未開播";
  return "未知";
}
