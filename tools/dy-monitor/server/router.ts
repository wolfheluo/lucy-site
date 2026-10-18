// =====================================================================
//  DOUYIN MONITOR 後端路由（全部掛在 /api/tools/dy-monitor，一律 requireAuth）
//    GET    /state?since=         選中房即時狀態（快照/曲線/彈幕/榜單/送禮榜）
//    GET    /targets             監控清單 + 狀態
//    POST   /targets             新增房間（會先驗證房間存在）
//    PATCH  /targets/:rid        通知與收錄旗標（v4 五項）
//    DELETE /targets/:rid        移除（選中房不可刪）
//    POST   /targets/:rid/select 切換主畫面
//    GET    /replay/:rid         離線回放（最後一場有資料的場次）
//    GET    /notifications       最近通知紀錄
//    POST   /notify/test         測試推播
//    GET    /health              引擎/資料/憑證狀態
// =====================================================================
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";
import type { ServerToolContext } from "../../types.js";
import { requireAuth } from "../../../server/auth.js";
import { DyMonitorStore } from "./store.js";
import { DyClient } from "./dycore.js";
import { DyEngine, MAX_TARGETS, parseRid } from "./engine.js";
import { pushLine } from "./line.js";
import { stubSigner } from "./signer.js";

/** 表單/JSON 的寬鬆布林（"1"/"true"/"on" → 1） */
function boolOf(v: unknown, fallback = 1): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v ? 1 : 0;
  return ["1", "true", "on", "yes", "y"].includes(String(v).toLowerCase()) ? 1 : 0;
}

const CAPS = ["cap_chat", "cap_gift", "cap_member", "cap_snap", "cap_rank"] as const;

