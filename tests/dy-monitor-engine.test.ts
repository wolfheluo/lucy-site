// =====================================================================
//  dy-monitor 引擎測試（以 fake client + fake notifier 驅動，不連外網）
//  覆蓋：快照→場次、彈幕→事件/禮物計價/去重、顯示與收錄脫鉤、
//        背景房擷取與選中房跳過、開播/下播通知與冷卻、instance 鎖、
//        切房不重複建場次
// =====================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DyMonitorStore } from "../tools/dy-monitor/server/store.js";
import { DyEngine, parseRid, keepByFlags } from "../tools/dy-monitor/server/engine.js";
import type { DyClientLike, NotifyKind } from "../tools/dy-monitor/server/engine.js";
import type {
  DecodedIm,
  DyMessage,
  FansRank,
  GiftCatalogEntry,
  RankMember,
  RoomSnapshot,
} from "../tools/dy-monitor/types.js";

let dir: string;
let clock: number;
let store: DyMonitorStore;
let engine: DyEngine;

function snap(rid: string, over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    web_rid: rid,
    room_id: `room-${rid}`,
    status: 2,
    status_text: "直播中",
    title: "測試直播",
    viewer_text: "1.2萬",
    viewers: 12000,
    viewers_desc: "1.2萬",
    like_count: 500,
    total_user: "10万+",
    anchor_id: `anchor-${rid}`,
    anchor_name: "迪士尼在逃公主",
    anchor_sec_uid: "sec",
    cover: "",
    has_goods: false,
    auth: {},
    ts: 0,
    ...over,
  };
}

function msg(type: string, over: Partial<DyMessage> = {}): DyMessage {
  return {
    type,
    nickname: "觀眾甲",
    content: "",
    gift_id: 0,
    repeat: 0,
    gift_name: "",
    msg_id: `m-${Math.random()}`,
    ts: 0,
    ...over,
  };
}

class FakeClient implements DyClientLike {
  rooms = new Map<string, RoomSnapshot | null>();
  chats: Record<string, DecodedIm> = {};
  catalog: Record<string, GiftCatalogEntry> = { "1": { name: "小心心", diamond: 1 }, "2": { name: "玫瑰", diamond: 10 } };
  rank: RankMember[] = [
    { rank: 1, nickname: "榜一", pay_level: 12, fans_level: 3, guard: true, mystery: false },
  ];
  fans: FansRank = { club_name: "公主團", fans_name: "騎士", active: 10, total: 99, members: [{ nickname: "榜一", intimacy: 5000, level: 9 }] };
  chatCalls = 0;
  snapshotCalls = 0;

  async roomSnapshot(rid: string): Promise<RoomSnapshot | null> {
    this.snapshotCalls++;
    return this.rooms.get(rid) ?? null;
  }
  async fetchChat(roomId: string): Promise<DecodedIm> {
    this.chatCalls++;
    const q = this.chats[roomId];
    if (!q) return { messages: [], cursor: `cur-${roomId}` };
    return q;
  }
  async audienceList(): Promise<{ members: RankMember[] }> {
    return { members: this.rank };
  }
  async fansClubRank(): Promise<FansRank> {
    return this.fans;
  }
  async fansClubMeta(): Promise<Partial<FansRank> & { today_new: number }> {
    return { ...this.fans, today_new: 2 };
  }
  async giftCatalog(): Promise<Record<string, GiftCatalogEntry>> {
    return this.catalog;
  }
}

let client: FakeClient;
let sent: { kind: NotifyKind; rid: string | null; text: string }[];

function makeEngine(opts: { instanceId?: string | null; abogusReady?: boolean } = {}) {
  engine = new DyEngine({
    store,
    client,
    notifier: async (kind, rid, text) => {
      sent.push({ kind, rid, text });
      return { ok: true, error: "" };
    },
    dashboardUrl: "https://wolfheluo.com/tools/dy-monitor",
    log: () => {},
    now: () => clock,
    instanceId: opts.instanceId ?? "0",
    abogusReady: opts.abogusReady ?? false,
  });
  return engine;
}

const rows = (sql: string, ...args: unknown[]) => store.db.prepare(sql).all(...args) as Record<string, unknown>[];
const one = (sql: string, ...args: unknown[]) => store.db.prepare(sql).get(...args) as Record<string, unknown> | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dy-engine-"));
  clock = 1_700_000_000;
  store = new DyMonitorStore(path.join(dir, "dy.db"), { now: () => clock, log: () => {} });
  client = new FakeClient();
  sent = [];
});

