// =====================================================================
//  BINANCE QUANT client API（同源 cookie 自動帶）
// =====================================================================
import type {
  LiquidationListResponse,
  OkResponse,
  OrderListResponse,
  StateResponse,
} from "../types";

export type {
  FeedAlert,
  FeedSignal,
  FeedTrade,
  ForceOrderRow,
  LiquidationListResponse,
  MonitorSnapshot,
  OrderListResponse,
  PanelUpdate,
  StateResponse,
  StrategyOrderRow,
} from "../types";

export type ApiError = Error & { status?: number };

const BASE = "/api/tools/binance-api";

async function j<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

export const binanceApi = {
  /** 初始 /state：即時狀態 + 記憶體摘要 */
  async state(): Promise<StateResponse> {
    const res = await fetch(`${BASE}/state`);
    return j<StateResponse>(res);
  },

  /** SSE stream URL（EventSource 直接訂閱） */
  streamUrl(): string {
    return `${BASE}/stream`;
  },

  /** 紙上策略訂單歷史（DB） */
  async orders(limit = 30): Promise<OrderListResponse> {
    const res = await fetch(`${BASE}/orders?limit=${limit}`);
    return j<OrderListResponse>(res);
  },

  /** 大額強平歷史（DB） */
  async liquidations(limit = 30): Promise<LiquidationListResponse> {
    const res = await fetch(`${BASE}/liquidations?limit=${limit}`);
    return j<LiquidationListResponse>(res);
  },

  /** 管理端：啟動 / 停止監控引擎（需要登入） */
  async setRunning(running: boolean): Promise<void> {
    const res = await fetch(`${BASE}/${running ? "start" : "stop"}`, { method: "POST" });
    await j<OkResponse>(res);
  },
};
