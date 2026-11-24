// =====================================================================
//  Douyin cookie 測試（不連網）
// =====================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CookieError,
  CookieManager,
  parseCookieInput,
  writeCookieFile,
} from "../tools/douyin/server/cookie.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "douyin-cookie-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows 檔案鎖 */
  }
});

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const okBody = {
  status_code: 0,
  user: { uid: "3999401728289395", nickname: "測試帳號", unique_id: "testuser" },
};

const jsonCookie = JSON.stringify([
  { name: "sessionid", value: "abc123", expirationDate: 2_000_000_000, domain: ".douyin.com" },
  { name: "sid_guard", value: "abc123|x", expirationDate: 1_000_000_000 },
  { name: "ttwid", value: "t1", expirationDate: 1_800_000_000 },
]);

describe("parseCookieInput", () => {
  it("Playwright JSON 陣列 → header，expires 取 sessionid／sid_guard 最早", () => {
    const p = parseCookieInput(jsonCookie);
    expect(p.header).toBe("sessionid=abc123; sid_guard=abc123|x; ttwid=t1");
    expect(p.names).toEqual(["sessionid", "sid_guard", "ttwid"]);
    expect(p.expiresAt).toBe(1_000_000_000_000);
  });

  it("原始 header 字串也接受（無到期時間）", () => {
    const p = parseCookieInput("sessionid=abc; ttwid=t;");
    expect(p.header).toBe("sessionid=abc; ttwid=t");
    expect(p.expiresAt).toBeNull();
  });

  it("重複名稱以最後一筆為準", () => {
    const p = parseCookieInput("sessionid=old; sessionid=new");
    expect(p.header).toBe("sessionid=new");
  });

  it("缺 sessionid → 拒絕", () => {
    expect(() => parseCookieInput("ttwid=t")).toThrow(CookieError);
    expect(() => parseCookieInput("ttwid=t")).toThrow(/sessionid/);
  });

  it("非法名稱／控制字元／過大 → 拒絕", () => {
    expect(() => parseCookieInput('sessionid=a; bad name=b')).toThrow(/名稱不合法/);
    expect(() => parseCookieInput("sessionid=a; x=bad\r\nvalue")).toThrow(/控制字元/);
    const huge = "sessionid=" + "a".repeat(257 * 1024);
    expect(() => parseCookieInput(huge)).toThrow(/256KB/);
  });

  it("JSON 壞掉 → 清楚錯誤", () => {
    expect(() => parseCookieInput("[{oops")).toThrow(/JSON 格式錯誤/);
  });
});

describe("writeCookieFile", () => {
  it("寫入並可覆蓋舊檔", () => {
    const file = path.join(dir, "dy_cookies.json");
    writeCookieFile(file, "sessionid=first");
    expect(readFileSync(file, "utf8").trim()).toBe("sessionid=first");
    writeCookieFile(file, "sessionid=second");
    expect(readFileSync(file, "utf8").trim()).toBe("sessionid=second");
    expect(parseCookieInput(readFileSync(file, "utf8")).header).toBe("sessionid=second");
  });

  it("解析失敗不寫檔", () => {
    const file = path.join(dir, "dy_cookies.json");
    expect(() => writeCookieFile(file, "ttwid=only")).toThrow(CookieError);
    expect(() => readFileSync(file)).toThrow();
  });
});

describe("CookieManager", () => {
  it("check：有效 cookie → valid=true、帳號與到期時間", async () => {
    const file = path.join(dir, "dy_cookies.json");
    writeFileSync(file, jsonCookie);
    let now = 1_700_000_000_000;
    const cm = new CookieManager({ file, fetchImpl: fakeFetch(okBody), now: () => now });
    cm.load();
    const st = await cm.check();
    expect(st).toMatchObject({
      configured: true,
      valid: true,
      expires_at: 1_000_000_000_000,
      account: { uid_tail: "9395", nickname: "測試帳號", unique_id: "testuser" },
      last_error: null,
      checked_at: now,
    });
    expect(st.path).toBe(file);
  });

  it("check：status_code≠0 → valid=false 並保留錯誤", async () => {
    const file = path.join(dir, "dy_cookies.json");
    writeFileSync(file, jsonCookie);
    const cm = new CookieManager({ file, fetchImpl: fakeFetch({ status_code: 8 }), now: () => 1 });
    cm.load();
    const st = await cm.check();
    expect(st.valid).toBe(false);
    expect(st.last_error).toContain("status_code=8");
  });

  it("update：驗證通過才寫檔並熱重載", async () => {
    const file = path.join(dir, "dy_cookies.json");
    const cm = new CookieManager({ file, fetchImpl: fakeFetch(okBody), now: () => 1 });
    const st = await cm.update(jsonCookie);
    expect(st.valid).toBe(true);
    expect(cm.getHeader()).toContain("sessionid=abc123");
    expect(readFileSync(file, "utf8")).toContain("sessionid");
  });

  it("update：驗證失敗不覆蓋舊檔、header 不變", async () => {
    const file = path.join(dir, "dy_cookies.json");
    writeFileSync(file, "sessionid=old");
    const cm = new CookieManager({ file, fetchImpl: fakeFetch({ status_code: 8 }), now: () => 1 });
    cm.load();
    const before = readFileSync(file, "utf8");
    const st = await cm.update("sessionid=new");
    expect(st.valid).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(cm.getHeader()).toBe("sessionid=old");
  });

  it("update：格式錯誤直接丟 CookieError，不發請求", async () => {
    const file = path.join(dir, "dy_cookies.json");
    let called = 0;
    const cm = new CookieManager({
      file,
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(cm.update("ttwid=only")).rejects.toThrow(CookieError);
    expect(called).toBe(0);
  });

  it("clear：刪檔並回到未設定", () => {
    const file = path.join(dir, "dy_cookies.json");
    writeCookieFile(file, "sessionid=abc");
    const cm = new CookieManager({ file, fetchImpl: fakeFetch(okBody) });
    cm.load();
    const st = cm.clear();
    expect(st).toMatchObject({ configured: false, valid: null, account: null });
    expect(cm.getHeader()).toBe("");
    expect(() => readFileSync(file)).toThrow();
  });

  it("沒有檔案 → configured=false、不發請求", async () => {
    let called = 0;
    const cm = new CookieManager({
      file: path.join(dir, "none.json"),
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    cm.load();
    const st = await cm.check();
    expect(st.configured).toBe(false);
    expect(st.valid).toBeNull();
    expect(called).toBe(0);
  });
});
