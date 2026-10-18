// =====================================================================
//  粉絲團親密度榜：抓取上限（count）與回傳筆數（前 50）
//  以注入 fetchImpl 隔離外網，只驗證解析/排序/截斷邏輯
// =====================================================================
import { describe, it, expect } from "vitest";
import { DyClient } from "../tools/dy-monitor/server/dycore.js";

const USERS = Array.from({ length: 80 }, (_, i) => ({
  user_info: { nickname: `u${i}` },
  user_fansclub_info: { intimacy: i * 7, level: i % 20 },
}));

function makeClient(urls: string[]) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const body = JSON.stringify({
      data: {
        club_info: { name: "測試團", fans_name: "團員", active_fans_count: 12, total_fans_count: 3456 },
        club_user_list: USERS,
      },
    });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return new DyClient({ cookieHeader: "a=b", fetchImpl, retries: 1 });
}

describe("fansClubRank", () => {
  it("請求帶 count=100（club_user_list 上限）", async () => {
    const urls: string[] = [];
    await makeClient(urls).fansClubRank("65305021017");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/webcast/fansclub/club_user_list/");
    expect(urls[0]).toContain("count=100");
    expect(urls[0]).toContain("anchor_id=65305021017");
  });

  it("回傳前 50 名且親密度由大到小", async () => {
    const r = await makeClient([]).fansClubRank("65305021017");
    expect(r.members).toHaveLength(50);
    const ints = r.members.map((m) => m.intimacy);
    expect(ints).toEqual([...ints].sort((a, b) => b - a));
    expect(ints[0]).toBe(79 * 7);
    expect(ints[49]).toBe(30 * 7);
    expect(r.total).toBe(3456);
  });

  it("來源不足 50 筆時不補齊", async () => {
    const fetchImpl = (async () => {
      const body = JSON.stringify({
        data: { club_info: {}, club_user_list: USERS.slice(0, 7) },
      });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await new DyClient({ cookieHeader: "a=b", fetchImpl, retries: 1 }).fansClubRank("1");
    expect(r.members).toHaveLength(7);
  });
});