afterEach(() => {
  engine?.stop();
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseRid / keepByFlags", () => {
  it("從網址或純數字取出 web_rid", () => {
    expect(parseRid("https://live.douyin.com/812195156626")).toBe("812195156626");
    expect(parseRid("812195156626")).toBe("812195156626");
    expect(parseRid("abc")).toBeNull();
  });

  it("依 flags 過濾事件類別", () => {
    const flags = { chat: 1, gift: 0, member: 0, snap: 1, rank: 0 };
    expect(keepByFlags(msg("Chat"), flags)).toBe(true);
    expect(keepByFlags(msg("Gift"), flags)).toBe(false);
    expect(keepByFlags(msg("Member"), flags)).toBe(false);
    expect(keepByFlags(msg("Like"), flags)).toBe(false);
  });
});

describe("Monitor：快照與場次", () => {
  it("tickStats 建立場次、寫快照與序列，並載入禮物目錄", async () => {
    client.rooms.set("812195156626", snap("812195156626"));
    makeEngine();
    engine.select("812195156626");
    await engine.tickStats();
    store.flushNow();

    const session = one("SELECT * FROM sessions WHERE web_rid=?", "812195156626");
    expect(session).toBeTruthy();
    expect(session!.partial).toBe(0);
    const snaps = rows("SELECT * FROM snapshots WHERE session_id=?", session!.id);
    expect(snaps.length).toBe(1);
    expect(store.catalogSize()).toBe(2);

    const state = engine.state(0) as {
      room: RoomSnapshot;
      series: unknown[];
      db: { session_id: number };
      intervals: { stats: number };
    };
    expect(state.room.viewers).toBe(12000);
    expect(state.series.length).toBe(1);
    expect(state.db.session_id).toBe(session!.id);
    expect(state.intervals.stats).toBe(3);
  });

  it("下播時 intervals.stats 變 60 秒", async () => {
    client.rooms.set("812195156626", snap("812195156626", { status: 4, status_text: "已下播" }));
    makeEngine();
    engine.select("812195156626");
    await engine.tickStats();
    const state = engine.state(0) as { intervals: { stats: number } };
    expect(state.intervals.stats).toBe(60);
  });

  it("切房再切回（900 秒內）不會多建場次", async () => {
    client.rooms.set("111111111", snap("111111111"));
    client.rooms.set("222222222", snap("222222222"));
    makeEngine();
    engine.select("111111111");
    await engine.tickStats();
    clock += 30;
    engine.select("222222222");
    await engine.tickStats();
    clock += 30;
    engine.select("111111111");
    await engine.tickStats();
    store.flushNow();
    const sessions = rows("SELECT * FROM sessions WHERE web_rid=?", "111111111");
    expect(sessions.length).toBe(1);
  });
});

