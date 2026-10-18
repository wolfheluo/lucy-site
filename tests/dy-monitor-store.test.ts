// =====================================================================
//  dy-monitor 落地層測試（store.ts）
//  覆蓋：場次續接/復播寬限/切房回歸、事件去重、彙總、收錄旗標、目標 CRUD、
//        通知、對帳、DB 大小與 WAL checkpoint
// =====================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DyMonitorStore } from "../tools/dy-monitor/server/store.js";
import type { RoomSnapshot } from "../tools/dy-monitor/types.js";

let dir: string;
let clock: number;
let store: DyMonitorStore;

function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    web_rid: "812195156626",
    room_id: "7697860220311063347",
    status: 2,
    status_text: "直播中",
    title: "測試場",
    viewer_text: "1.2萬",
    viewers: 12000,
    viewers_desc: "1.2萬",
    like_count: 500,
    total_user: "10万+",
    anchor_id: "anchor-1",
    anchor_name: "迪士尼在逃公主",
    anchor_sec_uid: "sec-1",
    cover: "",
    has_goods: false,
    auth: {},
    ts: clock,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dy-monitor-store-"));
  clock = 1_700_000_000;
  store = new DyMonitorStore(path.join(dir, "dy-monitor.db"), {
    now: () => clock,
    flushSecs: 3600, // 測試自己呼叫 flushNow
    log: () => {},
  });
});

