// =====================================================================
//  DOUYIN API 測試（不連網）
//  覆蓋：登入牆、health、cookie 狀態、名單／CSV、通知、場次刪除
// =====================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type LucyApp } from "../server/index.js";
import type { ServerConfig } from "../server/config.js";
import { DyStore } from "../tools/douyin/server/store.js";
import type { RoomSnapshot } from "../tools/douyin/types.js";

let dir: string;
let app: LucyApp;
let cookie = "";

const cfg: ServerConfig = {
  port: 0,
  bindHost: "127.0.0.1",
  dataDir: "",
  adminPassword: "test-pass",
  sessionSecret: "test-secret",
  distDir: null,
  cookieSecure: false,
  trustProxy: false,
  loginRateMax: 5,
  loginRateWindowMs: 15 * 60 * 1000,
  apiKey: null,
};

function snap(): RoomSnapshot {
  return {
    web_rid: "123456789012",
    room_id: "room-api",
    status: 2,
    status_text: "直播中",
    title: "API 測試",
    viewer_text: "10",
    viewers: 10,
    viewers_desc: "10",
    like_count: 5,
    total_user: "20",
    anchor_id: "anchor-api",
    anchor_name: "主播",
    anchor_sec_uid: "sec-api",
    cover: "",
    has_goods: false,
    auth: {},
    ts: 1_700_000_000,
  };
}

async function req(pathname: string, init: RequestInit = {}): Promise<Response> {
  return app.request(pathname, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      Cookie: cookie,
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "douyin-api-"));
  process.env.DY_COOKIE_FILE = path.join(dir, "cookies.json");
  app = createApp({ ...cfg, dataDir: dir });

  // 種一場資料（router 的 store 已開同一 DB，第二連線可寫）
  const seed = new DyStore(path.join(dir, "dy.db"), { now: () => 1_700_000_000, flushSecs: 3600, log: () => {} });
  const sid = seed.ensureSession(snap()).id;
  seed.addMessages(sid, [
    {
      type: "Chat",
      nickname: "神秘人①",
      content: "hi",
      gift_id: 0,
      repeat: 1,
      gift_name: "",
      msg_id: "seed-1",
      user_id: "u-seed",
      display_id: "dou-seed",
      sec_uid: "MS4wLjABseed",
      ts: 1_700_000_000,
    },
    {
      type: "Gift",
      nickname: "神秘人①",
      content: "",
      gift_id: 999,
      repeat: 2,
      gift_name: "跑車",
      diamonds: 600,
      msg_id: "seed-2",
      user_id: "u-seed",
      display_id: "dou-seed",
      sec_uid: "MS4wLjABseed",
      ts: 1_700_000_001,
    },
  ]);
  seed.addSnapshot(sid, snap());
  seed.flushNow();
  seed.refreshSummary(sid);
  seed.stop();
  void sid;

  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-pass" }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterAll(() => {
  for (const h of Object.values(app.handles)) {
    try {
      h.settle?.();
    } catch {
      /* ignore */
    }
  }
  try {
    app.db.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows 檔案鎖 */
  }
});

describe("登入牆", () => {
  it("未登入 401", async () => {
    const res = await app.request("/api/tools/douyin/state");
    expect(res.status).toBe(401);
  });

  it("登入後 health 正常、引擎在 test 環境不啟動", async () => {
    const res = await req("/api/tools/douyin/health");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.running).toBe(false);
    expect(j.max_targets).toBe(3);
    expect(j.chat_ok).toBe(false);
    expect(j.cookie.configured).toBe(false);
  });
});

describe("cookie", () => {
  it("GET 回狀態但不回傳任何值", async () => {
    const j = await (await req("/api/tools/douyin/cookie")).json();
    expect(j.status).toMatchObject({ configured: false, valid: null });
    expect(JSON.stringify(j)).not.toContain("sessionid=");
  });

  it("PUT 缺 sessionid → 400 且不寫檔", async () => {
    const res = await req("/api/tools/douyin/cookie", {
      method: "PUT",
      body: JSON.stringify({ cookie: [{ name: "ttwid", value: "t" }] }),
    });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toContain("sessionid");
  });

  it("PUT 壞 JSON → 400", async () => {
    const res = await req("/api/tools/douyin/cookie", {
      method: "PUT",
      body: "{oops",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE 清除", async () => {
    const j = await (await req("/api/tools/douyin/cookie", { method: "DELETE" })).json();
    expect(j.ok).toBe(true);
    expect(j.status.configured).toBe(false);
  });
});

describe("名單與 CSV", () => {
  it("GET /entrants 回名單、統計與鑽石", async () => {
    const j = await (await req("/api/tools/douyin/entrants?session_id=1")).json();
    expect(j.session_id).toBe(1);
    expect(j.stats).toMatchObject({ total: 1, mystery: 1, visits: 0, chats: 1, diamonds: 600 });
    expect(j.entrants[0]).toMatchObject({ uid: "u-seed", mark: "mystery", diamonds: 600 });
  });

  it("mark=hidden 篩選", async () => {
    const j = await (await req("/api/tools/douyin/entrants?session_id=1&mark=hidden")).json();
    expect(j.entrants).toHaveLength(0);
  });

  it("CSV 有 BOM 與表頭", async () => {
    const res = await req("/api/tools/douyin/entrants/export.csv?session_id=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(buf);
    expect(text).toContain("uid,nickname,display_id,real_nickname");
    expect(text).toContain("u-seed");
  });

  it("刪某人：events 與 entrants 一起清", async () => {
    const j = await (await req("/api/tools/douyin/entrants/u-seed?session_id=1", { method: "DELETE" })).json();
    expect(j.ok).toBe(true);
    expect(j.deleted).toMatchObject({ removed: 1, events: 2 });
    const after = await (await req("/api/tools/douyin/entrants?session_id=1")).json();
    expect(after.entrants).toHaveLength(0);
  });
});

describe("場次與通知", () => {
  it("GET /sessions 列出場次", async () => {
    const j = await (await req("/api/tools/douyin/sessions")).json();
    expect(j.total).toBeGreaterThanOrEqual(1);
    expect(j.sessions[0]).toMatchObject({ id: 1, web_rid: "123456789012" });
  });

  it("測試推播在沒有 LINE 憑證時仍落庫", async () => {
    const j = await (await req("/api/tools/douyin/notify/test", { method: "POST" })).json();
    expect(j.ok).toBe(false);
    const n = await (await req("/api/tools/douyin/notifications")).json();
    expect(n.notifications.length).toBeGreaterThanOrEqual(1);
    expect(n.notifications[0].kind).toBe("test");
  });

  it("刪除場次", async () => {
    const j = await (await req("/api/tools/douyin/sessions/1", { method: "DELETE" })).json();
    expect(j.ok).toBe(true);
    expect(j.deleted.removed).toBe(1);
    const after = await (await req("/api/tools/douyin/sessions")).json();
    expect(after.total).toBe(0);
  });
});
