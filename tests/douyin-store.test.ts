// =====================================================================
//  DOUYIN store 測試
//  覆蓋：事件入庫、entrants 物化（visits／chat／diamonds）、msg_id 去重、
//        canonical uid（匿名）、mark、場次續接、彙總、刪除、反查佇列、profiles
// =====================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DyStore } from "../tools/douyin/server/store.js";
import type { DyMessage, RoomSnapshot } from "../tools/douyin/types.js";

let dir: string;
let clock: number;
let store: DyStore;

function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    web_rid: "812195156626",
    room_id: "room-1",
    status: 2,
    status_text: "直播中",
    title: "測試場",
    viewer_text: "120",
    viewers: 120,
    viewers_desc: "120",
    like_count: 500,
    total_user: "1000",
    anchor_id: "anchor-1",
    anchor_name: "主播",
    anchor_sec_uid: "sec-1",
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

/** 禮物目錄：單價 300 × 連擊 */
const giftValue = (giftId: number, repeat: number) => ({
  diamonds: giftId === 999 ? 300 * (repeat || 1) : 0,
  name: giftId === 999 ? "跑車" : "",
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "douyin-store-"));
  clock = 1_700_000_000;
  store = new DyStore(path.join(dir, "dy.db"), {
    now: () => clock,
    flushSecs: 3600,
    log: () => {},
  });
});

afterEach(() => {
  try {
    store.stop();
  } catch {
    /* 已關閉 */
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows 檔案鎖：斷言已跑完，忽略清理失敗 */
  }
});

function newSession(): number {
  return store.ensureSession(snap()).id;
}

function count(sql: string, ...args: unknown[]): number {
  return (store.db.prepare(sql).get(...args) as { c: number }).c;
}

describe("事件入庫與名單物化", () => {
  it("Member／Chat／Gift 各寫一列，entrant 累計 visits/chat/diamonds", () => {
    const sid = newSession();
    const n = store.addMessages(
      sid,
      [
        msg({ type: "Member", msg_id: "m1", nickname: "小明" }),
        msg({ type: "Chat", msg_id: "m2", nickname: "小明" }),
        msg({ type: "Gift", msg_id: "m3", gift_id: 999, repeat: 2, nickname: "小明" }),
      ],
      { giftValue }
    );
    expect(n).toBe(3);
    store.flushNow();

    expect(count("SELECT COUNT(*) c FROM events")).toBe(3);
    const row = store.db.prepare("SELECT * FROM entrants WHERE uid='u1'").get() as Record<string, unknown>;
    expect(row.visits).toBe(1);
    expect(row.chat_count).toBe(1);
    expect(row.diamonds).toBe(600);
    expect(row.last_gift_ts).toBe(clock);
    expect(row.display_id).toBe("dou1");
    expect(row.sec_uid).toBe("MS4wLjABu1");

    const gift = store.db
      .prepare("SELECT content, diamonds FROM events WHERE msg_id='m3'")
      .get() as { content: string; diamonds: number };
    expect(gift).toEqual({ content: "跑車 ×2", diamonds: 600 });
  });

  it("同一 msg_id 重送只算一次（visits 不重複）", () => {
    const sid = newSession();
    const m = msg({ type: "Member", msg_id: "same" });
    store.addMessages(sid, [m]);
    store.flushNow();
    store.addMessages(sid, [m]);
    store.flushNow();

    expect(count("SELECT COUNT(*) c FROM events")).toBe(1);
    expect((store.db.prepare("SELECT visits FROM entrants WHERE uid='u1'").get() as { visits: number }).visits).toBe(1);
  });

  it("Like 不落庫、也不建名單列", () => {
    const sid = newSession();
    store.addMessages(sid, [msg({ type: "Like", msg_id: "l1" })]);
    store.flushNow();
    expect(count("SELECT COUNT(*) c FROM events")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM entrants")).toBe(0);
  });

  it("只有送禮的人也會進名單（visits=0、diamonds>0）", () => {
    const sid = newSession();
    store.addMessages(sid, [msg({ type: "Gift", msg_id: "g1", gift_id: 999, repeat: 1 })], { giftValue });
    store.flushNow();
    const row = store.db.prepare("SELECT visits, chat_count, diamonds FROM entrants WHERE uid='u1'").get() as {
      visits: number;
      chat_count: number;
      diamonds: number;
    };
    expect(row).toEqual({ visits: 0, chat_count: 0, diamonds: 300 });
  });

  it("匿名 uid 111111 → anon:<抖音號>，並清掉佔位 display_id", () => {
    const sid = newSession();
    store.addMessages(
      sid,
      [
        msg({ msg_id: "a1", user_id: "111111", display_id: "dou888", nickname: "神秘人②" }),
        msg({ msg_id: "a2", user_id: "111111", display_id: "dou888", nickname: "神秘人②" }),
      ]
    );
    store.flushNow();
    const rows = store.db.prepare("SELECT uid, anonymous, display_id, mark FROM entrants").all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uid: "anon:dou888", anonymous: 1, display_id: null, mark: "" });
  });

  it("匿名又沒有抖音號／暱稱 → 丟棄", () => {
    const sid = newSession();
    const n = store.addMessages(sid, [msg({ user_id: "111111", display_id: "", nickname: " " })]);
    store.flushNow();
    expect(n).toBe(0);
    expect(count("SELECT COUNT(*) c FROM events")).toBe(0);
  });
});

