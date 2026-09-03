// auth / session / login rate-limit 整合測試（直接打 Hono app）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { signSession } from "../server/auth.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "lucy-test-"));
let app: ReturnType<typeof createApp>;

function cfg() {
  return loadConfig({
    VAULT_DATA_DIR: dataDir,
    VAULT_ADMIN_PASSWORD: "test-pass",
    VAULT_SESSION_SECRET: "test-secret",
    NODE_ENV: "test",
    TRUST_PROXY: "1", // 測試以 X-Forwarded-For 模擬不同來源 IP
  } as NodeJS.ProcessEnv);
}

async function login(password: string, ip = "203.0.113.1") {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });
  return res;
}

beforeAll(() => {
  app = createApp(cfg());
});

afterAll(() => {
  app.db.close(); // M1：先關閉 SQLite 才能刪 temp 目錄（Windows EPERM）
  rmSync(dataDir, { recursive: true, force: true });
});

describe("auth", () => {
  it("health 正常", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("未登入 me → authed:false", async () => {
    const res = await app.request("/api/auth/me");
    expect((await res.json()).authed).toBe(false);
  });

  it("錯誤密碼 → 401 + remaining", async () => {
    const res = await login("wrong");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.remaining).toBeTypeOf("number");
  });

  it("正確密碼 → 200 + httpOnly cookie", async () => {
    const res = await login("test-pass");
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("lucy_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("帶 session cookie → authed:true", async () => {
    const loginRes = await login("test-pass");
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
    const me = await app.request("/api/auth/me", { headers: { cookie } });
    expect((await me.json()).authed).toBe(true);
  });

  it("竄改 cookie → authed:false", async () => {
    const loginRes = await login("test-pass");
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
    const me = await app.request("/api/auth/me", {
      headers: { cookie: `${cookie}x` },
    });
    expect((await me.json()).authed).toBe(false);
  });

  it("偽造簽名 cookie → authed:false", async () => {
    const forged = signSession("wrong-secret", { v: 1, at: Date.now(), n: "x" });
    const me = await app.request("/api/auth/me", {
      headers: { cookie: `lucy_session=${forged}` },
    });
    expect((await me.json()).authed).toBe(false);
  });

  it("logout 回傳過期 cookie（瀏覽器端刪除）", async () => {
    const loginRes = await login("test-pass", "203.0.113.40");
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("lucy_session=");
    // 登出後 server 要求瀏覽器刪除 cookie（無狀態 signed session 的唯一撤銷方式）
    const out = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(out.status).toBe(200);
    const sc = (out.headers.get("set-cookie") ?? "").toLowerCase();
    expect(sc).toMatch(/lucy_session=.*(max-age=0|expires=thu, 01 jan 1970)/);
  });

  it("連錯 5 次鎖定 → 第 6 次正確密碼也 429", async () => {
    const ip = "203.0.113.99"; // 專用 IP，避免污染其他測試
    for (let i = 0; i < 5; i++) {
      await login("wrong-pass", ip);
    }
    const res = await login("test-pass", ip);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.retryAfterSec).toBeGreaterThan(0);
  });
});
