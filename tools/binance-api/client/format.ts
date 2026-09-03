// =====================================================================
//  BINANCE QUANT 顯示格式化輔助
// =====================================================================

/** 價格：$67,890.1（一位小數） */
export function fmtPrice(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

/** 數量：最多 3 位小數，去掉尾零 */
export function fmtQty(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** USDT 金額（千分位 + 2 位小數） */
export function fmtUsdt(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 大數（OI / 總額），整數 + 千分位 */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 帶符號數值：+12.3 / -4.0 */
export function fmtSigned(n: number, digits = 2): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** 百分比：34.2% */
export function fmtPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

/** 資金費率：0.0100% */
export function fmtRate(n: number): string {
  return `${(n * 100).toFixed(4)}%`;
}

/** epoch ms → HH:MM:SS（本機時區） */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

/** 持有時間（ms → mm:ss） */
export function fmtHold(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** 數字長度過長時以 K/M 縮寫 */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