describe("標記規則", () => {
  it("神秘人 → mystery；全遮蔽 → suspect_hidden", () => {
    const sid = newSession();
    store.addMessages(sid, [
      msg({ msg_id: "m1", user_id: "u-m", nickname: "神秘人①" }),
      msg({ msg_id: "m2", user_id: "u-h", nickname: "***" }),
    ]);
    store.flushNow();
    const rows = store.db.prepare("SELECT uid, mark FROM entrants ORDER BY uid").all() as {
      uid: string;
      mark: string;
    }[];
    expect(rows).toEqual([
      { uid: "u-h", mark: "suspect_hidden" },
      { uid: "u-m", mark: "mystery" },
    ]);
  });

  it("後續普通暱稱不會把 mystery 降級", () => {
    const sid = newSession();
    store.addMessages(sid, [
      msg({ msg_id: "m1", user_id: "u1", nickname: "神秘人①" }),
      msg({ msg_id: "m2", user_id: "u1", nickname: "小明" }),
    ]);
    store.flushNow();
    expect((store.db.prepare("SELECT mark FROM entrants WHERE uid='u1'").get() as { mark: string }).mark).toBe(
      "mystery"
    );
  });
});

describe("場次續接", () => {
  it("300 秒內同房同 room_id → 續接", () => {
    const a = store.ensureSession(snap());
    clock += 100;
    const b = store.ensureSession(snap());
    expect(b.id).toBe(a.id);
    expect(b.resumed).toBe(true);
  });

  it("room_id 改變 → 新場次", () => {
    const a = store.ensureSession(snap());
    clock += 10;
    const b = store.ensureSession(snap({ room_id: "room-2" }));
    expect(b.id).not.toBe(a.id);
    expect(store.getSession(a.id)?.ended_at).not.toBeNull();
  });

  it("場次結束超過 900 秒再開 → 新場次；900 秒內 → partial=1 續接", () => {
    const a = store.ensureSession(snap());
    store.closeSession(a.id);
    clock += 500;
    const b = store.ensureSession(snap());
    expect(b.id).toBe(a.id);
    expect(store.getSession(a.id)?.partial).toBe(1);

    store.closeSession(a.id);
    clock += 1000;
    const c = store.ensureSession(snap());
    expect(c.id).not.toBe(a.id);
  });
});

describe("彙總", () => {
  it("chat_users 以 user_id 去重；gift_diamonds 加總", () => {
    const sid = newSession();
    store.addMessages(
      sid,
      [
        msg({ msg_id: "c1", user_id: "u1", nickname: "小明", content: "a" }),
        msg({ msg_id: "c2", user_id: "u1", nickname: "小明改名", content: "b" }),
        msg({ msg_id: "c3", user_id: "u2", nickname: "小華", content: "c" }),
        msg({ type: "Gift", msg_id: "g1", user_id: "u1", gift_id: 999, repeat: 3 }),
      ],
      { giftValue }
    );
    store.addSnapshot(sid, snap({ viewers: 100, like_count: 500 }));
    store.flushNow();
    const summary = store.refreshSummary(sid);
    expect(summary.chat_count).toBe(3);
    expect(summary.chat_users).toBe(2);
    expect(summary.gift_diamonds).toBe(900);
    expect(summary.gift_events).toBe(1);
    expect(summary.snapshot_count).toBe(1);
    expect(summary.peak_viewers).toBe(100);
  });
});

