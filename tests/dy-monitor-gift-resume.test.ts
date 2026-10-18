// =====================================================================
//  重啟續接：禮物計數（本場禮物總值／貢獻榜）從 DB 回填
//  驗證 engine 在 ensureSession 回 resumed 時，把已收錄的 Gift 事件接回記憶體
// =====================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DyMonitorStore } from "../tools/dy-monitor/server/store.js";
import { DyEngine } from "../tools/dy-monitor/server/engine.js";
import type { DyClientLike } from "../tools/dy-monitor/server/engine.js";
import type {
  AudienceResult,
  DecodedIm,
  DyMessage,
  FansRank,
  FansMeta,
  GiftCatalogEntry,
  RoomSnapshot,
} from "../tools/dy-monitor/types.js";

let dir: string;
let clock: number;
let store: DyMonitorStore;
let engines: DyEngine[] = [];

const RID = "812195156626";

function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    web_rid: RID,
    room_id: `room-${RID}`,
    status: 2,
    status_text: "直播中",
    title: "測試直播",
    viewer_text: "100",
    viewers: 100,
    viewers_desc: "100",
    like_count: 1,
    total_user: "1万+",
    anchor_id: "anchor-1",
    anchor_name: "主播",
    anchor_sec_uid: "sec",
    cover: "",
    has_goods: false,
    auth: {},
    ts: 0,
    ...over,
  };
}

function giftMsg(nickname: string, msgId: string, repeat = 1): DyMessage {
  return {
    type: "Gift",
    nickname,
    content: "",
    gift_id: 2,
    repeat,
    gift_name: "",
    msg_id: msgId,
    ts: 0,
  };
}

class FakeClient implements DyClientLike {
  chats: DecodedIm = { messages: [], cursor: "c1" };
  async roomSnapshot(): Promise<RoomSnapshot | null> {
    return snap();
  }
  async fetchChat(): Promise<DecodedIm> {
    const q = this.chats;
    this.chats = { messages: [], cursor: q.cursor };
    return q;
  }
  async audienceList(): Promise<AudienceResult> {
    return { members: [] };
  }
  async fansClubRank(): Promise<FansRank> {
    return { club_name: "", fans_name: "", active: 0, total: 0, members: [] };
  }
  async fansClubMeta(): Promise<Partial<FansMeta>> {
    return {};
  }
  async giftCatalog(): Promise<Record<string, GiftCatalogEntry>> {
    return { "2": { name: "玫瑰", diamond: 10 } };
  }
}

function makeEngine(): { engine: DyEngine; client: FakeClient } {
  const client = new FakeClient();
  const e = new DyEngine({
    store,
    client,
    notifier: async () => ({ ok: true, error: "" }),
    dashboardUrl: "",
    log: () => {},
    now: () => clock,
    instanceId: "0",
    abogusReady: false,
  });
  engines.push(e);
  return { engine: e, client };
}

const gifts = (e: DyEngine) =>
  (
    e.state(0) as {
      gifts: { total_diamonds: number; events: number; top: { nickname: string; diamonds: number; count: number }[] };
    }
  ).gifts;

const sidOf = () =>
  (store.db.prepare("SELECT id FROM sessions WHERE web_rid=?").get(RID) as { id: number }).id;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dy-resume-"));
  clock = 1_700_000_000;
  store = new DyMonitorStore(path.join(dir, "dy.db"), { now: () => clock, log: () => {} });
  engines = [];
});

afterEach(() => {
  engines.forEach((e) => e.stop());
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("重啟續接：禮物回填", () => {
  it("續接同一場時，把 DB 已收錄禮物接回 giftTotal / 貢獻榜", async () => {
    // 第一次啟動：建立場次、跑一輪彈幕收 3 筆禮物
    const first = makeEngine();
    first.engine.select(RID);
    await first.engine.tickStats(); // 載入禮物目錄
    first.client.chats = {
      messages: [giftMsg("甲", "g1"), giftMsg("甲", "g2", 3), giftMsg("乙", "g3")],
      cursor: "c2",
    };
    await first.engine.tickChat();
    store.flushNow();
    const sid = sidOf();
    expect(gifts(first.engine).total_diamonds).toBe(50); // 10 + 30 + 10
    first.engine.stop();
    engines = [];

    // 模擬重啟：新引擎記憶體歸零，同一份 DB 續接同場
    clock += 60;
    const second = makeEngine();
    second.engine.select(RID);
    await second.engine.tickStats();

    const g = gifts(second.engine);
    expect(g.events).toBe(3);
    expect(g.total_diamonds).toBe(50);
    expect(g.top[0]).toMatchObject({ nickname: "甲", diamonds: 40, count: 2 });
    expect(g.top[1]).toMatchObject({ nickname: "乙", diamonds: 10, count: 1 });

    // 面板數字 == DB 彙總
    const summary = store.refreshSummary(sid);
    expect(summary.gift_diamonds).toBe(g.total_diamonds);
    expect(summary.gift_events).toBe(g.events);
  });

  it("回填後新禮物在原基準上累加", async () => {
    const first = makeEngine();
    first.engine.select(RID);
    await first.engine.tickStats();
    first.client.chats = { messages: [giftMsg("甲", "g1")], cursor: "c2" };
    await first.engine.tickChat();
    store.flushNow();
    expect(gifts(first.engine).total_diamonds).toBe(10);
    first.engine.stop();
    engines = [];

    clock += 30;
    const second = makeEngine();
    second.engine.select(RID);
    await second.engine.tickStats();
    expect(gifts(second.engine).total_diamonds).toBe(10); // 回填基準

    second.client.chats = { messages: [giftMsg("乙", "g2", 2)], cursor: "c3" };
    await second.engine.tickChat();
    store.flushNow();

    const g = gifts(second.engine);
    expect(g.total_diamonds).toBe(30); // 10（回填）+ 20（新）
    expect(g.events).toBe(2);
    expect(store.refreshSummary(sidOf()).gift_diamonds).toBe(30);
  });

  it("新開場次不回填（DB 無此場事件 → 0）", async () => {
    const { engine } = makeEngine();
    engine.select(RID);
    await engine.tickStats();
    const g = gifts(engine);
    expect(g.events).toBe(0);
    expect(g.total_diamonds).toBe(0);
    expect(g.top).toEqual([]);
  });
});