afterEach(() => {
  try {
    store.stop();
  } catch {
    // 已關閉
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("場次生命週期", () => {
  it("首次建立場次（partial=0）", () => {
    const { id, resumed } = store.ensureSession(snap(), { flags: { chat: 1, gift: 1, member: 1, snap: 1, rank: 0 } });
    expect(resumed).toBe(false);
    const row = store.getSession(id)!;
    expect(row.web_rid).toBe("812195156626");
    expect(row.partial).toBe(0);
    expect(row.likes_start).toBe(500);
    expect(JSON.parse(row.flags!)).toMatchObject({ rank: 0 });
  });

  it("300 秒內同房續接同一場", () => {
    const a = store.ensureSession(snap());
    clock += 240;
    const b = store.ensureSession(snap({ viewers: 15000 }));
    expect(b.id).toBe(a.id);
    expect(b.resumed).toBe(true);
  });

  it("超過 300 秒才再次看到 → 舊場結案、開新場", () => {
    const a = store.ensureSession(snap());
    clock += 400;
    const b = store.ensureSession(snap());
    expect(b.id).not.toBe(a.id);
    const old = store.getSession(a.id)!;
    expect(old.ended_at).not.toBeNull();
  });

  it("場次結束 900 秒內切回 → 重開同一場並標記 partial", () => {
    const a = store.ensureSession(snap());
    store.closeSession(a.id);
    clock += 500;
    const b = store.ensureSession(snap());
    expect(b.id).toBe(a.id);
    expect(b.resumed).toBe(true);
    const row = store.getSession(a.id)!;
    expect(row.ended_at).toBeNull();
    expect(row.partial).toBe(1);
  });

  it("場次結束超過 900 秒 → 建新場", () => {
    const a = store.ensureSession(snap());
    store.closeSession(a.id);
    clock += 1000;
    const b = store.ensureSession(snap());
    expect(b.id).not.toBe(a.id);
  });

  it("房間 id 不同視為不同場（即使時間接近）", () => {
    const a = store.ensureSession(snap());
    clock += 10;
    const b = store.ensureSession(snap({ room_id: "other-room" }));
    expect(b.id).not.toBe(a.id);
  });
});

describe("事件 / 快照 / 彙總", () => {
  it("同 msg_id 只寫一筆（INSERT OR IGNORE）", () => {
    const { id } = store.ensureSession(snap());
    store.addEvent(id, { type: "Chat", nickname: "a", content: "hi", msg_id: "same" });
    store.addEvent(id, { type: "Chat", nickname: "a", content: "hi", msg_id: "same" });
    store.flushNow();
    const n = store.db
      .prepare("SELECT COUNT(*) c FROM events WHERE session_id=?")
      .get(id) as { c: number };
    expect(n.c).toBe(1);
  });

  it("refreshSummary 聚合禮物/聊天/進場與快照", () => {
    const { id } = store.ensureSession(snap());
    store.addEvent(id, { type: "Gift", nickname: "哥", gift_id: 1, gift_name: "小心心", diamonds: 10, msg_id: "g1" });
    store.addEvent(id, { type: "Gift", nickname: "哥", gift_id: 1, gift_name: "小心心", diamonds: 5, msg_id: "g2" });
    store.addEvent(id, { type: "Chat", nickname: "甲", content: "1", msg_id: "c1" });
    store.addEvent(id, { type: "Chat", nickname: "乙", content: "2", msg_id: "c2" });
    store.addEvent(id, { type: "Member", nickname: "丙", msg_id: "m1" });
    store.addSnapshot(id, snap({ viewers: 100, like_count: 500 }));
    store.addSnapshot(id, snap({ viewers: 300, like_count: 900 }));
    store.flushNow();

    const summary = store.refreshSummary(id);
    expect(summary).toMatchObject({
      gift_diamonds: 15,
      gift_events: 2,
      chat_count: 2,
      chat_users: 2,
      member_count: 1,
      snapshot_count: 2,
      peak_viewers: 300,
      avg_viewers: 200,
      likes_start: 500,
      likes_end: 900,
    });
    const check = store.selfcheck(id);
    expect(check.ok).toBe(true);
    expect(check.diff).toEqual({
      gift_diamonds: 0,
      gift_events: 0,
      chat_count: 0,
      chat_users: 0,
      member_count: 0,
    });
  });

  it("榜單與粉絲團快照可寫入並序列化 payload", () => {
    const { id } = store.ensureSession(snap());
    store.addRank(id, "audience", [
      { rank: 1, nickname: "榜一", pay_level: 12, fans_level: 3, guard: true, mystery: false },
    ]);
    store.addFans(id, { club_name: "公主團", fans_name: "騎士", active: 10, total: 99, today_new: 2, guard: true }, [
      { nickname: "榜一", intimacy: 5000, level: 9 },
    ]);
    store.flushNow();
    const rank = store.db
      .prepare("SELECT * FROM rank_snapshots WHERE session_id=?")
      .get(id) as Record<string, unknown>;
    expect(rank.kind).toBe("audience");
    expect(rank.score).toBe(0);
    expect(rank.level).toBe(12);
    expect(JSON.parse(String(rank.payload))).toMatchObject({ nickname: "榜一", guard: true });
    const fans = store.db
      .prepare("SELECT * FROM fans_snapshots WHERE session_id=?")
      .get(id) as Record<string, unknown>;
    expect(fans.club_name).toBe("公主團");
    expect(JSON.parse(String(fans.members))[0].intimacy).toBe(5000);
  });
});

describe("監控清單與收錄旗標（v4）", () => {
  it("ensureTarget / 更新 / 刪除", () => {
    const t = store.ensureTarget("123", "標籤", "主播甲")!;
    expect(t).toMatchObject({ web_rid: "123", label: "標籤", anchor_name: "主播甲" });
    store.updateTarget("123", { notify_live: 0, label: "新標籤" });
    expect(store.getTarget("123")).toMatchObject({ notify_live: 0, label: "新標籤" });
    store.deleteTarget("123");
    expect(store.getTarget("123")).toBeUndefined();
  });

  it("未設定的房 → 預設全開", () => {
    expect(store.targetFlags("456")).toEqual({ chat: 1, gift: 1, member: 1, snap: 1, rank: 1 });
  });

  it("capture=0 → 五項全 0；關掉單項只影響該項", () => {
    store.ensureTarget("123");
    store.updateTarget("123", { capture: 0 });
    expect(store.targetFlags("123")).toEqual({ chat: 0, gift: 0, member: 0, snap: 0, rank: 0 });
    store.updateTarget("123", { capture: 1, cap_rank: 0 });
    expect(store.targetFlags("123")).toEqual({ chat: 1, gift: 1, member: 1, snap: 1, rank: 0 });
  });

  it("五項全關時 syncCaptureSwitch 會把總開關關掉", () => {
    store.ensureTarget("123");
    store.updateTarget("123", { cap_chat: 0, cap_gift: 0, cap_member: 0, cap_snap: 0, cap_rank: 0 });
    store.syncCaptureSwitch("123");
    expect(store.getTarget("123")!.capture).toBe(0);
    store.updateTarget("123", { cap_chat: 1 });
    store.syncCaptureSwitch("123");
    expect(store.getTarget("123")!.capture).toBe(1);
  });

  it("updateTarget 忽略不在白名單的欄位", () => {
    store.ensureTarget("123");
    store.updateTarget("123", { web_rid: "hacked", added_at: 0 } as Record<string, unknown>);
    const t = store.getTarget("123")!;
    expect(t.web_rid).toBe("123");
  });

  it("flagsAny 判斷是否有任何收錄", () => {
    expect(DyMonitorStore.flagsAny({ chat: 0, gift: 0, member: 0, snap: 0, rank: 0 })).toBe(false);
    expect(DyMonitorStore.flagsAny({ chat: 0, gift: 1, member: 0, snap: 0, rank: 0 })).toBe(true);
    expect(DyMonitorStore.flagsAny(null)).toBe(false);
  });
});

describe("通知 / 設定 / 維運", () => {
  it("通知紀錄含 ok 與錯誤原因", () => {
    store.addNotification("123", "live", true, "", "開播了");
    store.addNotification("123", "end", false, "LINE 未設定", "下播了");
    const list = store.listNotifications(10);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ kind: "end", ok: 0, error: "LINE 未設定" });
  });

  it("meta 設定可讀寫（selected_web_rid）", () => {
    expect(store.getSetting("selected_web_rid", "none")).toBe("none");
    store.setSetting("selected_web_rid", "812195156626");
    expect(store.getSetting("selected_web_rid")).toBe("812195156626");
  });

  it("sizeBytes 計算主檔與 WAL，walCheckpoint 不拋錯", () => {
    store.ensureSession(snap());
    store.flushNow();
    expect(store.sizeBytes()).toBeGreaterThan(0);
    expect(() => store.walCheckpoint()).not.toThrow();
  });

  it("禮物目錄 upsert 與查價", () => {
    store.saveCatalog({ 1: { name: "小心心", diamond: 1 }, 2: { name: "玫瑰", diamond: 10 } });
    store.saveCatalog({ 1: { name: "小心心", diamond: 2 } });
    expect(store.getCatalog(1)).toMatchObject({ diamond: 2 });
    expect(store.catalogSize()).toBe(2);
  });

  it("stop() 會 flush 剩餘佇列", () => {
    const { id } = store.ensureSession(snap());
    store.addEvent(id, { type: "Chat", nickname: "x", content: "y", msg_id: "last" });
    store.stop();
    const fresh = new DyMonitorStore(path.join(dir, "dy-monitor.db"), { log: () => {} });
    const n = fresh.db
      .prepare("SELECT COUNT(*) c FROM events WHERE session_id=?")
      .get(id) as { c: number };
    expect(n.c).toBe(1);
    fresh.stop();
  });
});
