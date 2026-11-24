// =====================================================================
//  DOUYIN 路由（/api/tools/douyin，全部 requireAuth）
//  - cookie 狀態／熱更新：GET/PUT/POST/DELETE /cookie
//  - 監控：/state、/targets、/sessions
//  - 名單：/entrants、CSV、/profile
// =====================================================================
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { ServerToolContext, ServerToolHandle } from "../../types.js";
import { requireAuth } from "../../../server/auth.js";
import { makeRateLimiter } from "../../../server/rate-limit.js";
import { clientIp } from "../../../server/request-ip.js";
import { DyStore } from "./store.js";
import { CookieManager } from "./cookie.js";
import { DyClient } from "./dycore.js";
import { abogusSigner } from "./abogus.js";
import { ProfileResolver } from "./profile.js";
import { DyEngine, MAX_TARGETS, parseRid } from "./engine.js";
import { pushLine } from "./line.js";
import type { EntrantMarkLike } from "../types.js";

const MAX_COOKIE_BODY = 256 * 1024;

function boolOf(v: unknown, fallback = 1): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v ? 1 : 0;
  return ["1", "true", "on", "yes", "y"].includes(String(v).toLowerCase()) ? 1 : 0;
}

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerDouyin(app: Hono, ctx: ServerToolContext): ServerToolHandle {
  const log = (m: string) => console.log(m);
  const store = new DyStore(path.join(ctx.dataDir, "dy.db"), { log });

  const cookieFile = process.env.DY_COOKIE_FILE || path.join(os.homedir(), "dy_cookies.json");
  const cookieMgr = new CookieManager({ file: cookieFile, log });
  cookieMgr.load();

  const client = new DyClient({ cookieHeader: cookieMgr.getHeader(), signer: abogusSigner });
  const resolver = new ProfileResolver(client, log);

  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  const lineTo = process.env.LINE_TO || "";
  const maxTargets = Math.min(intEnv(process.env.DOUYIN_MAX_TARGETS, MAX_TARGETS), 5);

  const engine = new DyEngine({
    store,
    client,
    resolver,
    notifier: async (_kind, _rid, text) => pushLine({ token: lineToken, to: lineTo }, text),
    dashboardUrl: process.env.DY_DASHBOARD_URL || "",
    log,
    maxTargets,
    instanceId: process.env.NODE_APP_INSTANCE ?? null,
  });

  const disabled =
    process.env.NODE_ENV === "test" || process.env.DOUYIN_DISABLE === "1";

  let cookieTimer: NodeJS.Timeout | null = null;
  if (!disabled) {
    engine.start();
    const check = () => {
      void cookieMgr
        .check()
        .then((st) => {
          if (st.valid) client.setCookieHeader(cookieMgr.getHeader());
        })
        .catch(() => {});
    };
    check();
    cookieTimer = setInterval(check, 30 * 60 * 1000);
    cookieTimer.unref();
  }

  const cookieLimiter = makeRateLimiter(ctx.db, { max: 5, windowMs: 15 * 60 * 1000 });

  const api = new Hono();

  // ---------- 即時狀態 ----------
  api.get("/state", (c) => {
    const since = Number(c.req.query("since") ?? 0) || 0;
    return c.json({ ok: true, ...engine.state(since) });
  });

  // ---------- 監控清單 ----------
  api.get("/targets", (c) =>
    c.json({
      ok: true,
      selected: engine.selectedRid,
      max_targets: maxTargets,
      targets: engine.targetsWithState(),
    })
  );

  api.post("/targets", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; label?: string };
    const rid = parseRid(body.url || "");
    if (!rid) return c.json({ ok: false, error: "網址裡找不到直播間號" }, 400);
    const existing = store.getTarget(rid);
    if (!existing && store.listTargets().length >= maxTargets) {
      return c.json({ ok: false, error: `監控清單上限 ${maxTargets} 間，請先移除其他房間` }, 429);
    }
    let snap = null;
    try {
      snap = await client.roomSnapshot(rid, { timeoutMs: 15_000, retries: 1 });
    } catch {
      snap = null;
    }
    if (!snap) {
      log(`[dy] 房間驗證失敗 rid=${rid}`);
      return c.json({ ok: false, error: "抓不到這個直播間（號碼錯或房間不存在）" }, 404);
    }

    store.ensureTarget(rid, (body.label ?? "").trim(), snap.anchor_name || "");
    store.updateTarget(rid, {
      notify_live: 1,
      notify_end: 1,
      enabled: 1,
      last_status: snap.status,
    });
    if (!engine.selectedRid) engine.select(rid);
    return c.json({
      ok: true,
      target: store.getTarget(rid),
      anchor_name: snap.anchor_name,
      status_text: snap.status_text,
    });
  });

  api.patch("/targets/:rid", async (c) => {
    const rid = c.req.param("rid");
    if (!store.getTarget(rid)) return c.json({ ok: false, error: "不在監控清單" }, 404);
    const data = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const k of ["notify_live", "notify_end", "enabled"]) {
      if (k in data) fields[k] = boolOf(data[k]);
    }
    if ("label" in data) fields.label = String(data.label ?? "").trim();
    store.updateTarget(rid, fields);
    return c.json({ ok: true, target: store.getTarget(rid) });
  });

  api.delete("/targets/:rid", (c) => {
    const rid = c.req.param("rid");
    if (rid === engine.selectedRid) {
      return c.json({ ok: false, error: "這是目前選中的房間，請先切換到別的房間" }, 400);
    }
    store.deleteTarget(rid);
    return c.json({ ok: true });
  });

  api.post("/targets/:rid/select", (c) => {
    const rid = c.req.param("rid");
    if (!engine.select(rid)) return c.json({ ok: false, error: "切換失敗" }, 400);
    store.ensureTarget(rid, "", engine.snapshot?.anchor_name ?? "");
    return c.json({ ok: true, web_rid: engine.selectedRid });
  });

  // ---------- Cookie ----------
  api.get("/cookie", (c) => c.json({ ok: true, status: cookieMgr.statusOf() }));

  api.put("/cookie", async (c) => {
    const lim = cookieLimiter.hit(`cookie:${clientIp(c, ctx.trustProxy)}`);
    if (!lim.allowed) {
      c.header("Retry-After", String(lim.retryAfterSec));
      return c.json({ ok: false, error: "更新太頻繁，請稍後再試" }, 429);
    }
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_COOKIE_BODY) return c.json({ ok: false, error: "cookie 內容過大" }, 413);
    const text = await c.req.text();
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    let raw = text;
    if (ct.includes("application/json")) {
      try {
        const j = JSON.parse(text) as unknown;
        if (Array.isArray(j)) raw = text;
        else if (j && typeof j === "object" && "cookie" in j) {
          const v = (j as { cookie: unknown }).cookie;
          raw = typeof v === "string" ? v : JSON.stringify(v);
        }
      } catch {
        return c.json({ ok: false, error: "JSON 格式錯誤" }, 400);
      }
    }
    try {
      const status = await cookieMgr.update(raw);
      if (status.valid) {
        client.setCookieHeader(cookieMgr.getHeader());
        return c.json({ ok: true, status });
      }
      return c.json({ ok: false, error: status.last_error ?? "登入驗證失敗", status }, 400);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  api.post("/cookie/verify", async (c) => {
    const status = await cookieMgr.check();
    if (status.valid) client.setCookieHeader(cookieMgr.getHeader());
    return c.json({ ok: status.valid === true, status });
  });

  api.delete("/cookie", (c) => {
    const status = cookieMgr.clear();
    client.setCookieHeader("");
    return c.json({ ok: true, status });
  });

  // ---------- 名單 ----------
  api.get("/entrants", (c) => {
    const st = engine.state(0) as { db?: { session_id?: number | null } };
    const sid = Number(c.req.query("session_id") ?? st.db?.session_id ?? 0);
    if (!sid) return c.json({ ok: true, session_id: null, stats: null, entrants: [] });
    const markRaw = String(c.req.query("mark") ?? "");
    const allowed: EntrantMarkLike[] = ["", "mystery", "suspect_hidden", "hidden"];
    const mark = allowed.includes(markRaw as EntrantMarkLike) ? (markRaw as EntrantMarkLike) : undefined;
    const q = String(c.req.query("q") ?? "");
    const limit = Math.min(Number(c.req.query("limit") ?? 500) || 500, 2000);
    const offset = Number(c.req.query("offset") ?? 0) || 0;
    return c.json({
      ok: true,
      session_id: sid,
      stats: store.stats(sid),
      entrants: store.entrants(sid, { mark, q, limit, offset }),
    });
  });

  api.get("/entrants/export.csv", (c) => {
    const st = engine.state(0) as { db?: { session_id?: number | null } };
    const sid = Number(c.req.query("session_id") ?? st.db?.session_id ?? 0);
    if (!sid) return c.text("no_session", 404);
    const rows = store.entrants(sid, { limit: 2000 });
    const header = [
      "uid",
      "nickname",
      "display_id",
      "real_nickname",
      "mark",
      "anonymous",
      "visits",
      "chat_count",
      "diamonds",
      "first_ts",
      "last_ts",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.uid,
          r.nickname,
          r.display_id,
          r.real_nickname,
          r.mark,
          r.anonymous,
          r.visits,
          r.chat_count,
          r.diamonds,
          new Date(r.first_ts * 1000).toISOString(),
          new Date(r.last_ts * 1000).toISOString(),
        ]
          .map(csvCell)
          .join(",")
      );
    }
    const csv = "\uFEFF" + lines.join("\r\n");
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="douyin-entrants-${sid}.csv"`);
    return c.body(csv);
  });

  api.get("/entrants/:uid/events", (c) => {
    const st = engine.state(0) as { db?: { session_id?: number | null } };
    const sid = Number(c.req.query("session_id") ?? st.db?.session_id ?? 0);
    if (!sid) return c.json({ ok: false, error: "no_session" }, 400);
    const uid = c.req.param("uid");
    const type = c.req.query("type") || undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
    const offset = Number(c.req.query("offset") ?? 0) || 0;
    return c.json({ ok: true, session_id: sid, uid, events: store.entrantEvents(sid, uid, { type, limit, offset }) });
  });

  api.delete("/entrants/:uid", (c) => {
    const st = engine.state(0) as { db?: { session_id?: number | null } };
    const sid = Number(c.req.query("session_id") ?? st.db?.session_id ?? 0);
    if (!sid) return c.json({ ok: false, error: "缺少 session_id" }, 400);
    const uid = c.req.param("uid");
    const del = store.deleteEntrant(sid, uid);
    if (!del.removed) return c.json({ ok: false, error: "查無此人（可能已刪除）" }, 404);
    store.refreshSummary(sid);
    return c.json({ ok: true, deleted: del });
  });

  // ---------- 反查（只回 mystery 的實際使用在引擎；這支是手動查） ----------
  api.get("/profile/:idOrHandle", async (c) => {
    const raw = c.req.param("idOrHandle").trim();
    if (!raw) return c.json({ ok: false, error: "缺少 uid／抖音號" }, 400);
    let hit;
    try {
      hit = await resolver.resolve(raw);
    } catch (err) {
      return c.json({ ok: false, error: `反查暫時失敗：${(err as Error).message}` }, 502);
    }
    if (!hit) return c.json({ ok: false, error: `查不到抖音ID「${raw}」（不存在、已改號或被風控）` }, 404);
    store.upsertProfile(hit);
    const st = engine.state(0) as { db?: { session_id?: number | null } };
    const sid = Number(c.req.query("session_id") ?? st.db?.session_id ?? 0);
    let matched: string | null = null;
    if (sid) {
      const row = store.getEntrant(sid, hit.uid) ?? store.getEntrant(sid, raw);
      matched = row?.nickname ?? null;
      try {
        store.setReal(sid, hit.uid, hit);
      } catch {
        /* 不在場次就忽略 */
      }
    }
    return c.json({ ok: true, session_id: sid || null, matched_nickname: matched, profile: hit });
  });

  // ---------- 場次 ----------
  api.get("/sessions", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const offset = Number(c.req.query("offset") ?? 0) || 0;
    const rid = c.req.query("web_rid") ?? "";
    return c.json({
      ok: true,
      current: (engine.state(0) as { db?: { session_id?: number | null } }).db?.session_id ?? null,
      total: store.countSessions(rid),
      sessions: store.listSessions(limit, offset, rid),
    });
  });

  api.post("/sessions/:sid/stop", (c) => {
    const sid = Number(c.req.param("sid"));
    const row = store.getSession(sid);
    if (!row) return c.json({ ok: false, error: "場次不存在" }, 404);
    if ((engine.state(0) as { db?: { session_id?: number | null } }).db?.session_id !== sid) {
      return c.json({ ok: false, error: "不是當前場次" }, 409);
    }
    store.updateTarget(row.web_rid, { enabled: 0 });
    return c.json({ ok: true, session: store.getSession(sid) });
  });

  api.post("/sessions/:sid/resume", (c) => {
    const sid = Number(c.req.param("sid"));
    const row = store.getSession(sid);
    if (!row) return c.json({ ok: false, error: "場次不存在" }, 404);
    store.updateTarget(row.web_rid, { enabled: 1 });
    if (row.ended_at !== null) {
      engine.select(row.web_rid);
    }
    return c.json({ ok: true, session: store.getSession(sid) });
  });

  api.delete("/sessions/:sid", (c) => {
    const sid = Number(c.req.param("sid"));
    const row = store.getSession(sid);
    if (!row) return c.json({ ok: false, error: "場次不存在" }, 404);
    const current = (engine.state(0) as { db?: { session_id?: number | null } }).db?.session_id === sid;
    const target = store.getTarget(row.web_rid);
    if (current && target?.enabled) {
      return c.json({ ok: false, error: "場次正在記錄中，請先停止再刪除" }, 409);
    }
    const del = store.deleteSession(sid);
    store.walCheckpoint();
    return c.json({ ok: true, deleted: del });
  });

  // ---------- 通知 ----------
  api.get("/notifications", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
    return c.json({ ok: true, notifications: store.listNotifications(limit) });
  });

  api.post("/notify/test", async (c) => {
    const res = await engine.testPush();
    return c.json({ ok: res.ok, error: res.error });
  });

  // ---------- health ----------
  api.get("/health", (c) => {
    const st = engine.state(0) as {
      api?: { rank_ok?: boolean; chat_ok?: boolean; abogus?: boolean };
      selected_web_rid?: string;
      db?: { size_mb?: number };
    };
    const last = store.db.prepare("SELECT MAX(ts) AS ts FROM events").get() as { ts: number | null };
    return c.json({
      ok: true,
      running: engine.running,
      selected: st.selected_web_rid ?? "",
      cookie: cookieMgr.statusOf(),
      chat_ok: st.api?.chat_ok ?? false,
      rank_ok: st.api?.rank_ok ?? false,
      abogus: st.api?.abogus ?? false,
      line: Boolean(lineToken && lineTo),
      db_size_mb: st.db?.size_mb ?? 0,
      events_age_sec: last.ts ? Math.round(Date.now() / 1000 - last.ts) : null,
      targets: store.listTargets().length,
      max_targets: maxTargets,
    });
  });

  const guarded = new Hono();
  guarded.use("*", requireAuth(ctx.sessionSecret));
  guarded.route("/", api);
  app.route("/api/tools/douyin", guarded);

  return {
    settle: () => {
      if (cookieTimer) clearInterval(cookieTimer);
      engine.stop();
      store.stop();
    },
  };
}