export function registerDyMonitor(app: Hono, ctx: ServerToolContext) {
  const log = (m: string) => console.log(m);
  const store = new DyMonitorStore(path.join(ctx.dataDir, "dy-monitor.db"), { log });

  const cookieFile =
    process.env.DY_COOKIE_FILE || path.join(os.homedir(), "dy_cookies.json");
  const client = new DyClient({ cookieFile });
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  const lineTo = process.env.LINE_TO || "";

  const engine = new DyEngine({
    store,
    client,
    dashboardUrl: process.env.DY_DASHBOARD_URL || "",
    log,
    instanceId: process.env.NODE_APP_INSTANCE ?? null,
    abogusReady: stubSigner.ready,
    notifier: async (_kind, _rid, text) =>
      pushLine({ token: lineToken, to: lineTo }, text),
  });

  // 測試不連外網、不啟引擎（與 binance-api 同慣例）
  const disableEngine =
    process.env.NODE_ENV === "test" || process.env.DY_MONITOR_DISABLE === "1";
  if (!disableEngine) engine.start();

  const api = new Hono();

  api.get("/state", (c) => {
    const since = Number(c.req.query("since") ?? 0) || 0;
    return c.json({ ok: true, ...engine.state(since) });
  });

  api.get("/targets", (c) => {
    const targets = engine.targetsWithState().map((t) => ({
      ...t,
      caps_total: CAPS.length,
    }));
    return c.json({ ok: true, selected: engine.selectedRid, targets });
  });

  api.post("/targets", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string;
      web_rid?: string;
      label?: string;
      cap_rank?: unknown;
    };
    const rid = parseRid(body.url || body.web_rid || "");
    if (!rid) return c.json({ ok: false, error: "網址裡找不到直播間號" }, 400);

    const existing = store.getTarget(rid);
    if (!existing && store.listTargets().length >= MAX_TARGETS) {
      return c.json(
        { ok: false, error: `監控清單上限 ${MAX_TARGETS} 間，請先移除其他房間` },
        429
      );
    }

    let snap = null;
    try {
      snap = await client.roomSnapshot(rid, { timeoutMs: 15_000, retries: 1 });
    } catch {
      snap = null;
    }
    if (!snap) {
      return c.json({ ok: false, error: "抓不到這個直播間（號碼錯或房間不存在）" }, 404);
    }

    store.ensureTarget(rid, (body.label ?? "").trim(), snap.anchor_name || "");
    store.updateTarget(rid, {
      notify_live: 1,
      notify_end: 1,
      capture: 1,
      cap_chat: 1,
      cap_gift: 1,
      cap_member: 1,
      cap_snap: 1,
      cap_rank: boolOf(body.cap_rank, 0),
      last_status: snap.status,
    });
    return c.json({
      ok: true,
      target: store.getTarget(rid),
      anchor_name: snap.anchor_name,
      status_text: snap.status_text,
    });
  });

  api.patch("/targets/:rid", async (c) => {
    const rid = c.req.param("rid");
    const cur = store.getTarget(rid);
    if (!cur) return c.json({ ok: false, error: "不在監控清單" }, 404);
    const data = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const k of ["notify_live", "notify_end", "capture"]) {
      if (k in data) fields[k] = boolOf(data[k]);
    }

    const caps: Record<string, number> = {};
    for (const k of CAPS) caps[k] = Number(cur[k] ?? 1) ? 1 : 0;
    let changed = false;
    for (const k of CAPS) {
      if (k in data) {
        caps[k] = boolOf(data[k]);
        changed = true;
      }
    }
    if ("capture" in data && !changed) {
      // 舊介面只丟 capture：關閉＝五項全關、開啟＝若原本全關則全開
      if (!fields.capture) {
        for (const k of CAPS) caps[k] = 0;
        changed = true;
      } else if (!CAPS.some((k) => caps[k])) {
        for (const k of CAPS) caps[k] = 1;
        changed = true;
      }
    }
    if (changed) {
      Object.assign(fields, caps);
      fields.capture = CAPS.some((k) => caps[k]) ? 1 : 0;
    }
    if ("label" in data) fields.label = String(data.label ?? "").trim();
    store.updateTarget(rid, fields);
    return c.json({ ok: true, target: store.getTarget(rid) });
  });

  api.delete("/targets/:rid", (c) => {
    const rid = c.req.param("rid");
    if (rid === engine.selectedRid) {
      return c.json(
        { ok: false, error: "這是目前選中的房間，請先切換到別的房間" },
        400
      );
    }
    store.deleteTarget(rid);
    return c.json({ ok: true });
  });

  api.post("/targets/:rid/select", (c) => {
    const rid = c.req.param("rid");
    const ok = engine.select(rid);
    if (!ok) return c.json({ ok: false, error: "切換失敗" }, 400);
    store.ensureTarget(rid, "", engine.snapshot?.anchor_name ?? "");
    return c.json({ ok: true, web_rid: engine.selectedRid });
  });

  api.get("/replay/:rid", (c) => {
    const rid = c.req.param("rid");
    const db = store.db;
    let session = db
      .prepare(
        `SELECT * FROM sessions WHERE web_rid=?
           AND ((gift_events>0) OR (chat_count>0) OR (member_count>0))
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(rid) as Record<string, unknown> | undefined;
    if (!session) {
      session = db
        .prepare("SELECT * FROM sessions WHERE web_rid=? ORDER BY started_at DESC LIMIT 1")
        .get(rid) as Record<string, unknown> | undefined;
    }
    if (!session) return c.json({ ok: false, error: "no_session", web_rid: rid });

    const sid = session.id as number;
    const series = db
      .prepare(
        "SELECT ts, viewers, like_count FROM snapshots WHERE session_id=? ORDER BY ts"
      )
      .all(sid) as { ts: number; viewers: number; like_count: number }[];

    const lastTs = (
      db.prepare("SELECT MAX(ts) AS ts FROM rank_snapshots WHERE session_id=?").get(sid) as {
        ts: number | null;
      }
    ).ts;
    const rank: unknown[] = [];
    if (lastTs) {
      const rows = db
        .prepare("SELECT payload FROM rank_snapshots WHERE session_id=? AND ts=?")
        .all(sid, lastTs) as { payload: string }[];
      for (const r of rows) {
        try {
          rank.push(JSON.parse(r.payload));
        } catch {
          // 壞掉的 payload 略過
        }
      }
      rank.sort((a, b) => Number((a as { rank?: number }).rank ?? 0) - Number((b as { rank?: number }).rank ?? 0));
    }

    const fansRow = db
      .prepare("SELECT * FROM fans_snapshots WHERE session_id=? ORDER BY id DESC LIMIT 1")
      .get(sid) as Record<string, unknown> | undefined;
    let fans: Record<string, unknown> | null = null;
    if (fansRow) {
      let members: unknown[] = [];
      try {
        members = JSON.parse(String(fansRow.members ?? "[]")) as unknown[];
      } catch {
        members = [];
      }
      fans = {
        members,
        club_name: fansRow.club_name,
        fans_name: fansRow.fans_name,
        active: fansRow.active,
        total: fansRow.total,
        today_new: fansRow.today_new,
        guard: fansRow.guard,
        ts: fansRow.ts,
      };
    }

    const chat = (
      db
        .prepare(
          `SELECT ts,type,nickname,content,gift_name,diamonds,repeat
           FROM events WHERE session_id=? ORDER BY id DESC LIMIT 120`
        )
        .all(sid) as Record<string, unknown>[]
    ).reverse();

    const top = db
      .prepare(
        `SELECT nickname, SUM(diamonds) AS d, SUM(COALESCE(repeat,1)) AS c
         FROM events WHERE session_id=? AND type='Gift' AND diamonds>0
         GROUP BY nickname ORDER BY d DESC LIMIT 10`
      )
      .all(sid) as { nickname: string | null; d: number | null; c: number | null }[];

    const totalDiamonds = (
      db
        .prepare("SELECT COALESCE(SUM(diamonds),0) AS v FROM events WHERE session_id=? AND type='Gift'")
        .get(sid) as { v: number }
    ).v;

    return c.json({
      ok: true,
      replay: true,
      web_rid: rid,
      session,
      series: series.map((r) => ({ ts: r.ts, viewers: r.viewers, likes: r.like_count })),
      chat,
      rank,
      fans,
      gifts: {
        total_diamonds: totalDiamonds,
        events: Number(session.gift_events ?? 0),
        top: top.map((r) => ({
          nickname: r.nickname || "匿名",
          diamonds: r.d ?? 0,
          count: r.c ?? 0,
        })),
      },
    });
  });

  api.get("/notifications", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
    return c.json({ ok: true, notifications: store.listNotifications(limit) });
  });

  api.post("/notify/test", async (c) => {
    const res = await engine.testPush();
    return c.json({ ok: res.ok, error: res.error });
  });

  api.get("/health", (c) => {
    const state = engine.state(0) as {
      room?: { ts?: number };
      api: { rank_ok: boolean; chat_ok: boolean };
    };
    const snapTs = state.room?.ts;
    return c.json({
      ok: true,
      running: engine.running,
      web_rid: engine.selectedRid,
      stats_age: snapTs ? Math.round((Date.now() / 1000 - snapTs) * 10) / 10 : null,
      rank_ok: state.api.rank_ok,
      chat_ok: state.api.chat_ok,
      abogus: stubSigner.ready,
      cookie: Boolean(client.cookie),
      line: Boolean(lineToken && lineTo),
      db_size_mb: Math.round((store.sizeBytes() / 1048576) * 10) / 10,
      targets: store.listTargets().length,
      max_targets: MAX_TARGETS,
    });
  });

  // 所有端點都需要管理 session（登入牆）
  const guarded = new Hono();
  guarded.use("*", requireAuth(ctx.sessionSecret));
  guarded.route("/", api);
  app.route("/api/tools/dy-monitor", guarded);

  return {
    settle: () => {
      engine.stop();
      store.stop();
    },
  };
}