describe("Monitor：彈幕與禮物計價", () => {
  it("gift 以目錄價 × repeat 計鑽石，聊天/進場/點讚進計數器", async () => {
    client.rooms.set("812195156626", snap("812195156626"));
    client.chats["room-812195156626"] = {
      messages: [
        msg("Chat", { content: "主播好", nickname: "甲", msg_id: "c1" }),
        msg("Gift", { gift_id: 2, repeat: 3, nickname: "大哥", msg_id: "g1" }),
        msg("Member", { nickname: "新人", msg_id: "mb1" }),
        msg("Like", { nickname: "讚手", msg_id: "lk1" }),
      ],
      cursor: "cur-1",
    };
    makeEngine();
    engine.select("812195156626");
    await engine.tickStats(); // 先載目錄
    await engine.tickChat();
    store.flushNow();

    const state = engine.state(0) as {
      gifts: { total_diamonds: number; events: number; top: { nickname: string; diamonds: number }[] };
      inter: { chat: number; member: number; like_events: number; chat_users: number };
      chat: { content: string; diamonds?: number }[];
      chat_cursor: number;
    };
    expect(state.gifts.total_diamonds).toBe(30); // 玫瑰 10 鑽 × 3
    expect(state.gifts.events).toBe(1);
    expect(state.gifts.top[0]).toMatchObject({ nickname: "大哥", diamonds: 30 });
    expect(state.inter).toMatchObject({ chat: 1, member: 1, like_events: 1, chat_users: 1 });
    const giftRow = state.chat.find((c) => c.content.startsWith("玫瑰"));
    expect(giftRow).toMatchObject({ diamonds: 30 });
    expect(state.chat_cursor).toBe(4);
  });

  it("關閉 cap_chat 時：面板照樣計數，但 DB 不寫 Chat 事件", async () => {
    client.rooms.set("812195156626", snap("812195156626"));
    client.chats["room-812195156626"] = {
      messages: [msg("Chat", { content: "hi", msg_id: "c1" }), msg("Gift", { gift_id: 1, repeat: 1, msg_id: "g1" })],
      cursor: "c",
    };
    makeEngine();
    engine.select("812195156626");
    store.ensureTarget("812195156626");
    store.updateTarget("812195156626", { cap_chat: 0 });
    await engine.tickStats();
    await engine.tickChat();
    store.flushNow();

    const types = rows("SELECT type FROM events").map((r) => r.type);
    expect(types).toEqual(["Gift"]);
    const state = engine.state(0) as { inter: { chat: number } };
    expect(state.inter.chat).toBe(1); // 顯示與存檔脫鉤
  });

  it("同 msg_id 重複推送：顯示與 DB 只算一次（計數器與 Python 版同語意，在去重前累加）", async () => {
    client.rooms.set("812195156626", snap("812195156626"));
    const dup = msg("Chat", { content: "重複", msg_id: "same" });
    client.chats["room-812195156626"] = { messages: [dup], cursor: "c" };
    makeEngine();
    engine.select("812195156626");
    await engine.tickStats();
    await engine.tickChat();
    await engine.tickChat();
    store.flushNow();
    const state = engine.state(0) as { chat_cursor: number; inter: { chat: number }; chat: unknown[] };
    expect(state.chat_cursor).toBe(1); // 只進佇列一次
    expect(state.chat.length).toBe(1);
    const session = one("SELECT * FROM sessions WHERE web_rid=?", "812195156626");
    const eventCount = rows("SELECT * FROM events WHERE session_id=?", session!.id).length;
    expect(eventCount).toBe(1);
    // 與 Python 版一致：inter 計數器在去重前累加（cursor 重疊時會多算）
    expect(state.inter.chat).toBe(2);
  });
});

describe("Warden：狀態通知", () => {
  it("首次看到只建基準；開播與下播各通知一次（含冷卻）", async () => {
    store.ensureTarget("222222222", "小葵", "一只小葵");
    store.updateTarget("222222222", { capture: 0 });
    client.rooms.set("222222222", snap("222222222", { status: 4, status_text: "已下播" }));
    makeEngine();
    engine.select("111111111");

    await engine.tickStatus(); // 基準：4
    expect(sent).toHaveLength(0);
    expect(one("SELECT last_status FROM targets WHERE web_rid=?", "222222222")!.last_status).toBe(4);

    // 開播
    clock += 60;
    client.rooms.set("222222222", snap("222222222", { status: 2 }));
    await engine.tickStatus();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "live", rid: "222222222" });
    expect(sent[0]!.text).toContain("開播了");

    // 冷卻期內再次轉換不重送
    clock += 10;
    client.rooms.set("222222222", snap("222222222", { status: 4 }));
    await engine.tickStatus();
    expect(sent).toHaveLength(1);

    // 超過冷卻後的下播通知
    clock += 400;
    client.rooms.set("222222222", snap("222222222", { status: 2 }));
    await engine.tickStatus();
    client.rooms.set("222222222", snap("222222222", { status: 4 }));
    clock += 400;
    await engine.tickStatus();
    const end = sent.filter((s) => s.kind === "end");
    expect(end.length).toBeGreaterThanOrEqual(1);
    expect(end[end.length - 1]!.text).toContain("下播了");
    expect(rows("SELECT * FROM notifications").length).toBeGreaterThanOrEqual(2);
  });

  it("notify_live=0 時不發開播通知", async () => {
    store.ensureTarget("222222222");
    store.updateTarget("222222222", { notify_live: 0 });
    client.rooms.set("222222222", snap("222222222", { status: 4 }));
    makeEngine();
    await engine.tickStatus();
    clock += 60;
    client.rooms.set("222222222", snap("222222222", { status: 2 }));
    await engine.tickStatus();
    expect(sent.filter((s) => s.kind === "live")).toHaveLength(0);
  });

  it("testPush 會寫入 notifications（ok=1）", async () => {
    makeEngine();
    const res = await engine.testPush();
    expect(res.ok).toBe(true);
    const n = one("SELECT * FROM notifications WHERE kind='test'");
    expect(n).toMatchObject({ ok: 1 });
    expect(String(n!.text)).toContain("測試推播");
  });
});

