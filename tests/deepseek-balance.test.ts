// DEEPSEEK 餘額 route 測試（mock fetch；60s cache 用 fake clock）
import { describe, it, expect, vi } from "vitest";
import { createBalanceApi } from "../server/deepseek-balance";

const CNY_BODY = {
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "16.19", granted_balance: "0.00", topped_up_balance: "16.19" },
    { currency: "USD", total_balance: "-0.00", granted_balance: "0.00", topped_up_balance: "-0.00" },
  ],
};

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function countingFetch(body: unknown): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const fetch = (async () => {
    n += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch, calls: () => n };
}

describe("GET /balance（DeepSeek CNY 餘額）", () => {
  it("成功：取 currency=CNY 的 total_balance → { ok:true, cny:16.19 }", async () => {
    const api = createBalanceApi({ apiKey: "sk-test", fetchImpl: jsonFetch(CNY_BODY) });
    const res = await api.request("/balance");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cny: 16.19 });
  });

  it("無 API_KEY → { ok:false }，且不打 DeepSeek", async () => {
    const spy = vi.fn();
    const api = createBalanceApi({ apiKey: null, fetchImpl: spy as unknown as typeof fetch });
    const res = await api.request("/balance");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("DeepSeek 非 2xx（key 無效）→ { ok:false }", async () => {
    const api = createBalanceApi({
      apiKey: "sk-bad",
      fetchImpl: jsonFetch({ error: { message: "Authentication Fails" } }, 401),
    });
    const res = await api.request("/balance");
    expect(await res.json()).toEqual({ ok: false });
  });

  it("回傳沒有 CNY currency → { ok:false }", async () => {
    const api = createBalanceApi({
      apiKey: "sk-test",
      fetchImpl: jsonFetch({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "5" }] }),
    });
    const res = await api.request("/balance");
    expect(await res.json()).toEqual({ ok: false });
  });

  it("60s cache：窗內重複請求不打 DeepSeek；過期後重查", async () => {
    const { fetch, calls } = countingFetch(CNY_BODY);
    let nowMs = 1_700_000_000_000;
    const api = createBalanceApi({
      apiKey: "sk-test",
      fetchImpl: fetch,
      now: () => nowMs,
    });

    const r1 = await api.request("/balance");
    expect(await r1.json()).toEqual({ ok: true, cny: 16.19 });
    expect(calls()).toBe(1);

    // 窗內（+30s）：用 cache，不打 DeepSeek
    nowMs += 30_000;
    const r2 = await api.request("/balance");
    expect(await r2.json()).toEqual({ ok: true, cny: 16.19 });
    expect(calls()).toBe(1);

    // 過期（+61s）：重查
    nowMs += 31_000;
    const r3 = await api.request("/balance");
    expect(await r3.json()).toEqual({ ok: true, cny: 16.19 });
    expect(calls()).toBe(2);
  });

  it("失敗（401）不寫 cache：下一次請求會重試", async () => {
    let mode: "bad" | "good" = "bad";
    const fetch = (async () =>
      new Response(
        JSON.stringify(mode === "bad" ? { error: {} } : CNY_BODY),
        { status: mode === "bad" ? 401 : 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;
    const api = createBalanceApi({ apiKey: "sk-test", fetchImpl: fetch });

    expect(await (await api.request("/balance")).json()).toEqual({ ok: false });
    mode = "good"; // key 修好
    expect(await (await api.request("/balance")).json()).toEqual({ ok: true, cny: 16.19 });
  });
});
