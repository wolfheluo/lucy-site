// =====================================================================
//  dy-enter 路由（掛 /api/tools/dy-enter，一律 requireAuth）
//    POST /session                     { url } → 建立/續接場次並切換
//    POST /session/:sid/select         切到既有場次
//    GET  /state                       當前場次摘要 + 最近進場
//    GET  /entrants?session_id&mark&limit&offset
//    GET  /entrants/:uid/entries?session_id
//    GET  /sessions                    場次下拉
//    GET  /health
// =====================================================================
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";
import type { ServerToolContext, ServerToolHandle } from "../../types.js";
import { requireAuth } from "../../../server/auth.js";
import { DyClient } from "../../dy-monitor/server/dycore.js";
import { parseRid } from "../../dy-monitor/server/engine.js";
import { DyEnterStore, type EnterMark } from "./store.js";
import { EnterEngine } from "./engine.js";

const MARKS: (EnterMark | "hidden")[] = ["mystery", "suspect_hidden", "hidden"];

export function registerDyEnter(app: Hono, ctx: ServerToolContext): ServerToolHandle {
  const log = (m: string) => console.log(m);
  const store = new DyEnterStore(path.join(ctx.dataDir, "dy-enter.db"), { log });
  const cookieFile = process.env.DY_COOKIE_FILE || path.join(os.homedir(), "dy_cookies.json");
  const client = new DyClient({ cookieFile });
  const engine = new EnterEngine({ store, client, log });

  const disabled = process.env.NODE_ENV === "test" || process.env.DY_ENTER_DISABLE === "1";
  if (!disabled) engine.start();

  const api = new Hono();

  api.post("/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; web_rid?: string };
    const rid = parseRid(body.url || body.web_rid || "");
    if (!rid) return c.json({ ok: false, error: "網址裡找不到直播間號" }, 400);
    const res = await engine.selectRoom(rid);
    if (!res.ok) return c.json({ ok: false, error: res.error }, 404);
    return c.json({ ok: true, session: res.session, live: engine.live });
  });

  api.post("/session/:sid/select", (c) => {
    const sid = Number(c.req.param("sid"));
    if (!engine.selectSession(sid)) return c.json({ ok: false, error: "場次不存在" }, 404);
    return c.json({ ok: true, session: store.session(sid) });
  });

  api.post("/session/:sid/stop", (c) => {
    const sid = Number(c.req.param("sid"));
    if (engine.currentSessionId !== sid) return c.json({ ok: false, error: "不是當前場次" }, 409);
    const res = engine.stopRecording();
    return c.json({ ok: true, session_id: res.session_id, session: store.session(sid) });
  });

  api.post("/session/:sid/resume", async (c) => {
    const sid = Number(c.req.param("sid"));
    const res = await engine.resumeRecording(sid);
    if (!res.ok) return c.json({ ok: false, error: res.error }, 404);
    return c.json({ ok: true, session: res.session, live: engine.live });
  });

  api.get("/state", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 200);
    return c.json({ ok: true, ...engine.state(limit) });
  });

  api.get("/entrants", (c) => {
    const sid = Number(c.req.query("session_id") ?? engine.currentSessionId ?? 0);
    if (!sid) return c.json({ ok: false, error: "no_session" });
    const markRaw = String(c.req.query("mark") ?? "");
    const mark = MARKS.includes(markRaw as EnterMark | "hidden")
      ? (markRaw as EnterMark | "hidden")
      : undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 500) || 500, 2000);
    const offset = Number(c.req.query("offset") ?? 0) || 0;
    return c.json({
      ok: true,
      session_id: sid,
      stats: store.stats(sid),
      entrants: store.entrants(sid, { mark, limit, offset }),
    });
  });

  api.get("/entrants/:uid/entries", (c) => {
    const sid = Number(c.req.query("session_id") ?? engine.currentSessionId ?? 0);
    if (!sid) return c.json({ ok: false, error: "no_session" });
    const uid = c.req.param("uid");
    return c.json({ ok: true, session_id: sid, uid, entries: store.entries(sid, uid) });
  });

  api.get("/entrants/:uid/messages", (c) => {
    const sid = Number(c.req.query("session_id") ?? engine.currentSessionId ?? 0);
    if (!sid) return c.json({ ok: false, error: "no_session" });
    const uid = c.req.param("uid");
    return c.json({ ok: true, session_id: sid, uid, messages: store.messages(sid, uid) });
  });

  api.get("/sessions", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    return c.json({
      ok: true,
      current: engine.currentSessionId,
      sessions: store.sessions(limit),
    });
  });

  api.get("/health", (c) =>
    c.json({
      ok: true,
      running: !disabled,
      live: engine.live,
      chat_ok: engine.chatOk,
      cookie: Boolean(process.env.DY_COOKIE_FILE || true),
      session_id: engine.currentSessionId,
      web_rid: engine.snapshot?.web_rid ?? null,
      last_error: engine.lastError || null,
      masked_dropped: engine.maskedDropped,
      paused: engine.paused,
    })
  );

  // 所有端點都需要管理 session（登入牆）
  const guarded = new Hono();
  guarded.use("*", requireAuth(ctx.sessionSecret));
  guarded.route("/", api);
  app.route("/api/tools/dy-enter", guarded);

  return {
    settle: () => {
      engine.stop();
      store.close();
    },
  };
}
