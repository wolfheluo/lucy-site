// =====================================================================
//  BINANCE QUANT // 幣安即時量化監控 —— tool 純資料（無 side effect，雙端共用）
// =====================================================================
import type { ToolMeta, ToolProjectCard } from "../types.js";

export const binanceApiMeta: ToolMeta = {
  id: "binance-api",
  title: "BINANCE QUANT",
  zhTitle: "幣安即時量化監控",
};

export const binanceApiProjectCard: ToolProjectCard = {
  title: "BINANCE QUANT",
  zh: "幣安即時量化監控",
  desc: "BTCUSDT 永續合約即時監控儀表板：成交、1 分鐘 CVD、未平倉量、深度失衡與大額爆倉告警，內建兩種紙上交易策略引擎並將事件寫入 SQLite。",
  tags: ["WebSocket", "Hono", "SQLite", "React"],
};
