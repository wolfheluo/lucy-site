// =====================================================================
//  Rate limiter（SQLite 為底，固定窗口）
//  - key 自由組成，例如 login:<ip>、pin:<ip>:<share_id>
//  - 窗口內超過 max 次 → 拒絕，回 retryAfter 秒
// =====================================================================
import type { Db } from "./db.js";

export interface RateLimitResult {
  allowed: boolean;
  /** 剩餘可試次數（allowed 時） */
  remaining: number;
  /** 需等待秒數（拒絕時） */
  retryAfterSec: number;
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  /** 可注入時鐘（測試用），預設 Date.now */
  now?: () => number;
}

export function makeRateLimiter(db: Db, opts: RateLimiterOptions) {
  const nowFn = opts.now ?? Date.now;
  const insert = db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start`
  );
  const select = db.prepare(`SELECT window_start, count FROM rate_limits WHERE key = ?`);

  return {
    /** 記錄一次嘗試並回報是否仍在允許範圍 */
    hit(key: string): RateLimitResult {
      const now = nowFn();
      const winStart = now - (now % opts.windowMs);
      insert.run(key, winStart);
      const row = select.get(key) as { window_start: number; count: number } | undefined;
      const count = row && row.window_start === winStart ? row.count : 1;
      if (count > opts.max) {
        const retryAfterSec = Math.ceil((winStart + opts.windowMs - now) / 1000);
        return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, retryAfterSec) };
      }
      return { allowed: true, remaining: opts.max - count, retryAfterSec: 0 };
    },

    /** 查詢目前狀態（不記錄） */
    peek(key: string): { count: number; retryAfterSec: number } {
      const now = nowFn();
      const winStart = now - (now % opts.windowMs);
      const row = select.get(key) as { window_start: number; count: number } | undefined;
      if (!row || row.window_start !== winStart) return { count: 0, retryAfterSec: 0 };
      return {
        count: row.count,
        retryAfterSec: row.count > opts.max ? Math.ceil((winStart + opts.windowMs - now) / 1000) : 0,
      };
    },

    /** 清除（測試用） */
    reset(key: string): void {
      db.prepare(`DELETE FROM rate_limits WHERE key = ?`).run(key);
    },
  };
}

export type RateLimiter = ReturnType<typeof makeRateLimiter>;