describe("Warden：背景房擷取", () => {
  it("背景房依 flags 收錄事件與快照；選中房被跳過", async () => {
    store.ensureTarget("111111111"); // 選中房
    store.ensureTarget("222222222");
    store.updateTarget("222222222", { last_status: 2 });
    client.rooms.set("111111111", snap("111111111"));
    client.rooms.set("222222222", snap("222222222"));
    client.chats["room-222222222"] = {
      messages: [
        msg("Chat", { content: "bg", msg_id: "bg1" }),
        msg("Gift", { gift_id: 1, repeat: 2, msg_id: "bg2" }),
      ],
      cursor: "cur-b",
    };
    client.chats["room-111111111"] = { messages: [msg("Chat", { content: "selected", msg_id: "s1" })], cursor: "c" };
    makeEngine();
    engine.select("111111111");
    await engine.tickStats();
    await engine.tickCapture();
    store.flushNow();

    const bgSession = one("SELECT * FROM sessions WHERE web_rid=?", "222222222");
    expect(bgSession).toBeTruthy();
    const bgTypes = rows("SELECT type FROM events WHERE session_id=?", bgSession!.id).map((r) => r.type);
    expect(bgTypes.sort()).toEqual(["Chat", "Gift"]);
    expect(rows("SELECT * FROM snapshots WHERE session_id=?", bgSession!.id).length).toBe(1);

    // 選中房的 session 不應由 capture 迴圈重複建立
    const selSessions = rows("SELECT * FROM sessions WHERE web_rid=?", "111111111");
    expect(selSessions.length).toBe(1);
    const selEvents = rows("SELECT * FROM events WHERE session_id=?", selSessions[0]!.id);
    expect(selEvents.length).toBe(0); // capture 跳過選中房
  });

  it("capture=0 → 不建場次，並把先前的背景場次結案", async () => {
    store.ensureTarget("222222222");
    store.updateTarget("222222222", { last_status: 2 });
    client.rooms.set("222222222", snap("222222222"));
    makeEngine();
    engine.select("111111111");
    await engine.tickCapture();
    const created = one("SELECT * FROM sessions WHERE web_rid=?", "222222222");
    expect(created).toBeTruthy();

    store.updateTarget("222222222", { capture: 0 });
    clock += 20;
    await engine.tickCapture();
    const closed = one("SELECT * FROM sessions WHERE web_rid=?", "222222222");
    expect(closed!.ended_at).not.toBeNull();
  });
});

describe("instance 鎖與狀態", () => {
  it("NODE_APP_INSTANCE 非 0 → 不啟動引擎", () => {
    makeEngine({ instanceId: "1" });
    engine.start("812195156626");
    expect(engine.running).toBe(false);
    expect(store.getSetting("engine_owner", "")).toBe("");
  });

  it("instanceId=0 → 啟動並寫 engine_owner", () => {
    client.rooms.set("812195156626", snap("812195156626"));
    makeEngine({ instanceId: "0" });
    engine.start("812195156626");
    expect(engine.running).toBe(true);
    expect(store.getSetting("engine_owner", "")).toContain("@");
    engine.stop();
    expect(engine.running).toBe(false);
  });

  it("targetsWithState 回傳 selected / status_text / caps_on", () => {
    store.ensureTarget("111111111", "甲");
    store.ensureTarget("222222222", "乙");
    store.updateTarget("222222222", { cap_rank: 0 });
    makeEngine();
    engine.select("111111111");
    const list = engine.targetsWithState();
    const a = list.find((t) => t.web_rid === "111111111")!;
    const b = list.find((t) => t.web_rid === "222222222")!;
    expect(a.selected).toBe(true);
    expect(a.caps_on).toBe(5);
    expect(b.selected).toBe(false);
    expect(b.caps_on).toBe(4);
    expect(a.status_text).toBe("未知");
  });

  it("state() 明確標示 a_bogus 未啟用（P1）", () => {
    makeEngine({ abogusReady: false });
    const state = engine.state(0) as { api: { abogus: boolean; rank_ok: boolean } };
    expect(state.api.abogus).toBe(false);
    expect(state.api.rank_ok).toBe(false);
  });
});
