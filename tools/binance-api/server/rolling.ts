// =====================================================================
//  BINANCE QUANT 最近 1 分鐘成交統計（incremental ring，無 JIT 需求）
//  - 原 Python 版在每個 trade 事件以 Numba O(size) 掃 5 萬筆 ring buffer；
//    此處改為「進一筆補一筆、過期一筆扣一筆」的攤銷 O(1) 滑窗，
//    語意一致：只統計 [now - 60s, now] 且 timestamp >= cutoff 的成交。
// =====================================================================
import type { Trade1mStats } from "../types.js";

export const ONE_MINUTE_MS = 60_000;

interface RollingEntry {
  t: number;
  q: number;
  /** 1 = 主動買（aggressive buy），-1 = 主動賣 */
  d: 1 | -1;
}

export class Rolling1mStats {
  private entries: RollingEntry[] = [];
  /** 邏輯頭部指標：避免每次剔除都用 shift() 造成 O(n) */
  private lo = 0;
  private buyVol = 0;
  private sellVol = 0;

  constructor(private readonly capacity = 200_000) {}

  get size(): number {
    return this.entries.length - this.lo;
  }

  /** 移除時間 < cutoff 的過期成交並扣回累計量 */
  expireBefore(cutoffMs: number): void {
    const arr = this.entries;
    while (this.lo < arr.length && arr[this.lo].t < cutoffMs) {
      const e = arr[this.lo];
      if (e.d === 1) this.buyVol -= e.q;
      else this.sellVol -= e.q;
      this.lo += 1;
    }
    this.compactIfNeeded();
  }

  /**
   * 推入一筆成交。
   * @param t         Binance 成交時間（epoch ms）
   * @param qty       數量
   * @param side      1 = 主動買 / -1 = 主動賣
   * @param nowMs     統計窗口基準時間（通常即成交事件時間）
   */
  push(t: number, qty: number, side: 1 | -1, nowMs: number): void {
    this.expireBefore(nowMs - ONE_MINUTE_MS);
    this.entries.push({ t, q: qty, d: side });
    if (side === 1) this.buyVol += qty;
    else this.sellVol += qty;
    // 記憶體保險：極端突發下仍保有上限（直接丟棄最舊，不參與統計）
    while (this.size > this.capacity) {
      const oldest = this.entries[this.lo];
      if (oldest.d === 1) this.buyVol -= oldest.q;
      else this.sellVol -= oldest.q;
      this.lo += 1;
    }
  }

  /** 依目前累計值回傳 1 分鐘統計（不變動狀態） */
  stats(): Trade1mStats {
    const totalVol = this.buyVol + this.sellVol;
    return {
      buyVol: this.buyVol,
      sellVol: this.sellVol,
      totalVol,
      cvd: this.buyVol - this.sellVol,
      buyRatio: totalVol > 0 ? (this.buyVol / totalVol) * 100 : 50,
    };
  }

  /** 全清（測試 / 重啟引擎用） */
  clear(): void {
    this.entries = [];
    this.lo = 0;
    this.buyVol = 0;
    this.sellVol = 0;
  }

  /** 當 lo 累積過多已刪項時把陣列壓縮回 0 起點 */
  private compactIfNeeded(): void {
    if (this.lo > 4096 && this.lo > this.entries.length / 2) {
      this.entries = this.entries.slice(this.lo);
      this.lo = 0;
    }
  }
}
