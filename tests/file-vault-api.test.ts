// file-vault API 整合測試：認證 / 上傳 / 分享 / 公開下載 / rate-limit / 自毀
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import type { UploadResponse } from "../tools/file-vault/types";

const dataDir = mkdtempSync(path.join(tmpdir(), "fv-api-"));
let app: ReturnType<typeof createApp>;
const PASSWORD = "test-pass";

const ADMIN_IP = "203.0.113.200";

function cfg() {
  return loadConfig({
    VAULT_DATA_DIR: dataDir,
    VAULT_ADMIN_PASSWORD: PASSWORD,
    VAULT_SESSION_SECRET: "test-secret",
    NODE_ENV: "test",
    TRUST_PROXY: "1", // 測試以 X-Forwarded-For 模擬不同來源 IP
  } as NodeJS.ProcessEnv);
}

let loginSeq = 0;
async function login(): Promise<string> {
  // 每次登入用不同 IP，避免 login rate-limit 跨測試累積
  const ip = `203.0.113.${200 + (loginSeq++ % 50)}`;
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

function authHeaders(cookie: string, ip = ADMIN_IP): Record<string, string> {
  return { cookie, "x-forwarded-for": ip };
}

/** 以 FormData 上傳多檔 */
async function upload(cookie: string, files: { name: string; content: Buffer | string }[]) {
  const fd = new FormData();
  for (const f of files) {
    fd.append("file", new Blob([f.content]), f.name);
  }
  const res = await app.request("/api/tools/file-vault/upload", {
    method: "POST",
    headers: authHeaders(cookie),
    body: fd,
  });
  const json = (await res.json()) as UploadResponse;
  return { status: res.status, json };
}

async function createShare(cookie: string, fileId: string) {
  const res = await app.request(`/api/tools/file-vault/share/${fileId}`, {
    method: "POST",
    headers: authHeaders(cookie),
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

describe("file-vault API 認證", () => {
  it("未登入存取管理 API → 401", async () => {
    const routes = [
      ["GET", "/api/tools/file-vault/files"],
      ["POST", "/api/tools/file-vault/upload"],
      ["GET", "/api/tools/file-vault/download/x"],
      ["DELETE", "/api/tools/file-vault/delete/x"],
      ["POST", "/api/tools/file-vault/share/x"],
      ["DELETE", "/api/tools/file-vault/share/x"],
    ] as const;
    for (const [method, url] of routes) {
      const res = await app.request(url, { method });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });
});

describe("file-vault 上傳/管理", () => {
  it("上傳多檔 → 列表含檔、大小正確", async () => {
    const cookie = await login();
    const content = Buffer.from("hello vault 內容", "utf8");
    const { status, json } = await upload(cookie, [
      { name: "測試報告.txt", content },
      { name: "b.bin", content: Buffer.from([0, 1, 2, 3, 4, 5]) },
    ]);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.files).toHaveLength(2);
    expect(json.files.every((f) => f.ok)).toBe(true);
    const first = json.files[0];
    expect(first.file?.originalName).toBe("測試報告.txt");
    expect(first.file?.size).toBe(content.length);
    expect(first.file?.share).toBeNull();
    // 實體檔是 .dat 隔離
    const f = first.file!;
    expect(f.storedName.endsWith(".dat")).toBe(true);

    const listRes = await app.request("/api/tools/file-vault/files", {
      headers: authHeaders(cookie),
    });
    const list = (await listRes.json()) as { files: { id: string }[] };
    expect(list.files.some((x) => x.id === f.id)).toBe(true);
  });

  it("路徑穿越檔名被淨化", async () => {
    const cookie = await login();
    const { json } = await upload(cookie, [{ name: "../../etc/passwd", content: "x" }]);
    expect(json.files[0].file?.originalName).toBe("passwd");
  });

  it("管理下載內容一致（含中文檔名 header）", async () => {
    const cookie = await login();
    const content = Buffer.from("download-me-中文", "utf8");
    const { json } = await upload(cookie, [{ name: "下載檔.txt", content }]);
    const id = json.files[0].file!.id;
    const res = await app.request(`/api/tools/file-vault/download/${id}`, {
      headers: authHeaders(cookie),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(cd.split("''")[1])).toBe("下載檔.txt");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(content)).toBe(true);
  });

  it("刪除後下載 404", async () => {
    const cookie = await login();
    const { json } = await upload(cookie, [{ name: "del.txt", content: "x" }]);
    const id = json.files[0].file!.id;
    const del = await app.request(`/api/tools/file-vault/delete/${id}`, {
      method: "DELETE",
      headers: authHeaders(cookie),
    });
    expect(del.status).toBe(200);
    const dl = await app.request(`/api/tools/file-vault/download/${id}`, {
      headers: authHeaders(cookie),
    });
    expect(dl.status).toBe(404);
  });

  it("上傳無檔案 → 400", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/file-vault/upload", {
      method: "POST",
      headers: { ...authHeaders(cookie), "content-type": "multipart/form-data; boundary=x" },
      body: "--x\r\n--x--\r\n",
    });
    expect(res.status).toBe(400);
  });
});

describe("file-vault 分享與公開下載", () => {
  it("建立分享 → /s/ GET 顯示檔名與大小", async () => {
    const cookie = await login();
    const { json } = await upload(cookie, [{ name: "share-me.txt", content: "secret-data" }]);
    const id = json.files[0].file!.id;
    const shareRes = await createShare(cookie, id);
    expect(shareRes.status).toBe(200);
    const share = (await shareRes.json()).share as { shareId: string; pin: string };
    expect(share.shareId).toMatch(/^[a-z]{4}$/);
    expect(share.pin).toMatch(/^\d{4}$/);

    const page = await app.request(`/s/${share.shareId}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("share-me.txt");
    expect(html).toContain("ENTER PIN");
  });

  it("公開下載：錯 pin 拒絕、對 pin 成功且內容一致", async () => {
    const cookie = await login();
    const content = Buffer.from("top-secret-檔案內容", "utf8");
    const { json } = await upload(cookie, [{ name: "秘密.txt", content }]);
    const id = json.files[0].file!.id;
    const share = (await (await createShare(cookie, id)).json()).share as {
      shareId: string;
      pin: string;
    };

    // 錯 pin（公開 IP，不影響 admin）
    const badIp = "198.51.100.7";
    const bad = await app.request(`/s/${share.shareId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": badIp },
      body: `pin=0000`,
    });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("PIN 錯誤");

    // 對 pin → 檔案流
    const ok = await app.request(`/s/${share.shareId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": badIp },
      body: `pin=${share.pin}`,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/octet-stream");
    const cd = ok.headers.get("content-disposition") ?? "";
    expect(decodeURIComponent(cd.split("''")[1])).toBe("秘密.txt");
    const buf = Buffer.from(await ok.arrayBuffer());
    expect(buf.equals(content)).toBe(true);
  });

  it("pin 錯 10 次 → 429 鎖定（專用 IP）", async () => {
    const cookie = await login();
    const { json } = await upload(cookie, [{ name: "ratelimit.txt", content: "x" }]);
    const id = json.files[0].file!.id;
    const share = (await (await createShare(cookie, id)).json()).share as {
      shareId: string;
      pin: string;
    };
    const ip = "198.51.100.99";
    const tryPin = async () =>
      app.request(`/s/${share.shareId}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
        body: `pin=9999`,
      });
    for (let i = 0; i < 10; i++) {
      const r = await tryPin();
      expect(r.status, `第 ${i + 1} 次`).toBe(401);
    }
    const locked = await tryPin();
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("鎖定");
  });

  it("分享撤銷後 /s/ 404；刪檔後分享頁 404", async () => {
    const cookie = await login();
    const { json } = await upload(cookie, [{ name: "rev.txt", content: "x" }]);
    const id = json.files[0].file!.id;
    const share = (await (await createShare(cookie, id)).json()).share as { shareId: string };
    const revoke = await app.request(`/api/tools/file-vault/share/${id}`, {
      method: "DELETE",
      headers: authHeaders(cookie),
    });
    expect(revoke.status).toBe(200);
    const page = await app.request(`/s/${share.shareId}`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("LINK EXPIRED");
  });

  it("不存在的分享 → 404 頁", async () => {
    const page = await app.request("/s/zzzz");
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("LINK EXPIRED");
  });
});


describe("72h 自毀讀取路徑（M-2：過期即時湮滅，不靠每小時 sweep）", () => {
  it("分享連結過期 → GET/POST 404、DB 記錄與磁碟檔清除", async () => {
    const cookie = await login();
    const up = await upload(cookie, [{ name: "m2-expiry.txt", content: "expiry payload" }]);
    const fid = up.json.files[0].file.id;
    const share = (await (await createShare(cookie, fid)).json()).share;

    // 直接改 DB 把 expire_time 推到過去（模擬到期、尚未 sweep）
    app.db.prepare("UPDATE vault_files SET expire_time = ? WHERE id = ?").run(Date.now() - 5000, fid);

    // 分享頁 GET → 404（過期即湮滅，不等待每小時 cleanup）
    const getRes = await app.request(`/s/${share.shareId}`, {
      headers: { "x-forwarded-for": "198.51.100.70" },
    });
    expect(getRes.status).toBe(404);

    // PIN 下載 POST → 404
    const postRes = await app.request(`/s/${share.shareId}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.70", "content-type": "application/x-www-form-urlencoded" },
      body: `pin=${share.pin}`,
    });
    expect(postRes.status).toBe(404);

    // 管理端：list 不再含、download 404
    const listRes = await app.request("/api/tools/file-vault/files", { headers: authHeaders(cookie) });
    const files = (await listRes.json()).files as { id: string }[];
    expect(files.some((f) => f.id === fid)).toBe(false);

    const dlRes = await app.request(`/api/tools/file-vault/download/${fid}`, { headers: authHeaders(cookie) });
    expect(dlRes.status).toBe(404);
  });
});


describe("上傳數量上限（M-9：>50 檔不再靜默丟棄）", () => {
  it("51 檔 → 50 成功 + 明確超限錯誤 item", async () => {
    const cookie = await login();
    const many: { name: string; content: string }[] = [];
    for (let i = 0; i < 51; i++) many.push({ name: `bulk-${i}.txt`, content: `file ${i}` });
    const res = await upload(cookie, many);
    expect(res.status).toBe(200);
    const okCount = res.json.files.filter((r) => r.ok).length;
    const errs = res.json.files.filter((r) => !r.ok);
    expect(okCount).toBe(50);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.error.includes("上限"))).toBe(true);
  });
});
