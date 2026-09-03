// BINANCE QUANT 資本持久化 + graceful shutdown 結算測試
//  場景：未平倉部位結算 → capital 寫入 binance_engine_state → 同 DB 重開讀回續存
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../server/db";
import { BinanceMonitor } from "../tools/binance-api/server/engine";

/** 假 WS：測試手動觸發 onopen/onmessage */
class FakeWs {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void {
    this.onclose && this.onclose();
  }
}

function msg(stream: string, data: unknown): string {
  return JSON.stringify({ stream, data });
}

/** 主動買成交（m=false → d=1） */
function buyTrade(T: number, p = "77000", q = "0.5"): string {
  return msg("btcusdt@trade", { p, q, T, m: false });
}

/** 大額多頭爆倉（SELL forceOrder，q=1 BTC → 77k USDT > 50k threshold） */
function bigLiquidation(T: number): string {
  return msg("btcusdt@forceOrder", { o: { S: "SELL", p: "77000", q: "1", T } });
}

describe("BinanceMonitor 資本持久化", () => {
  let dir: string;
  let db: Db;
  let ws: FakeWs;
  let mon: BinanceMonitor;
  let nowMs: number;
  /** 真實流逝補償：fake clock 隨真實時間前進（interval 驅動測試需要） */
  let drift: () => number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bq-capital-test-"));
    db = openDb(dir);
    ws = new FakeWs();
    nowMs = 1_700_000_000_000;
    const realStart = Date.now();
    drift = () => Date.now() - realStart;
    mon = new BinanceMonitor({
      db,
      now: () => nowMs + drift(),
      params: { symbol: "btcusdt" },
      wsFactory: () => ws,
      fetchImpl: (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch,
      log: () => undefined,
    });
  });

  afterEach(() => {
    mon.dispose();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 暖機（跨度 56s ≥ 55s）+ 大額強平觸發 liquidation_reversal 開倉（全走 WS public path） */
  function warmAndOpenPosition(): void {
    ws.onopen && ws.onopen();
    ws.onmessage && ws.onmessage({ data: buyTrade(nowMs - 56_000, "77000", "1") });
    ws.onmessage && ws.onmessage({ data: buyTrade(nowMs, "77000") });
    ws.onmessage && ws.onmessage({ data: bigLiquidation(nowMs) });
  }

  function stateRow(): { capital: number } | undefined {
    return db
      .prepare("SELECT capital FROM binance_engine_state WHERE id = 1")
      .get() as { capital: number } | undefined;
  }

  it("首次啟動（DB 無 state）→ capital = params.initialCapital（10000）", () => {
    expect(mon.snapshotState().capital).toBe(10_000);
    expect(stateRow()).toBeUndefined();
  });

  it("settlePositions 結算未平倉部位 → EXIT 事件 + capital 寫入 state；同 DB 重開讀回續存", () => {
    mon.start();
    warmAndOpenPosition();
    expect(mon.snapshotState().positions).toHaveLength(1);

    // 價格微漲後結算 → 獲利入資本
    nowMs += 5_000;
    ws.onmessage && ws.onmessage({ data: buyTrade(nowMs, "77200", "0.01") });
    const events = mon.settlePositions();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("EXIT");
    expect(String(events[0].conditions.exit_reason)).toContain("settlement");

    const st = mon.snapshotState();
    expect(st.positions).toHaveLength(0);
    expect(st.capital).toBeGreaterThan(10_000); // 77000 → 77200 結算獲利

    // EXIT 已落 orders 表（1 ENTRY + 1 settlement EXIT），state 表已寫入
    const orderRows = db
      .prepare("SELECT action FROM binance_strategy_orders")
      .all() as { action: string }[];
    expect(orderRows.map((r) => r.action).sort()).toEqual(["ENTRY", "EXIT"]);
    const row = stateRow();
    expect(row).toBeDefined();
    expect(row!.capital).toBeCloseTo(st.capital, 6);

    // 同 DB 重開新 monitor（模擬 pm2 restart）→ 資本讀回續存
    const mon2 = new BinanceMonitor({
      db,
      now: () => nowMs + drift(),
      params: { symbol: "btcusdt" },
      wsFactory: () => new FakeWs(),
      fetchImpl: (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch,
      log: () => undefined,
    });
    expect(mon2.snapshotState().capital).toBeCloseTo(st.capital, 6);
    mon2.dispose();
  });

  it("stop() 自動結算未平倉部位並持久化（平倉收工語意）", () => {
    mon.start();
    warmAndOpenPosition();
    expect(mon.snapshotState().positions).toHaveLength(1);

    mon.stop();
    const st = mon.snapshotState();
    expect(st.running).toBe(false);
    expect(st.positions).toHaveLength(0);

    const row = stateRow();
    expect(row).toBeDefined();
    expect(row!.capital).toBeCloseTo(st.capital, 6);
    const exitCount = db
      .prepare("SELECT COUNT(*) AS n FROM binance_strategy_orders WHERE action = 'EXIT'")
      .get() as { n: number };
    expect(exitCount.n).toBe(1); // settlement EXIT 有落庫
  });
});
