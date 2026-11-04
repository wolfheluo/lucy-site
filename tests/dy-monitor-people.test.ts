// =====================================================================
//  dy-monitor「現在的人」API 測試（Hono app.request，不連外網）
//  覆蓋：uid／抖音號／sec_uid 聚合、神秘人優先排序、mystery 與 q 篩選
// =====================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { DyMonitorStore } from "../tools/dy-monitor/server/store.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "dy-people-"));
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

const SEC_MYSTERY = "MS4wLjABAAAA-326JCaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function seed() {
  const store = new DyMonitorStore(path.join(dataDir, "dy-monitor.db"), { log: () => {} });
  store.ensureTarget("812195156626", "公主", "迪士尼在逃公主👸");
  store.updateTarget("812195156626", { last_status: 2 });

  const { id } = store.ensureSession(
    {
      web_rid: "812195156626",
      room_id: "room-1",
      status: 2,
      status_text: "直播中",
      title: "people 測試場",
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

  // 神秘人（進場）— uid / 抖音號 / sec_uid 全部到位
  store.addEvent(id, {
    type: "Member",
    nickname: "神秘人五阶",
    user_id: "3651942287676042",
    display_id: "32662562629",
    sec_uid: SEC_MYSTERY,
    content: "進入了直播間",
    msg_id: "m1",
  });
  // 神秘人（送禮）— uid 被遮成 111111
  store.addEvent(id, {
    type: "Gift",
    nickname: "神秘人二阶",
    user_id: "111111",
    display_id: "",
    sec_uid: "",
    gift_id: 1,
    gift_name: "小心心",
    repeat: 1,
    diamonds: 1,
    msg_id: "g1",
  });
  // 一般觀眾（發言）
  store.addEvent(id, {
    type: "Chat",
    nickname: "小明",
    user_id: "93357425249",
    display_id: "xiaoming",
    sec_uid: "MS4wLjABAAAAother",
    content: "hi",
    msg_id: "c1",
  });
  store.flushNow();
  store.stop();
  return id;
}

beforeAll(() => {
  app = createApp(cfg());
  seed();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("現在的人", () => {
  it("聚合 uid／抖音號／型別，神秘人優先", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/people?limit=10", { headers: auth(cookie) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      total: number;
      mystery_total: number;
      people: {
        uid: string;
        nickname: string;
        display_id: string;
        sec_uid: string;
        types: string[];
        mystery: boolean;
      }[];
    };
    expect(json.ok).toBe(true);
    expect(json.total).toBe(3);
    expect(json.mystery_total).toBe(2);
    expect(json.people[0]!.mystery).toBe(true);
    const five = json.people.find((p) => p.uid === "3651942287676042");
    expect(five).toMatchObject({
      nickname: "神秘人五阶",
      display_id: "32662562629",
      sec_uid: SEC_MYSTERY,
      types: ["Member"],
      mystery: true,
    });
    const normal = json.people.find((p) => p.uid === "93357425249");
    expect(normal).toMatchObject({ display_id: "xiaoming", types: ["Chat"], mystery: false });
  });

  it("mystery=1 只回神秘人", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/people?mystery=1", { headers: auth(cookie) });
    const json = (await res.json()) as { people: { mystery: boolean }[]; mystery_total: number };
    expect(json.mystery_total).toBe(2);
    expect(json.people).toHaveLength(2);
    expect(json.people.every((p) => p.mystery)).toBe(true);
  });

  it("q 可用 uid／抖音號／暱稱搜尋", async () => {
    const cookie = await login();
    for (const q of ["32662562629", "3651942287676042", "五阶"]) {
      const res = await app.request(
        `/api/tools/dy-monitor/people?q=${encodeURIComponent(q)}`,
        { headers: auth(cookie) }
      );
      const json = (await res.json()) as { people: { uid: string }[] };
      expect(json.people).toHaveLength(1);
      expect(json.people[0]!.uid).toBe("3651942287676042");
    }
  });

  it("沒有場次 → ok:false / no_session", async () => {
    const cookie = await login();
    const res = await app.request("/api/tools/dy-monitor/people?rid=777777777", {
      headers: auth(cookie),
    });
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json).toMatchObject({ ok: false, error: "no_session" });
  });
});