describe("刪除", () => {
  it("刪某人：events 與 entrants 一起清掉", () => {
    const sid = newSession();
    store.addMessages(sid, [
      msg({ msg_id: "c1", user_id: "u1" }),
      msg({ msg_id: "c2", user_id: "u2" }),
    ]);
    store.flushNow();
    const del = store.deleteEntrant(sid, "u1");
    expect(del).toEqual({ removed: 1, events: 1 });
    expect(count("SELECT COUNT(*) c FROM events")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM entrants")).toBe(1);
  });

  it("刪整場：各表一起清", () => {
    const sid = newSession();
    store.addMessages(sid, [msg({ msg_id: "c1" })]);
    store.addSnapshot(sid, snap());
    store.flushNow();
    const del = store.deleteSession(sid);
    expect(del.removed).toBe(1);
    expect(count("SELECT COUNT(*) c FROM events")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM entrants")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM snapshots")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM sessions")).toBe(0);
  });
});

describe("反查佇列", () => {
  it("只回 mystery、排除匿名／已解析／重試滿 3 次", () => {
    const sid = newSession();
    store.addMessages(sid, [
      msg({ msg_id: "m1", user_id: "u-m", nickname: "神秘人①" }),
      msg({ msg_id: "m2", user_id: "u-m2", nickname: "神秘人②" }),
      msg({ msg_id: "m3", user_id: "111111", nickname: "神秘人③", display_id: "dou9" }),
      msg({ msg_id: "h1", user_id: "u-h", nickname: "***" }),
    ]);
    store.flushNow();

    // u-m 已解析；u-m2 重試滿 3 次
    store.setReal(sid, "u-m", {
      uid: "u-m",
      nickname: "真名",
      uniqueId: "realid",
      shortId: "",
      secUid: "",
      followers: 0,
      awemes: 0,
      signature: "",
    });
    store.bumpResolveTry(sid, "u-m2");
    store.bumpResolveTry(sid, "u-m2");
    store.bumpResolveTry(sid, "u-m2");

    // u-anon 是匿名，不在佇列
    const rows = store.unresolvedMystery(sid, 10);
    expect(rows).toHaveLength(0);

    // 放一個新的 mystery → 只回它
    store.addMessages(sid, [msg({ msg_id: "m4", user_id: "u-new", nickname: "神秘人④" })]);
    store.flushNow();
    expect(store.unresolvedMystery(sid, 10).map((r) => r.uid)).toEqual(["u-new"]);
  });

  it("setReal 會寫入 profiles 快取", () => {
    const sid = newSession();
    store.addMessages(sid, [msg({ msg_id: "m1", user_id: "u1", nickname: "神秘人①" })]);
    store.flushNow();
    store.setReal(sid, "u1", {
      uid: "u1",
      nickname: "真名",
      uniqueId: "realid",
      shortId: "short",
      secUid: "MS4wLjABreal",
      followers: 12,
      awemes: 3,
      signature: "sig",
    });
    expect(store.getProfile("u1")).toMatchObject({ nickname: "真名", unique_id: "realid", followers: 12 });
    const row = store.db.prepare("SELECT real_nickname FROM entrants WHERE uid='u1'").get() as {
      real_nickname: string;
    };
    expect(row.real_nickname).toBe("真名");
  });
});

describe("監控目標", () => {
  it("新增／更新 enabled／列出／刪除", () => {
    store.ensureTarget("111", "標籤", "主播");
    expect(store.getTarget("111")).toMatchObject({ label: "標籤", enabled: 1 });
    store.updateTarget("111", { enabled: 0 });
    expect(store.getTarget("111")?.enabled).toBe(0);
    expect(store.listTargets()).toHaveLength(1);
    store.deleteTarget("111");
    expect(store.listTargets()).toHaveLength(0);
  });
});
