// C-1 回歸測試：rate-limit 的 IP 來源不得被客戶端偽造
//  - CF-Connecting-IP 優先（Cloudflare 保證覆寫、不可偽造）
//  - 無 CF 時 X-Forwarded-For 只取「最後一個」值（最後一跳代理附加）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import { loadConfig } from "../server/config.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "lucy-ip-test-"));
let app: ReturnType<typeof createApp>;

function cfg() {
  return loadConfig({
    VAULT_DATA_DIR: dataDir,
    VAULT_ADMIN_PASSWORD: "test-pass",
    VAULT_SESSION_SECRET: "test-secret",
    NODE_ENV: "test",
    TRUST_PROXY: "1",
  } as NodeJS.ProcessEnv);
}

async function login(headers: Record<string, string>, password = "wrong") {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

beforeAll(() => {
  app = createApp(cfg());
});
afterAll(() => {
  app.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("clientIp — CF-Connecting-IP 優先（C-1）", () => {
  it("同 CF-IP、偽造不同 XFF → 第 6 次錯即 429（偽造 XFF 無法換身份）", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // XFF 每次都偽造不同前綴，CF-Connecting-IP 固定 → 應全鎖同一桶
      const res = await login({
        "cf-connecting-ip": "203.0.113.50",
        "x-forwarded-for": `198.51.100.${i + 1}, 203.0.113.50`,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429); // 第 6 次達上限 → 繞不過
  });

  it("CF-IP 不同 → 各自獨立桶（正常訪客不受他人影響）", async () => {
    // 上一個測試已鎖 203.0.113.50；換一個 CF-IP 應從頭計算（401 非 429）
    const res = await login({ "cf-connecting-ip": "203.0.113.51" });
    expect(res.status).toBe(401);
  });
});

describe("clientIp — 無 CF 時取 XFF 最後值（C-1 fallback）", () => {
  it('XFF "偽造前綴, 真實IP" → 以最後值計桶（前綴無效）', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // 前綴每次偽造不同，最後值固定 → 鎖同一桶
      const res = await login({
        "x-forwarded-for": `198.51.100.${i + 1}, 203.0.113.88`,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429); // 偽造前綴無效 → 仍被鎖
  });
});
