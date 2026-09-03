import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../server/db";
import { BinanceMonitor } from "../tools/binance-api/server/engine";

/** 假 WS：測試可手動觸發 onopen/onmessage */
class FakeWs {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void {
    this.onclose && this.onclose();
  }
}

function tradeMsg(p: string, T: number, m: boolean): string {
  return JSON.stringify({
    stream: "btcusdt@trade",
    data: { p, q: "0.01", T, m },
  });
}

describe("BinanceMonitor 引擎節拍（回歸：flushNow 不得清除策略節拍 timer）", () => {
  let dir: string;
  let db: Db;
  let ws: FakeWs;
  let mon: BinanceMonitor;
  let nowMs: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bq-engine-test-"));
    db = openDb(dir);
    ws = new FakeWs();
    nowMs = 1_700_000_000_000;
    const realStart = Date.now();
    // fake 時鐘隨真實流逝前進（tick 每秒執行時 now 也 +1s → 樣本時間分散）
    const now = (): number => nowMs + (Date.now() - realStart);
    mon = new BinanceMonitor({
      db,
      now,
      params: { symbol: "btcusdt" },
      wsFactory: () => ws,
      log: () => undefined,
    });
    mon.start();
    ws.onopen && ws.onopen();
  });

  afterEach(() => {
    mon.dispose();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    "策略節拍持續存活：多次 flushNow 後 priceMove15sPct 仍累積（B-1 回歸）",
    async () => {
      // 餵首筆成交設定 lastPrice——handleTrade 每次會觸發 flushNow（bug 源頭）
      nowMs += 1_000;
      ws.onmessage && ws.onmessage({ data: tradeMsg("77000", nowMs, false) });

      const spy = vi.spyOn(
        BinanceMonitor.prototype as unknown as { onStrategyTick: () => void },
        "onStrategyTick",
      );
      // 真實等待 >15s：策略節拍每秒 sample，樣本跨 15s 窗後 priceMove15sPct 必須有值
      // （若 flushNow 誤殺節拍 timer → 樣本永不累積 → 永遠 null → 失敗）
      // 21s：容忍並行測試負載下 interval 的輕微延遲（<15 tick 會假陰性）
      await new Promise((r) => setTimeout(r, 21_000));

      const st = mon.snapshotState();
      console.log("[engine-test] tick 呼叫次數:", spy.mock.calls.length, "| move:", st.priceMove15sPct);
      expect(spy.mock.calls.length).toBeGreaterThan(10);
      expect(typeof st.priceMove15sPct).toBe("number");
      expect(st.priceMove15sPct).not.toBeNull();
    },
    30_000,
  );

  it("stop 後節拍停止、start 後恢復", async () => {
    mon.stop();
    expect(mon.snapshotState().running).toBe(false);
    mon.start();
    ws.onopen && ws.onopen();
    await new Promise((r) => setTimeout(r, 1_300));
    expect(mon.snapshotState().running).toBe(true);
  });
});
