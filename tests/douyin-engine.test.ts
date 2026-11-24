// =====================================================================
//  DOUYIN engine 測試（fake client，不連網）
//  覆蓋：快照／場次、彈幕去重與名單、禮物計價、mystery 反查、
//        通知、背景房擷取、失敗退避、cluster 守門、select 重置
// =====================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DyStore } from "../tools/douyin/server/store.js";
import { DyEngine, type ProfileResolverLike } from "../tools/douyin/server/engine.js";
import type { DyClient } from "../tools/douyin/server/dycore.js";
import type { DyMessage, ProfileHit, RoomSnapshot } from "../tools/douyin/types.js";

let dir: string;
let clock: number;
let store: DyStore;
let engine: DyEngine;
let calls: string[];
let notifies: { kind: string; rid: string | null; text: string }[];
let chatByRoom: Record<string, DyMessage[]>;
let snapshots: Record<string, RoomSnapshot | null>;
let failRooms: Set<string>;
let fakeClient: DyClient;
let resolved: string[];

function snap(rid: string, over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    web_rid: rid,
    room_id: `room-${rid}`,
    status: 2,
    status_text: "直播中",
    title: `房 ${rid}`,
    viewer_text: "120",
    viewers: 120,
    viewers_desc: "120",
    like_count: 1000,
    total_user: "5000",
    anchor_id: `anchor-${rid}`,
    anchor_name: `主播 ${rid}`,
    anchor_sec_uid: `sec-${rid}`,
    cover: "",
    has_goods: false,
    auth: {},
    ts: clock,
    ...over,
  };
}

function msg(over: Partial<DyMessage> = {}): DyMessage {
  return {
    type: "Chat",
    nickname: "小明",
    content: "hi",
    gift_id: 0,
    repeat: 1,
    gift_name: "",
    msg_id: `m-${Math.random().toString(36).slice(2)}`,
    user_id: "u1",
    display_id: "dou1",
    sec_uid: "MS4wLjABu1",
    ts: clock,
    ...over,
  };
}

function makeEngine(instanceId: string | null = null): DyEngine {
  fakeClient = {
    roomSnapshot: async (rid: string) => {
      calls.push(`snap:${rid}`);
      if (failRooms.has(rid)) throw new Error("boom");
      return snapshots[rid] ?? null;
    },
    fetchChat: async (roomId: string) => {
      calls.push(`chat:${roomId}`);
      return { messages: chatByRoom[roomId] ?? [], cursor: `c-${roomId}` };
    },
    audienceList: async (_s: RoomSnapshot) => ({
      members: [{ rank: 1, nickname: "觀眾", pay_level: 3, fans_level: 2, guard: false, mystery: false }],
      total: "1",
    }),
    fansClubRank: async () => ({
      club_name: " club",
      fans_name: "fans",
      active: 1,
      total: 2,
      members: [{ nickname: "粉絲", intimacy: 10, level: 2 }],
    }),
    fansClubMeta: async () => ({ today_new: 1, guard: false }),
    giftCatalog: async () => {
      calls.push("catalog");
      return { 999: { name: "跑車", diamond: 300 } };
    },
  } as unknown as DyClient;

  const resolver: ProfileResolverLike = {
    resolve: async (uid: string) => {
      resolved.push(uid);
      const hit: ProfileHit = {
        uid,
        nickname: `真名-${uid}`,
        uniqueId: `real-${uid}`,
        shortId: "",
        secUid: `MS4wLjAB${uid}`,
        followers: 5,
        awemes: 1,
        signature: "",
      };
      return hit;
    },
  };

  return new DyEngine({
    store,
    client: fakeClient,
    resolver,
    notifier: async (kind, rid, text) => {
      notifies.push({ kind, rid, text });
      return { ok: true, error: "" };
    },
    instanceId,
    now: () => clock,
    intervals: { statsOffline: 60, statsLive: 3, rank: 0, fans: 0, catalogTtl: 3600 },
    log: () => {},
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "douyin-engine-"));
  clock = 1_700_000_000;
  calls = [];
  notifies = [];
  resolved = [];
  chatByRoom = {};
  failRooms = new Set();
  snapshots = { "111111": snap("111111"), "222222": snap("222222") };
  store = new DyStore(path.join(dir, "dy.db"), { now: () => clock, flushSecs: 3600, log: () => {} });
  engine = makeEngine();
});

