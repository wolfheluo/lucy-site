// =====================================================================
//  BINANCE QUANT 監控引擎（Python app.py 的 TypeScript 移植）
//  - 訂閱 Binance USDⓈ-M Combined Streams（trade / forceOrder / depth5 / markPrice）
//  - Rolling1mStats 增量滑窗取代 Numba JIT ring buffer
//  - REST 每 3 秒輪詢 OI；策略事件 / 大額強平寫入共享 SQLite
//  - subscriber 廣播：coalescing flush（≤ ~6 msg/s）→ SSE 推送
// =====================================================================
import type { Db } from "../../../server/db.js";
import type {
  BinanceParams,
  FeedAlert,
  FeedSignal,
  FeedSummary,
  FeedTrade,
  MonitorSnapshot,
  PanelUpdate,
  PositionView,
  PositionSide,
  StrategyId,
} from "../types.js";
import { resolveParams } from "./params.js";
import { Rolling1mStats } from "./rolling.js";
import {
  eventReason,
  eventTriggerJson,
  StrategyEngine,
  type StrategyOrderEvent,
  type StrategyPosition,
  type StrategySnapshot,
} from "./strategy.js";

const FLUSH_DELAY_MS = 160;
const RECONNECT_DELAY_MS = 3000;
const WATCHDOG_INTERVAL_MS = 20_000;
const STRATEGY_TICK_MS = 1000; // 策略節拍（B-1：1s bar 化）
/** 暖機所需資料跨度（<60s 因窗口本身只容納 60s、最舊樣本會被推出） */
const WARMUP_SPAN_MS = 55_000;
const WATCHDOG_IDLE_MS = 75_000;
const OI_FETCH_TIMEOUT_MS = 3000;

const MAX_RECENT_TRADES = 200;
const MAX_RECENT_ALERTS = 50;
const MAX_RECENT_SIGNALS = 50;

/** 依賴注入用的最小 WebSocket 形狀（Node global WebSocket 亦相容） */
export interface WsLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

export type EngineListener = (update: PanelUpdate) => void;

export interface EngineOptions {
  db: Db;
  params?: Partial<BinanceParams>;
  /** 時鐘注入（預設 Date.now；測試可控） */
  now?: () => number;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WsLike;
}

function asFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class BinanceMonitor {
  readonly params: BinanceParams;

  private readonly db: Db;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => WsLike;
  private readonly ring: Rolling1mStats;
  private readonly strategy: StrategyEngine;

  // 共享市場狀態（鏡像 Python HighFreqQuantSystem 欄位）
  private running = false;
  private connected = false;
  private startedAt = 0;
  private lastPrice = 0;
  private markPrice = 0;
  private fundingRate = 0;
  private openInterest = 0;
  private oiChange5s = 0;
  private readonly oiHistory: Array<[number, number]> = [];
  private depthImbalance = 0.5;
  private bidDepthVol = 0;
  private askDepthVol = 0;

  // 記憶體資料（newest-first）+ 兩次 flush 之間的 delta
  private readonly recentTrades: FeedTrade[] = [];
  private readonly recentAlerts: FeedAlert[] = [];
  private readonly recentSignals: FeedSignal[] = [];
  private readonly deltaTrades: FeedTrade[] = [];
  private readonly deltaAlerts: FeedAlert[] = [];
  private readonly deltaSignals: FeedSignal[] = [];

  // 連線 / 計時器
  private ws: WsLike | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private oiTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private strategyTimer: NodeJS.Timeout | null = null;
  private flushPending = false;
  private lastMessageAt = 0;
  /** 1 分鐘統計是否已暖機（B-2：重連後需 ≥60s 時間跨度的成交才恢復策略決策） */
  private statsWarm = false;
  /** 每秒價格取樣（[ts, price]，供 priceMove15sPct） */
  private readonly priceHist: Array<[number, number]> = [];

  private readonly listeners = new Set<EngineListener>();
  private readonly stmtInsertForce: ReturnType<Db["prepare"]>;
  private readonly stmtInsertStrategy: ReturnType<Db["prepare"]>;

  constructor(options: EngineOptions) {
    this.db = options.db;
    this.params = resolveParams(options.params);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((msg) => console.log(`[binance-api] ${msg}`));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wsFactory =
      options.wsFactory ??
      ((url) => new WebSocket(url) as unknown as WsLike);
    this.ring = new Rolling1mStats(200_000, this.now);

    this.strategy = new StrategyEngine({
      initialCapital: this.params.initialCapital,
      positionAllocation: this.params.positionAllocation,
      liquidationTakeProfit: this.params.liquidationTakeProfit,
      liquidationStopLoss: this.params.liquidationStopLoss,
      cvdStopLoss: this.params.cvdStopLoss,
      liquidationMaxHoldMs: this.params.liquidationMaxHoldMs,
      cvdThreshold: this.params.cvdThreshold,
      oiIncreaseThreshold: this.params.oiIncreaseThreshold,
      cvdConfirmationUpdates: this.params.cvdConfirmationUpdates,
      oppositeWallRatio: this.params.oppositeWallRatio,
      cvdSlowCount: this.params.cvdSlowCount,
      cvdMaxHoldMs: this.params.cvdMaxHoldMs,
      cooldownMs: this.params.cooldownMs,
    });

    // prepared statements：表格由 server/db.ts migrate 建立
    this.stmtInsertForce = this.db.prepare(
      `INSERT INTO binance_force_orders (timestamp, side, price, quantity, total_usdt)
       VALUES (@timestamp, @side, @price, @quantity, @total_usdt)`
    );
    this.stmtInsertStrategy = this.db.prepare(
      `INSERT INTO binance_strategy_orders
         (timestamp, strategy, action, side, price, quantity, pnl,
          capital_before, capital_after, trigger_conditions)
       VALUES (@timestamp, @strategy, @action, @side, @price, @quantity, @pnl,
          @capital_before, @capital_after, @trigger_conditions)`
    );
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.lastMessageAt = this.now();
    this.log(`monitor start (${this.params.symbol}, threshold ${this.params.liquidationAlertThresholdUsdt} USDT)`);

    this.connectWs();
    void this.pollOpenInterest();

    this.oiTimer = setInterval(() => {
      void this.pollOpenInterest();
    }, this.params.oiPollMs);
    this.oiTimer.unref();

    this.watchdogTimer = setInterval(() => {
      this.watchdog();
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();

    // B-1：策略 1s 節拍（每 tick 聚合一次快照餵策略——不是每筆成交）
    this.strategyTimer = setInterval(() => {
      this.onStrategyTick();
    }, STRATEGY_TICK_MS);
    this.strategyTimer.unref();

    this.flushNow();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.connected = false;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.log("monitor stopped");
    this.flushNow();
  }

  /** 釋放所有資源（測試 / 移除 router 時用） */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  // ── subscribers / snapshot ─────────────────────────────────────────

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** /state 用：完整記憶體摘要（newest-first） */
  feedSummary(): FeedSummary {
    return {
      trades: this.recentTrades.slice(),
      alerts: this.recentAlerts.slice(),
      signals: this.recentSignals.slice(),
    };
  }

  /** 目前即時狀態快照 */
  snapshotState(): MonitorSnapshot {
    const stats = this.ring.stats();
    const ref = this.lastPrice > 0 ? this.lastPrice : this.markPrice;
    const premium = this.lastPrice > 0 ? this.lastPrice - this.markPrice : 0;
    return {
      ts: this.now(),
      running: this.running,
      connected: this.connected,
      warmingUp: !this.statsWarm,
      symbol: this.params.symbol.toUpperCase(),
      startedAt: this.startedAt,
      lastPrice: this.lastPrice,
      markPrice: this.markPrice,
      fundingRate: this.fundingRate,
      premium,
      openInterest: this.openInterest,
      oiChange5s: this.oiChange5s,
      stats1m: stats,
      depthImbalance: this.depthImbalance,
      bidDepthVol: this.bidDepthVol,
      askDepthVol: this.askDepthVol,
      score: this.compositeScore(stats.cvd),
      priceMove15sPct: this.priceMove15sPct(),
      initialCapital: this.strategy.initialCapital,
      capital: this.strategy.capital,
      positions: this.strategy.positionList().map((p) =>
        this.toPositionView(p, ref > 0 ? ref : p.entryPrice)
      ),
    };
  }

  // ── WebSocket 連線 / 重連 ─────────────────────────────────────────

  private connectWs(): void {
    if (!this.running) return;
    try {
      const ws = this.wsFactory(this.params.wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.lastMessageAt = this.now();
        // B-2：重連後清窗重算統計（成交無歷史回放，缺漏期間不可靠），
        // 重新暖機（時間跨度 ≥60s）才恢復策略決策
        this.ring.clear();
        this.statsWarm = false;
        this.log(`ws connected (${this.params.symbol} combined stream) — re-warming 1m stats`);
        this.flushNow();
      };
      ws.onmessage = (ev) => this.onWsMessage(ev.data);
      ws.onerror = () => {
        // onclose 會接手重連流程
      };
      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        this.log("ws disconnected");
        this.flushNow();
        this.scheduleReconnect();
      };
    } catch (err) {
      this.log(`ws connect failed: ${String(err)}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  private watchdog(): void {
    if (!this.running || !this.connected) return;
    if (this.now() - this.lastMessageAt > WATCHDOG_IDLE_MS) {
      this.log("watchdog: no message, forcing reconnect");
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
    }
  }

  private onWsMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: { stream?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(raw) as { stream?: unknown; data?: unknown };
    } catch {
      return;
    }
    const streamName = typeof parsed.stream === "string" ? parsed.stream : "";
    const data =
      parsed.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)
        : {};
    this.lastMessageAt = this.now();

    if (streamName.includes("forceOrder")) this.handleForceOrder(data);
    else if (streamName.includes("trade")) this.handleTrade(data);
    else if (streamName.includes("depth5")) this.handleDepth(data);
    else if (streamName.includes("markPrice")) this.handleMarkPrice(data);
  }

  // ── 市場事件處理（鏡像 Python _handle_*）─────────────────────────

  private handleTrade(data: Record<string, unknown>): void {
    const p = asFinite(data.p);
    const q = asFinite(data.q);
    const t = asFinite(data.T);
    if (p === null || q === null || t === null || p <= 0 || q <= 0 || t <= 0) return;
    const m = data.m === true;

    this.lastPrice = p;
    // 1 = 主動買（m=false）；-1 = 主動賣（m=true）
    // B-2：窗口以牆鐘為基準；過期成交由 rolling 內部忽略
    this.ring.push(Math.trunc(t), q, m ? -1 : 1);
    this.updateWarm(); // 成交跨度 ≥60s 即暖機完成

    const trade: FeedTrade = { t: Math.trunc(t), p, q, m };
    this.pushRecent(this.recentTrades, trade, MAX_RECENT_TRADES);
    this.deltaTrades.unshift(trade);
    // B-1：策略改由 1s 節拍驅動（onStrategyTick），不再每筆成交都 process

    this.scheduleFlush();
  }

  private handleDepth(data: Record<string, unknown>): void {
    const bidRows = Array.isArray(data.b) ? data.b : [];
    const askRows = Array.isArray(data.a) ? data.a : [];
    let bidVol = 0;
    for (const row of bidRows) {
      if (Array.isArray(row)) bidVol += Number(row[1]) || 0;
    }
    let askVol = 0;
    for (const row of askRows) {
      if (Array.isArray(row)) askVol += Number(row[1]) || 0;
    }
    this.bidDepthVol = bidVol;
    this.askDepthVol = askVol;
    const total = bidVol + askVol;
    if (total > 0) this.depthImbalance = bidVol / total;
    this.scheduleFlush();
  }

  private handleMarkPrice(data: Record<string, unknown>): void {
    const p = asFinite(data.p);
    const r = asFinite(data.r);
    if (p !== null) this.markPrice = p;
    if (r !== null) this.fundingRate = r;
    this.scheduleFlush();
  }

  private handleForceOrder(data: Record<string, unknown>): void {
    const o = (data.o ?? {}) as Record<string, unknown>;
    const side = o.S;
    const price = asFinite(o.p);
    const quantity = asFinite(o.q);
    const t = asFinite(o.T);
    if (side !== "BUY" && side !== "SELL") return;
    if (price === null || quantity === null || t === null) return;
    if (price <= 0 || quantity <= 0 || t <= 0) return;

    const totalUsdt = price * quantity;
    if (totalUsdt < this.params.liquidationAlertThresholdUsdt) return;

    const alert: FeedAlert = { t: Math.trunc(t), side, price, qty: quantity, totalUsdt };
    this.pushRecent(this.recentAlerts, alert, MAX_RECENT_ALERTS);
    this.deltaAlerts.unshift(alert);
    this.writeForceOrder(alert);

    const title = side === "SELL" ? "💥 大額多頭爆倉" : "🚀 大額空頭軋空";
    this.log(`${title} $${price.toFixed(1)} x ${quantity.toFixed(3)} = $${totalUsdt.toFixed(2)} USDT`);

    this.processStrategySnapshot({
      timestamp: t,
      price,
      cvd_1m: this.ring.stats().cvd,
      liquidation_side: side,
      liquidation_usdt: totalUsdt,
    });

    this.scheduleFlush();
  }

  /** 每次市場更新後呼叫：交由紙上策略引擎產生 ENTRY / EXIT 事件 */
  /** 1s 節拍：聚合當刻快照餵策略（B-1：確認/放緩計數以「秒」為語意） */
  private onStrategyTick(): void {
    if (!this.running || !this.connected) return;
    this.updateWarm();
    const ref = this.lastPrice > 0 ? this.lastPrice : this.markPrice;
    if (!(ref > 0)) return;
    this.samplePrice(ref); // 每秒價格取樣（KILL SWITCH 波動 %）
    this.processStrategySnapshot({
      timestamp: this.now(),
      price: ref,
      cvd_1m: this.ring.stats().cvd,
    });
  }

  /** 每秒記錄價格樣本（保留 120s，供 15s 波動計算） */
  private samplePrice(price: number): void {
    const now = this.now();
    this.priceHist.push([now, price]);
    const cutoff = now - 120_000;
    while (this.priceHist.length > 0 && this.priceHist[0][0] < cutoff) {
      this.priceHist.shift();
    }
  }

  /** 15 秒價格波動 %（樣本不足 15s → null） */
  private priceMove15sPct(): number | null {
    if (this.priceHist.length === 0) return null;
    const cutoff = this.now() - 15_000;
    const latest = this.priceHist[this.priceHist.length - 1][1];
    // 找最早的 ts <= cutoff 樣本（由尾往前）
    let refPrice: number | null = null;
    for (let i = this.priceHist.length - 1; i >= 0; i--) {
      if (this.priceHist[i][0] <= cutoff) {
        refPrice = this.priceHist[i][1];
        break;
      }
    }
    if (refPrice === null || refPrice <= 0) return null;
    return (Math.abs(latest - refPrice) / refPrice) * 100;
  }

  /** 暖機判定：窗內成交時間跨度 ≥55s（60s 窗的最舊樣本會被推出，跨度永不達 60s） */
  private updateWarm(): void {
    if (!this.statsWarm && this.ring.timeSpanMs() >= WARMUP_SPAN_MS) {
      this.statsWarm = true;
      this.log("1m stats warmed — strategy decision enabled");
    }
  }

  private processStrategySnapshot(fields: {
    timestamp: number;
    price: number;
    cvd_1m: number;
    liquidation_side?: "BUY" | "SELL";
    liquidation_usdt?: number;
  }): void {
    // B-2：統計未暖機（斷線重連初期）不做任何策略決策
    if (!this.statsWarm) return;
    const snapshot: StrategySnapshot = {
      timestamp: fields.timestamp,
      price: fields.price,
      cvd_1m: fields.cvd_1m,
      oi_change: this.oiChange5s,
      depth_imbalance: this.depthImbalance,
      liquidation_side: fields.liquidation_side,
      liquidation_usdt: fields.liquidation_usdt,
    };
    let events: StrategyOrderEvent[];
    try {
      events = this.strategy.process(snapshot);
    } catch (err) {
      this.log(`strategy skipped: ${String(err)}`);
      return;
    }
    for (const event of events) this.handleStrategyEvent(event);
  }

  private handleStrategyEvent(event: StrategyOrderEvent): void {
    const signal: FeedSignal = {
      t: event.timestamp,
      strategy: event.strategy,
      action: event.action,
      side: event.side,
      price: event.price,
      qty: event.quantity,
      pnl: event.pnl,
      capitalAfter: event.capitalAfter,
      reason: eventReason(event),
    };
    this.pushRecent(this.recentSignals, signal, MAX_RECENT_SIGNALS);
    this.deltaSignals.unshift(signal);
    this.writeStrategyEvent(event);
    const sign = event.pnl >= 0 ? "+" : "";
    this.log(
      `[策略訊號] ${event.action} ${event.strategy} ${event.side} @ $${event.price.toFixed(1)} | ` +
        `數量: ${event.quantity.toFixed(6)} | 損益: ${sign}${event.pnl.toFixed(2)} USDT`
    );
  }

  // ── OI REST 輪詢（每 params.oiPollMs 秒）────────────────────────

  private async pollOpenInterest(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await this.fetchImpl(this.params.oiApiUrl, {
        signal: AbortSignal.timeout(OI_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { openInterest?: unknown };
      const newOi = asFinite(body.openInterest);
      if (newOi === null) throw new Error("invalid openInterest");
      const nowMs = this.now();
      this.oiHistory.push([nowMs, newOi]);
      const cutoffMs = nowMs - 5000;
      while (this.oiHistory.length > 0 && this.oiHistory[0][0] < cutoffMs) {
        this.oiHistory.shift();
      }
      this.oiChange5s = this.oiHistory.length > 1 ? newOi - this.oiHistory[0][1] : 0;
      this.openInterest = newOi;
      this.scheduleFlush();
    } catch (err) {
      this.log(`OI 更新失敗: ${String(err)}`);
    }
  }

  // ── flush / 廣播 ────────────────────────────────────────────────

  /** coalescing：短時間大量 tick 只送一包 */
  private scheduleFlush(): void {
    if (this.flushPending) return;
    this.flushPending = true;
    this.flushTimer = setTimeout(() => {
      this.flushPending = false;
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref();
  }

  /** 立即打包一次更新並廣播（同捆 delta + 最新 snapshot） */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushPending = false;

    const update: PanelUpdate = {
      state: this.snapshotState(),
      feed: {
        trades: this.deltaTrades.splice(0),
        alerts: this.deltaAlerts.splice(0),
        signals: this.deltaSignals.splice(0),
      },
    };
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        /* 單一 listener 出錯不拖垮其他 */
      }
    }
  }

  // ── DB 寫入（測試也可直接呼叫驗證落庫）──────────────────────────

  writeForceOrder(alert: FeedAlert): void {
    this.stmtInsertForce.run({
      timestamp: alert.t,
      side: alert.side,
      price: alert.price,
      quantity: alert.qty,
      total_usdt: alert.totalUsdt,
    });
  }

  writeStrategyEvent(event: StrategyOrderEvent): void {
    this.stmtInsertStrategy.run({
      timestamp: event.timestamp,
      strategy: event.strategy,
      action: event.action,
      side: event.side,
      price: event.price,
      quantity: event.quantity,
      pnl: event.pnl,
      capital_before: event.capitalBefore,
      capital_after: event.capitalAfter,
      trigger_conditions: eventTriggerJson(event),
    });
  }

  // ── 輔助 ──────────────────────────────────────────────────────────

  /** 鏡像 Python calculate_composite_score（0..100） */
  private compositeScore(cvd1m: number): number {
    let score = 50.0;
    // 因子 1：買賣掛單深度失衡（Weight: 30%）
    score += (this.depthImbalance - 0.5) * 60.0;

    // 因子 2：資金費率與期現溢價（Weight: 20%）
    const premium = this.lastPrice > 0 ? this.lastPrice - this.markPrice : 0;
    if (this.fundingRate > 0.0001 && premium > 5.0) {
      score += 10.0;
    } else if (this.fundingRate < -0.0001 && premium < -5.0) {
      score -= 10.0;
    }

    // 因子 3：OI 與 CVD 變化強度（Weight: 50%）
    if (this.oiChange5s < -10.0 && cvd1m < -20.0) {
      score += 20.0; // 多頭清算觸底
    } else if (this.oiChange5s < -10.0 && cvd1m > 20.0) {
      score -= 20.0; // 軋空頂部
    }

    return Math.max(0.0, Math.min(100.0, score));
  }

  private toPositionView(position: StrategyPosition, refPrice: number): PositionView {
    const rawReturn = (refPrice - position.entryPrice) / position.entryPrice;
    const signedReturn = position.side === "LONG" ? rawReturn : -rawReturn;
    const notional = position.entryPrice * position.quantity;
    return {
      strategy: position.strategy as StrategyId,
      side: position.side as PositionSide,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      qty: position.quantity,
      markPrice: refPrice,
      unrealizedPnl: notional * signedReturn,
      unrealizedPct: signedReturn * 100,
      holdMs: Math.max(0, this.now() - position.entryTime),
    };
  }

  private pushRecent<T>(arr: T[], item: T, max: number): void {
    arr.unshift(item);
    if (arr.length > max) arr.length = max;
  }

  private clearTimers(): void {
    if (this.oiTimer) {
      clearInterval(this.oiTimer);
      this.oiTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushPending = false;
  }
}
