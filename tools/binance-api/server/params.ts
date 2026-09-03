// =====================================================================
//  BINANCE QUANT 參數預設值（runtime；由 engine/router 使用）
// =====================================================================
import type { BinanceParams } from "../types.js";

/** 參數預設值：與原 Python 版 research 預設一致 */
export const DEFAULT_PARAMS: BinanceParams = {
  symbol: "btcusdt",
  wsUrl: "",
  oiApiUrl: "",
  liquidationAlertThresholdUsdt: 50000.0,
  initialCapital: 10000.0,
  positionAllocation: 0.2,
  liquidationTakeProfit: 0.003,
  liquidationStopLoss: -0.005,
  liquidationMaxHoldMs: 5 * 60 * 1000,
  cvdThreshold: 20.0,
  oiIncreaseThreshold: 10.0,
  cvdConfirmationUpdates: 3,
  oppositeWallRatio: 0.65,
  cvdSlowCount: 3,
  cvdMaxHoldMs: 15 * 60 * 1000,
  cvdStopLoss: -0.005,
  cooldownMs: 60 * 1000,
  oiPollMs: 3000,
};

/** 依 symbol 產生 Combined Streams WS URL 與 OI REST URL */
export function binanceUrls(symbol: string): { wsUrl: string; oiApiUrl: string } {
  const s = symbol.toLowerCase();
  const upper = s.toUpperCase();
  return {
    wsUrl: `wss://fstream.binance.com/stream?streams=${s}@trade/${s}@forceOrder/${s}@depth5@100ms/${s}@markPrice@1s`,
    oiApiUrl: `https://fapi.binance.com/fapi/v1/openInterest?symbol=${upper}`,
  };
}

/** 合併使用者覆寫與預設（覆寫 symbol 時 URL 一併重算） */
export function resolveParams(overrides: Partial<BinanceParams> = {}): BinanceParams {
  const symbol = overrides.symbol?.toLowerCase() ?? DEFAULT_PARAMS.symbol;
  const urls = binanceUrls(symbol);
  return {
    ...DEFAULT_PARAMS,
    ...overrides,
    symbol,
    wsUrl: overrides.wsUrl ?? urls.wsUrl,
    oiApiUrl: overrides.oiApiUrl ?? urls.oiApiUrl,
  };
}
