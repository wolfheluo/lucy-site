// =====================================================================
//  BINANCE QUANT 共享型別（type-only，client / server 皆可 import）
// =====================================================================

/** 強平事件方向（Binance forceOrder o.S） */
export type LiquidationSide = "BUY" | "SELL";
/** 紙上部位方向 */
export type PositionSide = "LONG" | "SHORT";
/** 兩套研究用策略 id */
export type StrategyId = "liquidation_reversal" | "cvd_breakout";
/** 紙上訂單動作 */
export type OrderAction = "ENTRY" | "EXIT";

/** 監控 + 策略引擎參數（預設值見 server/params.ts） */
export interface BinanceParams {
  /** 小寫交易對，例如 "btcusdt" */
  symbol: string;
  /** Binance USDⓈ-M Combined Streams WebSocket URL */
  wsUrl: string;
  /** REST 未平倉量輪詢 URL */
  oiApiUrl: string;
  /** 大額強平告警門檻（USDT） */
  liquidationAlertThresholdUsdt: number;
  /** 紙上交易初始資金（USDT） */
  initialCapital: number;
  /** 單筆部位資金配置比例 */
  positionAllocation: number;
  /** 爆倉反轉停利（signed return，0.003 = +0.3%） */
  liquidationTakeProfit: number;
  /** 爆倉反轉停損（0.005 = -0.5%） */
  liquidationStopLoss: number;
  /** 爆倉反轉最長持有 ms */
  liquidationMaxHoldMs: number;
  /** CVD 順勢 |CVD| 門檻 */
  cvdThreshold: number;
  /** OI 增加門檻（合約張數差） */
  oiIncreaseThreshold: number;
  /** CVD 同方向連續確認次數 */
  cvdConfirmationUpdates: number;
  /** 反向掛單牆比例（0.65 = 65%） */
  oppositeWallRatio: number;
  /** CVD 放緩連續次數 */
  cvdSlowCount: number;
  /** CVD 順勢最長持有 ms */
  cvdMaxHoldMs: number;
  /** CVD 順勢停損（signed return，-0.005 = -0.5%；B-4） */
  cvdStopLoss: number;
  /** 出場後冷卻 ms */
  cooldownMs: number;
  /** OI REST 輪詢間隔 ms */
  oiPollMs: number;
}

/** 最近 1 分鐘成交統計 */
export interface Trade1mStats {
  buyVol: number;
  sellVol: number;
  totalVol: number;
  /** buy_vol - sell_vol */
  cvd: number;
  /** 0..100；無樣本時 50 */
  buyRatio: number;
}

/** 單筆成交（m = true 表示被動方是買方 → 主動賣單） */
export interface FeedTrade {
  t: number;
  p: number;
  q: number;
  m: boolean;
}

/** 大額強平告警（已達門檻並落庫） */
export interface FeedAlert {
  t: number;
  side: LiquidationSide;
  price: number;
  qty: number;
  totalUsdt: number;
}

/** 策略紙上進出場訊號 */
export interface FeedSignal {
  t: number;
  strategy: StrategyId;
  action: OrderAction;
  side: PositionSide;
  price: number;
  qty: number;
  pnl: number;
  capitalAfter: number;
  /** 進場理由 / 出場原因（給人類看的單行字串） */
  reason: string;
}

/** 目前持有中的紙上部位（每 flush 即時估值） */
export interface PositionView {
  strategy: StrategyId;
  side: PositionSide;
  entryTime: number;
  entryPrice: number;
  qty: number;
  /** 估值用最新價 */
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  holdMs: number;
}

/** 監控器即時狀態（/state 與 SSE flush 共用） */
export interface MonitorSnapshot {
  ts: number;
  running: boolean;
  connected: boolean;
  /** 1 分鐘統計是否仍在暖機（斷線重連初期 true——資料不足策略不決策） */
  warmingUp: boolean;
  symbol: string;
  startedAt: number;
  lastPrice: number;
  markPrice: number;
  fundingRate: number;
  /** lastPrice - markPrice */
  premium: number;
  openInterest: number;
  /** 近 5 秒 OI 變化 */
  oiChange5s: number;
  stats1m: Trade1mStats;
  depthImbalance: number;
  bidDepthVol: number;
  askDepthVol: number;
  /** 0..100 短線評分 */
  score: number;
  /** 紙上資金 */
  capital: number;
  positions: PositionView[];
}

/** 一次性資料摘要（/state 給記憶體最近資料；SSE 給兩次 flush 間的新資料） */
export interface FeedSummary {
  trades: FeedTrade[];
  alerts: FeedAlert[];
  signals: FeedSignal[];
}

/** SSE snapshot 事件 payload */
export interface PanelUpdate {
  state: MonitorSnapshot;
  feed: FeedSummary;
}

/** force_orders 資料表一列 */
export interface ForceOrderRow {
  id: number;
  timestamp: number;
  side: LiquidationSide;
  price: number;
  quantity: number;
  totalUsdt: number;
}

/** strategy_orders 資料表一列（triggerConditions 為 JSON 字串） */
export interface StrategyOrderRow {
  id: number;
  timestamp: number;
  strategy: StrategyId;
  action: OrderAction;
  side: PositionSide;
  price: number;
  quantity: number;
  pnl: number;
  capitalBefore: number;
  capitalAfter: number;
  triggerConditions: string;
}

export interface StateResponse {
  ok: true;
  state: MonitorSnapshot;
  feed: FeedSummary;
}

export interface OrderListResponse {
  ok: true;
  orders: StrategyOrderRow[];
}

export interface LiquidationListResponse {
  ok: true;
  liquidations: ForceOrderRow[];
}

export interface OkResponse {
  ok: true;
}
