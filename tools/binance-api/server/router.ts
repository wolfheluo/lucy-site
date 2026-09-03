// =====================================================================
//  BINANCE QUANT 後端路由（掛在 /api/tools/binance-api）
//    GET  /state          即時狀態 + 記憶體摘要（公開）
//    GET  /stream         SSE：state + 兩次 flush 間的 delta（公開）
//    GET  /orders         紙上策略訂單歷史（DB，公開）
//    GET  /liquidations   大額強平歷史（DB，公開）
//    POST /start|/stop    監控引擎開關（管理端，requireAuth）
// =====================================================================
import { Hono } from "hono";
import type { ServerToolContext } from "../../types.js";
import { requireAuth } from "../../../server/auth.js";
import { BinanceMonitor } from "./engine.js";
import type {
  ForceOrderRow,
  LiquidationListResponse,
  OkResponse,
  OrderListResponse,
  StateResponse,
  StrategyOrderRow,
} from "../types.js";

const STREAM_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // 反代（nginx）不要緩衝 SSE
  "x-accel-buffering": "no",
};

/** 查詢參數 limit：預設 30、上限 200 */
function parseLimit(raw: string | undefined, fallback = 30): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, 200);
}

interface ForceRowRaw {
  id: number;
  timestamp: number;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  total_usdt: number;
}

interface StrategyRowRaw {
  id: number;
  timestamp: number;
  strategy: string;
  action: "ENTRY" | "EXIT";
  side: "LONG" | "SHORT";
  price: number;
  quantity: number;
  pnl: number;
  capital_before: number;
  capital_after: number;
  trigger_conditions: string;
}

export function registerBinanceApi(app: Hono, ctx: ServerToolContext): void {
  // 每個 Hono app 一個引擎；測試環境（vitest NODE_ENV=test）不自動連網
  const monitor = new BinanceMonitor({ db: ctx.db });
  if (process.env.NODE_ENV !== "test") monitor.start();

  const api = new Hono();

  api.get("/state", (c) => {
    const body: StateResponse = {
      ok: true,
      state: monitor.snapshotState(),
      feed: monitor.feedSummary(),
    };
    return c.json(body);
  });

  api.get("/orders", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const rows = ctx.db
      .prepare(
        `SELECT id, timestamp, strategy, action, side, price, quantity, pnl,
                capital_before, capital_after, trigger_conditions
           FROM binance_strategy_orders
          ORDER BY timestamp DESC, id DESC
          LIMIT ?`
      )
      .all(limit) as unknown as StrategyRowRaw[];
    const orders: StrategyOrderRow[] = rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      strategy: r.strategy as StrategyOrderRow["strategy"],
      action: r.action,
      side: r.side,
      price: r.price,
      quantity: r.quantity,
      pnl: r.pnl,
      capitalBefore: r.capital_before,
      capitalAfter: r.capital_after,
      triggerConditions: r.trigger_conditions,
    }));
    const body: OrderListResponse = { ok: true, orders };
    return c.json(body);
  });

  api.get("/liquidations", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const rows = ctx.db
      .prepare(
        `SELECT id, timestamp, side, price, quantity, total_usdt
           FROM binance_force_orders
          ORDER BY timestamp DESC, id DESC
          LIMIT ?`
      )
      .all(limit) as unknown as ForceRowRaw[];
    const liquidations: ForceOrderRow[] = rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      side: r.side,
      price: r.price,
      quantity: r.quantity,
      totalUsdt: r.total_usdt,
    }));
    const body: LiquidationListResponse = { ok: true, liquidations };
    return c.json(body);
  });

  // ── 管理端：引擎開關 ─────────────────────────────────────────────
  api.post("/start", requireAuth(ctx.sessionSecret), (c) => {
    monitor.start();
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  api.post("/stop", requireAuth(ctx.sessionSecret), (c) => {
    monitor.stop();
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  // ── SSE：coalescing flush 後即時推送 ─────────────────────────────
  api.get("/stream", (_c) => {
    const encoder = new TextEncoder();
    let unsub: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        unsub = monitor.subscribe((update) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));
          } catch {
            /* 連線已斷 */
          }
        });
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            /* ignore */
          }
        }, 15_000);
        heartbeat.unref();
      },
      cancel() {
        if (unsub) unsub();
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return new Response(stream, { headers: STREAM_HEADERS });
  });

  app.route("/api/tools/binance-api", api);
}
