// =====================================================================
//  dy-monitor API 整合測試（Hono app.request，不連外網）
//  覆蓋：登入牆、健康檢查、監控清單 CRUD 與 v4 旗標語意、
//        選中房不可刪、離線回放 payload、通知端點
//  房間資料直接寫入 SQLite（引擎在 NODE_ENV=test 不啟動）
// =====================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createApp } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { DyMonitorStore } from "../tools/dy-monitor/server/store.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "dy-api-"));
const PASSWORD = "test-pass";
let app: ReturnType<typeof createApp>;
let loginSeq = 0;

function cfg() {
  return loadConfig({
    VAULT_DATA_DIR: dataDir,
    VAULT_ADMIN_PASSWORD: PASSWORD,
    VAULT_SESSION_SECRET: "test-secret",
    NODE_ENV: "test",
    TRUST_PROXY: "1",
  } as NodeJS.ProcessEnv);
}

async function login(): Promise<string> {
  const ip = `198.51.100.${10 + (loginSeq++ % 200)}`;
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const auth = (cookie: string) => ({ cookie, "x-forwarded-for": "198.51.100.250" });

/** 直接對 dy-monitor.db 準備資料（引擎在測試環境不啟動） */
function seed() {
  const store = new DyMonitorStore(path.join(dataDir, "dy-monitor.db"), { log: () => {} });
  store.ensureTarget("812195156626", "公主", "迪士尼在逃公主👸");
  store.updateTarget("812195156626", { last_status: 2 });
  store.ensureTarget("458774237890", "小葵", "一只小葵");
  store.updateTarget("458774237890", { last_status: 4, cap_rank: 0 });

  // 一場有資料的場次（供 replay）
  const { id } = store.ensureSession(
    {
      web_rid: "812195156626",
      room_id: "room-1",
      status: 2,
      status_text: "直播中",
      title: "回放測試場",
      viewer_text: "1.2萬",
      viewers: 12000,
      viewers_desc: "",
      like_count: 1000,
      total_user: "10万+",
      anchor_id: "anchor-1",
      anchor_name: "迪士尼在逃公主👸",
      anchor_sec_uid: "",
      cover: "",
      has_goods: false,
      auth: {},
      ts: Date.now() / 1000,
    },
    { flags: { chat: 1, gift: 1, member: 1, snap: 1, rank: 0 } }
  );
  store.addEvent(id, { type: "Chat", nickname: "甲", content: "hi", msg_id: "c1" });
  store.addEvent(id, {
    type: "Gift",
    nickname: "大哥",
    gift_id: 2,
    gift_name: "玫瑰",
    repeat: 2,
    diamonds: 20,
    msg_id: "g1",
  });
  store.addSnapshot(id, {
    web_rid: "812195156626",
    room_id: "room-1",
    status: 2,
    status_text: "",
    title: "",
    viewer_text: "",
    viewers: 12000,
    viewers_desc: "",
    like_count: 1000,
    total_user: "",
    anchor_id: "",
    anchor_name: "",
    anchor_sec_uid: "",
    cover: "",
    has_goods: false,
    auth: {},
    ts: 1_700_000_000,
  });
  store.flushNow();
  store.refreshSummary(id, null, true);
  store.stop();
  return id;
}

let sessionId = 0;

beforeAll(() => {
  app = createApp(cfg());
  sessionId = seed();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("登入牆", () => {
  it("未登入的所有端點都是 401", async () => {
    for (const p of [
      "/api/tools/dy-monitor/state",
      "/api/tools/dy-monitor/targets",
      "/api/tools/dy-monitor/notifications",
      "/api/tools/dy-monitor/health",
      "/api/tools/dy-monitor/replay/812195156626",
    ]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(401);
    }
  });
});

describe("health 與清單", () => {
  it("health 回報引擎/憑證/DB 狀態", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/health", { headers: auth(cookie) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.abogus).toBe(false); // P1：簽名尚未移植
    expect(json.max_targets).toBe(5);
    expect(json.targets).toBe(2);
    expect(typeof json.db_size_mb).toBe("number");
  });

  it("targets 回傳 caps_on / caps_total 與 selected", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/targets", { headers: auth(cookie) });
    const json = (await res.json()) as {
      ok: boolean;
      selected: string;
      targets: { web_rid: string; caps_on: number; status_text: string }[];
    };
    expect(json.ok).toBe(true);
    const t1 = json.targets.find((t) => t.web_rid === "812195156626")!;
    expect(t1.caps_on).toBe(5);
    expect(t1.status_text).toBe("直播中");
  });
});

describe("新增 / 修改 / 刪除", () => {
  it("網址解析不到房間號 → 400", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/targets", {
      method: "POST",
      headers: { ...auth(cookie), "content-type": "application/json" },
      body: JSON.stringify({ url: "不是網址" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH cap_chat=0 只影響該項，總開關維持", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/targets/812195156626", {
      method: "PATCH",
      headers: { ...auth(cookie), "content-type": "application/json" },
      body: JSON.stringify({ cap_chat: 0 }),
    });
    const json = (await res.json()) as { target: Record<string, number> };
    expect(res.status).toBe(200);
    expect(json.target.cap_chat).toBe(0);
    expect(json.target.capture).toBe(1);
    expect(json.target.cap_gift).toBe(1);
  });

  it("只丟 capture=0 → 五項全關；capture=1（原全關）→ 五項全開", async () => {
    const cookie = await login();
    let res = await app.request("/api/tools/dy-monitor/targets/458774237890", {
      method: "PATCH",
      headers: { ...auth(cookie), "content-type": "application/json" },
      body: JSON.stringify({ capture: 0 }),
    });
    let json = (await res.json()) as { target: Record<string, number> };
    expect(json.target).toMatchObject({ capture: 0, cap_chat: 0, cap_gift: 0, cap_member: 0, cap_snap: 0, cap_rank: 0 });

    res = await app.request("/api/tools/dy-monitor/targets/458774237890", {
      method: "PATCH",
      headers: { ...auth(cookie), "content-type": "application/json" },
      body: JSON.stringify({ capture: 1 }),
    });
    json = (await res.json()) as { target: Record<string, number> };
    expect(json.target).toMatchObject({ capture: 1, cap_chat: 1, cap_gift: 1, cap_member: 1, cap_snap: 1, cap_rank: 1 });
  });

  it("不在清單的房間 PATCH → 404", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/targets/999999999", {
      method: "PATCH",
      headers: { ...auth(cookie), "content-type": "application/json" },
      body: JSON.stringify({ notify_live: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it("選中的房間不可刪除", async () => {
    const cookie = await login();
    const sel = await app.request("/api/tools/dy-monitor/targets/812195156626/select", {
      method: "POST",
      headers: auth(cookie),
    });
    expect(sel.status).toBe(200);
    const del = await app.request("/api/tools/dy-monitor/targets/812195156626", {
      method: "DELETE",
      headers: auth(cookie),
    });
    expect(del.status).toBe(400);
  });

  it("非選中房可以刪除", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/targets/458774237890", {
      method: "DELETE",
      headers: auth(cookie),
    });
    expect(res.status).toBe(200);
    const list = await app.request("/api/tools/dy-monitor/targets", { headers: auth(cookie) });
    const json = (await list.json()) as { targets: { web_rid: string }[] };
    expect(json.targets.some((t) => t.web_rid === "458774237890")).toBe(false);
  });
});

describe("離線回放", () => {
  it("回傳場次 KPI、曲線、彈幕與送禮榜", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/replay/812195156626", {
      headers: auth(cookie),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      replay: boolean;
      session: { id: number; gift_diamonds: number };
      series: { viewers: number; likes: number }[];
      chat: { type: string; content: string }[];
      gifts: { total_diamonds: number; events: number; top: { nickname: string; diamonds: number }[] };
      fans: unknown;
    };
    expect(json.ok).toBe(true);
    expect(json.replay).toBe(true);
    expect(json.session.id).toBe(sessionId);
    expect(json.session.gift_diamonds).toBe(20);
    expect(json.series[0]).toMatchObject({ viewers: 12000, likes: 1000 });
    expect(json.chat.map((c) => c.type).sort()).toEqual(["Chat", "Gift"]);
    expect(json.gifts.total_diamonds).toBe(20);
    expect(json.gifts.top[0]).toMatchObject({ nickname: "大哥", diamonds: 20 });
    expect(json.fans).toBeNull();
  });

  it("沒有任何場次 → ok:false / no_session", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/replay/777777777", {
      headers: auth(cookie),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json).toMatchObject({ ok: false, error: "no_session" });
  });
});

describe("通知端點", () => {
  it("未設定 LINE 時測試推播回 ok:false 並留下紀錄", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/notify/test", {
      method: "POST",
      headers: auth(cookie),
    });
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("LINE 未設定");

    const list = await app.request("/api/tools/dy-monitor/notifications", {
      headers: auth(cookie),
    });
    const nj = (await list.json()) as { notifications: { kind: string; ok: number }[] };
    expect(nj.notifications[0]).toMatchObject({ kind: "test", ok: 0 });
  });

  it("DB 檔已建立在 dataDir（獨立於 vault.db）", () => {
    const db = new Database(path.join(dataDir, "dy-monitor.db"), { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("sessions");
    expect(tables.map((t) => t.name)).not.toContain("vault_files");
    db.close();
  });
});