afterEach(() => {
  try {
    engine.stop();
  } catch {
    /* ignore */
  }
  try {
    store.stop();
  } catch {
    /* 已關閉 */
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows 檔案鎖 */
  }
});

describe("選中房", () => {
  it("tickStats：快照、場次、series、榜單、親密度、目錄", async () => {
    engine.select("111111");
    await engine.tickStats();
    store.flushNow();

    const st = engine.state();
    expect(st.selected_web_rid).toBe("111111");
    expect((st.room as RoomSnapshot).anchor_name).toBe("主播 111111");
    const series = st.series as unknown[];
    expect(series).toHaveLength(1);
    expect(st.db).toMatchObject({ session_id: 1 });
    expect(st.api).toMatchObject({ rank_ok: true, chat_ok: false, abogus: true });
    expect(st.gifts).toMatchObject({ catalog: 1 });

    const sid = Number((st.db as { session_id: number }).session_id);
    const counts = store.db
      .prepare("SELECT (SELECT COUNT(*) FROM snapshots) s, (SELECT COUNT(*) FROM rank_snapshots) r, (SELECT COUNT(*) FROM fans_snapshots) f, (SELECT COUNT(*) FROM gift_catalog) g")
      .get() as Record<string, number>;
    expect(counts.s).toBe(1);
    expect(counts.r).toBeGreaterThan(0);
    expect(counts.f).toBe(1);
    expect(counts.g).toBe(1);
    expect(store.getSession(sid)?.web_rid).toBe("111111");
  });

  it("tickChat：去重後才累計；Like 不落庫；禮物 × repeat", async () => {
    engine.select("111111");
    await engine.tickStats();
    chatByRoom["room-111111"] = [
      msg({ type: "Chat", msg_id: "c1", user_id: "u1", content: "a" }),
      msg({ type: "Chat", msg_id: "c1", user_id: "u1", content: "a" }),
      msg({ type: "Member", msg_id: "m1", user_id: "u2", nickname: "新人" }),
      msg({ type: "Gift", msg_id: "g1", user_id: "u1", gift_id: 999, repeat: 2 }),
      msg({ type: "Like", msg_id: "l1", user_id: "u3" }),
    ];
    await engine.tickChat();
    store.flushNow();

    const st = engine.state();
    expect((st.inter as { chat: number }).chat).toBe(1);
    expect((st.inter as { member: number }).member).toBe(1);
    expect((st.inter as { like_events: number }).like_events).toBe(1);
    expect((st.gifts as { total_diamonds: number }).total_diamonds).toBe(600);

    const events = store.db.prepare("SELECT type, content, diamonds FROM events ORDER BY id").all();
    expect(events).toEqual([
      { type: "Chat", content: "a", diamonds: null },
      { type: "Member", content: "hi", diamonds: null },
      { type: "Gift", content: "跑車 ×2", diamonds: 600 },
    ]);
    const row = store.db.prepare("SELECT visits, chat_count, diamonds FROM entrants WHERE uid='u1'").get();
    expect(row).toEqual({ visits: 0, chat_count: 1, diamonds: 600 });
  });

  it("select 會重置記憶體狀態並記住選中房", () => {
    engine.select("111111");
    expect(engine.selectedRid).toBe("111111");
    expect(store.getSetting("selected_web_rid")).toBe("111111");
    engine.select("222222");
    expect(engine.selectedRid).toBe("222222");
    expect(engine.state().series).toHaveLength(0);
  });

  it("快照回空＝已下播：不走退避，改用離線節奏", async () => {
    engine.select("111111");
    await engine.tickStats();
    snapshots["111111"] = null;
    await engine.tickStats();
    const st = engine.state();
    expect((st.room as { status: number }).status).toBe(4);
    expect((st.intervals as { stats: number }).stats).toBe(60);
  });

  it("快照連續失敗 → statsDelay 指數退避（上限 300）", async () => {
    engine.select("111111");
    failRooms.add("111111");
    await engine.tickStats();
    const d1 = (engine.state().intervals as { stats: number }).stats;
    await engine.tickStats();
    const d2 = (engine.state().intervals as { stats: number }).stats;
    expect(d1).toBeGreaterThan(60);
    expect(d2).toBeGreaterThan(d1);
    expect(d2).toBeLessThanOrEqual(300);
  });
});

