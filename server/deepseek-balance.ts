// =====================================================================
//  DeepSeek 帳戶餘額查詢（nav 顯示 CNY 餘額用）
//  - server 端帶 API_KEY 查 api.deepseek.com/user/balance（key 不外洩）
//  - 60s 記憶體快取（餘額慢變動；fetch/clock 可注入供測試）
//  - 失敗 / 無 key → { ok:false }（前端隱藏，不顯示錯誤）
// =====================================================================
import { Hono } from "hono";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const FETCH_TIMEOUT_MS = 10_000;

export interface BalanceApiOptions {
  /** DeepSeek API key（.env API_KEY；null = 未設定 → 恆 ok:false） */
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 快取窗（預設 60s） */
  cacheMs?: number;
}

export function createBalanceApi(opts: BalanceApiOptions): Hono {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 60_000;
  let cache: { at: number; cny: number } | null = null;

  /** 查 CNY 餘額；失敗回 null。成功結果 cache 60s；失敗不 cache（下次重試） */
  async function fetchCny(): Promise<number | null> {
    if (!opts.apiKey) return null;
    if (cache && now() - cache.at < cacheMs) return cache.cny;
    try {
      const res = await fetchImpl(BALANCE_URL, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        balance_infos?: Array<{ currency?: string; total_balance?: unknown }>;
      };
      const cny = body.balance_infos?.find((b) => b.currency === "CNY");
      const raw = cny?.total_balance;
      const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return null;
      cache = { at: now(), cny: n };
      return n;
    } catch {
      return null; // 網路/逾時：不 cache
    }
  }

  const api = new Hono();
  api.get("/balance", async (c) => {
    const cny = await fetchCny();
    if (cny === null) return c.json({ ok: false });
    return c.json({ ok: true, cny });
  });
  return api;
}
