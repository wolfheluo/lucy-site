// =====================================================================
//  BQ_DEMO 假行情資料源（僅測試 / e2e 版面驗證使用）
//  - 獨立檔：production（無 BQ_DEMO env）組裝分支不引用其行為；
//    僅 router 在 BQ_DEMO=1 時把 wsFactory/fetchImpl 注入引擎
//  - 假資料隔離：e2e 走獨立 VAULT_DATA_DIR（/tmp/lucy-e2e-data），
//    策略落庫只進測試 DB，不碰 production 資料
//  - UI 零 demo 標記——版面、狀態燈、數值與真實引擎一致
// =====================================================================
import type { WsLike } from "./engine.js";

/** 與引擎預設 params 同源（btcusdt） */
const SYMBOL = "btcusdt";
const BASE_PRICE = 60_000;
/** 大額強平門檻（引擎 liquidationAlertThresholdUsdt 預設 50k USDT） */
const MIN_LIQ_USDT = 50_000;

export interface DemoSources {
  wsFactory: (url: string) => WsLike;
  fetchImpl: typeof fetch;
}

function jitter(n: number, pct: number): number {
  return n * (1 + (Math.random() * 2 - 1) * pct);
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 回補 70s 歷史成交 → 引擎 1m 統計立即暖機（不必等真實 55s） */
function seedHistory(emit: (stream: string, data: Record<string, unknown>) => void): void {
  const now = Date.now();
  let t = now - 70_000;
  let p = BASE_PRICE;
  const step = 70_000 / 175; // 175 筆覆蓋 70s（~400ms/筆）
  while (t < now - 1500) {
    p = Math.max(20_000, p * (1 + (Math.random() * 2 - 1) * 0.0015));
    emit(`${SYMBOL}@trade`, {
      e: "trade",
      T: t,
      p: +p.toFixed(1),
      q: +rand(0.001, 0.08).toFixed(4),
      m: Math.random() < 0.5,
    });
    t += step;
  }
}

/** 週期性單向大單脈衝（cvd 衝過 threshold → 觸發策略 entry，版面出現持倉） */
function maybePulse(emit: (stream: string, data: Record<string, unknown>) => void, at: number): void {
  const buySide = Math.random() < 0.6;
  const n = 18 + Math.floor(Math.random() * 10); // 18–27 筆
  let p = BASE_PRICE * (1 + (Math.random() * 2 - 1) * 0.02);
  for (let i = 0; i < n; i += 1) {
    p = Math.max(20_000, p * (1 + (Math.random() * 2 - 1) * 0.002));
    emit(`${SYMBOL}@trade`, {
      e: "trade",
      T: at + i * 120,
      p: +p.toFixed(1),
      q: +rand(0.5, 1.6).toFixed(3),
      m: !buySide, // 買脈衝 → m=false（主動買）
    });
  }
}

export function createDemoSources(): DemoSources {
  return {
    /** fake WebSocket：回補歷史 + 持續吐出 trade/markPrice/depth5/forceOrder */
    wsFactory(): WsLike {
      const emit = (stream: string, data: Record<string, unknown>) => {
        ws.onmessage?.({ data: JSON.stringify({ stream, data }) });
      };
      const ws: WsLike = {
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close() {
          if (tradeTimer) clearInterval(tradeTimer);
          if (markTimer) clearInterval(markTimer);
          if (depthTimer) clearInterval(depthTimer);
          if (pulseTimer) clearInterval(pulseTimer);
          if (liqTimer) clearInterval(liqTimer);
          ws.onclose?.();
        },
      };

      let tradeTimer: ReturnType<typeof setInterval> | null = null;
      let markTimer: ReturnType<typeof setInterval> | null = null;
      let depthTimer: ReturnType<typeof setInterval> | null = null;
      let pulseTimer: ReturnType<typeof setInterval> | null = null;
      let liqTimer: ReturnType<typeof setInterval> | null = null;

      // engine connectWs 同步設定 onopen/onmessage 後才 fire
      queueMicrotask(() => {
        ws.onopen?.();
        seedHistory(emit);
        emit(`${SYMBOL}@markPrice`, { e: "markPriceUpdate", p: BASE_PRICE, r: 0.0001 });
        emit(`${SYMBOL}@depth5`, {
          b: [[60_000, 12.5], [59_990, 8.2], [59_980, 6.1], [59_970, 4.4], [59_960, 3.3]],
          a: [[60_010, 11.4], [60_020, 7.9], [60_030, 5.6], [60_040, 4.1], [60_050, 3.0]],
        });

        tradeTimer = setInterval(() => {
          emit(`${SYMBOL}@trade`, {
            e: "trade",
            T: Date.now(),
            p: +jitter(BASE_PRICE, 0.002).toFixed(1),
            q: +rand(0.001, 0.08).toFixed(4),
            m: Math.random() < 0.52, // 略偏買 → cvd 微正漂移
          });
        }, 300);
        markTimer = setInterval(() => {
          emit(`${SYMBOL}@markPrice`, {
            e: "markPriceUpdate",
            p: +jitter(BASE_PRICE, 0.002).toFixed(1),
            r: +jitter(0.0001, 0.5).toFixed(6),
          });
        }, 1000);
        depthTimer = setInterval(() => {
          const mid = jitter(BASE_PRICE, 0.001);
          const tick = 10;
          const rows = (side: number) =>
            Array.from({ length: 5 }, (_, i) => [mid + side * (i + 1) * tick, +rand(3, 15).toFixed(2)]);
          emit(`${SYMBOL}@depth5`, { b: rows(-1), a: rows(1) });
        }, 2000);
        pulseTimer = setInterval(() => maybePulse(emit, Date.now()), 12_000);
        liqTimer = setInterval(() => {
          // 大額強平（total > 50k USDT 才會被引擎收錄 → ledger alert）
          emit(`${SYMBOL}@forceOrder`, {
            o: {
              S: Math.random() < 0.5 ? "SELL" : "BUY",
              p: +jitter(BASE_PRICE, 0.003).toFixed(1),
              q: +rand(MIN_LIQ_USDT / 55_000, MIN_LIQ_USDT / 40_000).toFixed(3),
              T: Date.now(),
            },
          });
        }, 18_000);
        liqTimer.unref?.();
      });

      return ws;
    },

    /** fake OI REST：固定基值 + 微抖動（oiChange5s 有數值） */
    fetchImpl: async () =>
      new Response(JSON.stringify({ openInterest: +jitter(185_000, 0.001).toFixed(1) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };
}