describe("反查（只做 mystery）", () => {
  it("mystery 會排隊並回填；suspect_hidden 不會", async () => {
    engine.select("111111");
    await engine.tickStats();
    chatByRoom["room-111111"] = [
      msg({ msg_id: "m1", user_id: "u-m", nickname: "神秘人①" }),
      msg({ msg_id: "m2", user_id: "u-h", nickname: "***" }),
    ];
    await engine.tickChat();
    store.flushNow();

    await engine.tickResolve();
    expect(resolved).toEqual(["u-m"]);
    const row = store.db.prepare("SELECT real_nickname FROM entrants WHERE uid='u-m'").get() as {
      real_nickname: string;
    };
    expect(row.real_nickname).toBe("真名-u-m");
    expect(store.getProfile("u-m")?.nickname).toBe("真名-u-m");
    // 第二次同名不重複打 API（profiles 快取）
    await engine.tickResolve();
    expect(resolved).toEqual(["u-m"]);
  });

  it("匿名 mystery 不會進反查佇列", async () => {
    engine.select("111111");
    await engine.tickStats();
    chatByRoom["room-111111"] = [
      msg({ msg_id: "m1", user_id: "111111", display_id: "dou8", nickname: "神秘人②" }),
    ];
    await engine.tickChat();
    await engine.tickResolve();
    expect(resolved).toEqual([]);
  });
});

describe("通知與背景房", () => {
  it("開播轉態送出通知並更新 last_status", async () => {
    engine.select("111111");
    store.ensureTarget("111111", "", "主播 111111");
    store.updateTarget("111111", { last_status: 0, notify_live: 1 });
    await engine.tickStatus();
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ kind: "live", rid: "111111" });
    expect(store.getTarget("111111")?.last_status).toBe(2);
  });

  it("背景房 tickCapture：建立場次、寫事件與名單", async () => {
    engine.select("111111");
    await engine.tickStats();
    store.ensureTarget("222222", "", "主播 222222");
    // 先讓 tickStatus 把 222 標成直播中
    await engine.tickStatus();
    expect(store.getTarget("222222")?.last_status).toBe(2);

    chatByRoom["room-222222"] = [
      msg({ msg_id: "b1", user_id: "u-b", nickname: "背景觀眾" }),
      msg({ type: "Member", msg_id: "b2", user_id: "u-c", nickname: "背景進場" }),
    ];
    await engine.tickCapture();
    store.flushNow();

    const sess = store.db
      .prepare("SELECT id, web_rid FROM sessions WHERE web_rid='222222' ORDER BY id DESC LIMIT 1")
      .get() as { id: number; web_rid: string };
    expect(sess.id).toBeGreaterThan(0);
    const row = store.db.prepare("SELECT visits FROM entrants WHERE session_id=? AND uid='u-c'").get(sess.id);
    expect(row).toEqual({ visits: 1 });
    expect(calls.filter((c) => c === "chat:room-222222")).toHaveLength(1);
  });
});

describe("生命週期", () => {
  it("cluster 非 0 實例不啟動引擎", () => {
    const e = makeEngine("2");
    e.start("111111");
    expect(e.running).toBe(false);
    e.stop();
  });

  it("stop 會結案目前場次", async () => {
    engine.select("111111");
    await engine.tickStats();
    const sid = Number((engine.state().db as { session_id: number }).session_id);
    engine.stop();
    expect(store.getSession(sid)?.ended_at).not.toBeNull();
  });
});
