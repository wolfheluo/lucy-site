// BINANCE QUANT 策略引擎單元測試（純邏輯、無 IO、無 WS）
// 覆蓋修補：B-1 確認次數語意、B-3 capital 防護、B-4 cvd 停損
import { describe, it, expect } from "vitest";
import { StrategyEngine, type StrategyEngineOptions, type StrategySnapshot } from "../tools/binance-api/server/strategy";

const OPTS: StrategyEngineOptions = {
  initialCapital: 10_000,
  positionAllocation: 0.2,
  liquidationTakeProfit: 0.003,
  liquidationStopLoss: -0.005,
  liquidationMaxHoldMs: 5 * 60 * 1000,
  cvdThreshold: 20,
  oiIncreaseThreshold: 10,
  cvdConfirmationUpdates: 3,
  oppositeWallRatio: 0.65,
  cvdSlowCount: 3,
  cvdMaxHoldMs: 15 * 60 * 1000,
  cvdStopLoss: -0.005,
  cooldownMs: 60 * 1000,
};

/** cvd_breakout 順勢進場條件的快照（cvd 同向 25、OI 增、深度中立） */
function bullishSnapshot(t: number, price = 100): StrategySnapshot {
  return { timestamp: t, price, cvd_1m: 25, oi_change: 15, depth_imbalance: 0.5 };
}

function makeEngine(opts: Partial<StrategyEngineOptions> = {}) {
  return new StrategyEngine({ ...OPTS, ...opts });
}

describe("cvd_breakout 進場：同向確認次數語意（B-1）", () => {
  it("前 2 次同向確認不進場，第 3 次才開倉（cvdConfirmationUpdates=3）", () => {
    const eng = makeEngine();
    let t = 1_000_000;
    // 第 1、2 次：streak 1→2，尚未達標
    for (let i = 0; i < 2; i++) {
      const events = eng.process(bullishSnapshot(t));
      expect(events).toHaveLength(0);
      expect(eng.positionList().length).toBe(0);
      t += 1000; // 節拍語意：1s 一次更新
    }
    // 第 3 次：streak=3 達標 → 開 LONG
    const events = eng.process(bullishSnapshot(t));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("ENTRY");
    expect(events[0].side).toBe("LONG");
  });

  it("方向反轉會重置 streak（須重新累積 3 次）", () => {
    const eng = makeEngine();
    let t = 1_000_000;
    eng.process(bullishSnapshot(t)); // LONG streak=1
    t += 1000;
    eng.process({ ...bullishSnapshot(t), cvd_1m: -25 }); // 反轉 → reset streak=1 (SHORT)
    t += 1000;
    eng.process({ ...bullishSnapshot(t), cvd_1m: -25 }); // SHORT streak=2 → 未達 3
    expect(eng.positionList().length).toBe(0);
    t += 1000;
    const events = eng.process({ ...bullishSnapshot(t), cvd_1m: -25 }); // SHORT streak=3
    expect(events.some((e) => e.action === "ENTRY" && e.side === "SHORT")).toBe(true);
  });
});

describe("B-3 capital 防護：資本耗盡不再開倉", () => {
  it("capital ≤0 後進場條件齊全仍不開倉", () => {
    const eng = makeEngine({ initialCapital: 10_000, positionAllocation: 10 }); // 超額配置僅測試用
    let t = 1_000_000;
    // 三次確認 → 開倉（notional = 100 * qty(10000*10/100=1000) = 100_000）
    let ev: { action: string }[] = [];
    for (let i = 0; i < 3; i++) {
      ev = eng.process(bullishSnapshot(t));
      t += 1000;
    }
    expect(eng.positionList().length).toBe(1);
    // 價格崩到接近 0 → 停損平倉 → 資本遠低於 0
    const exit = eng.process({ ...bullishSnapshot(t), price: 0.001 });
    expect(exit.some((e) => e.action === "EXIT")).toBe(true);
    expect(eng.capital).toBeLessThan(0);
    // 重新累積 3 次確認 → 條件齊 → 但資本 ≤0 → 不開倉
    for (let i = 0; i < 3; i++) {
      eng.process(bullishSnapshot(t, 100));
      t += 1000;
    }
    expect(eng.positionList().length).toBe(0);
    expect(eng.capital).toBeLessThanOrEqual(0);
  });
});

describe("B-4 cvd_breakout 停損", () => {
  it("價格反向超過 cvdStopLoss → EXIT（risk stop）優先於放緩判斷", () => {
    const eng = makeEngine();
    let t = 1_000_000;
    for (let i = 0; i < 3; i++) {
      eng.process(bullishSnapshot(t));
      t += 1000;
    }
    expect(eng.positionList().length).toBe(1);
    // 進場後 price 100 → 跌 0.6%（> -0.5% 停損）；cvd 維持 25 不觸發 slowCount
    const exit = eng.process({ ...bullishSnapshot(t), price: 99.4 });
    expect(exit.some((e) => e.action === "EXIT")).toBe(true);
    const ex = exit.find((e) => e.action === "EXIT")!;
    expect(String(ex.conditions.exit_reason)).toContain("risk stop");
    expect(eng.capital).toBeLessThan(10_000);
  });
});
