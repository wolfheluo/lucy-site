// =====================================================================
//  lucy-site server 入口
//  - createApp(config)：建立 Hono app（測試可直接 app.request()）
//  - 直接執行時 listen（tsx server/index.ts / node dist-server/server/index.js）
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

import { loadConfig, type ServerConfig } from "./config.js";
import { openDb } from "./db.js";
import {
  checkPassword,
  clearSession,
  isAuthed,
  issueSession,
} from "./auth.js";
import { makeRateLimiter } from "./rate-limit.js";
import { mountTools } from "./registry.js";

/**
 * 解析 client IP：
 *  - node server 只 listen 127.0.0.1（nginx 反代），故 X-Forwarded-For 可信
 *  - 測試環境（純 app.request）無 conninfo → fallback "unknown"
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function createApp(cfg: ServerConfig = loadConfig()): Hono {
  const db = openDb(cfg.dataDir);
  const app = new Hono();

  const loginLimiter = makeRateLimiter(db, {
    max: cfg.loginRateMax,
    windowMs: cfg.loginRateWindowMs,
  });

  const toolCtx = {
    db,
    dataDir: cfg.dataDir,
    adminPassword: cfg.adminPassword,
    sessionSecret: cfg.sessionSecret,
  };

  // ── health ─────────────────────────────────────────────────────────
  app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

  // ── admin auth ─────────────────────────────────────────────────────
  app.post("/api/auth/login", async (c) => {
    const ip = clientIp(c);
    const key = `login:${ip}`;
    const status = loginLimiter.hit(key);
    if (!status.allowed) {
      return c.json(
        { ok: false, error: "嘗試次數過多，請稍後再試", retryAfterSec: status.retryAfterSec },
        429
      );
    }
    const body = await c.req.json().catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!checkPassword(cfg.adminPassword, password)) {
      return c.json(
        { ok: false, error: "密碼錯誤", remaining: status.remaining },
        401
      );
    }
    issueSession(c, cfg.sessionSecret);
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", (c) => {
    if (isAuthed(c, cfg.sessionSecret)) return c.json({ ok: true, authed: true });
    return c.json({ ok: true, authed: false });
  });

  // ── tools ──────────────────────────────────────────────────────────
  mountTools(app, toolCtx);

  // ── production：靜態 dist + SPA fallback ─────────────────────────
  if (cfg.distDir && fs.existsSync(cfg.distDir)) {
    app.use("*", serveStatic({ root: cfg.distDir }));

    // SPA fallback：非 /api 的 GET 且非既有檔案 → index.html
    app.get("*", (c) => {
      const url = new URL(c.req.url);
      if (url.pathname.startsWith("/api/")) {
        return c.json({ ok: false, error: "Not Found" }, 404);
      }
      const indexHtml = path.join(cfg.distDir!, "index.html");
      if (!fs.existsSync(indexHtml)) return c.json({ ok: false, error: "Not Found" }, 404);
      return c.html(fs.readFileSync(indexHtml, "utf8"));
    });
  }

  return app;
}

// 直接執行才 listen：
//  - node dist-server/server/index.js（argv[1] 是自身）
//  - pm2/systemd 等管理器（argv[1] 是包裝檔）→ 用 START_SERVER=1 env
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun || process.env.START_SERVER === "1") {
  const cfg = loadConfig();
  const app = createApp(cfg);
  serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    console.log(`[lucy-server] listening on http://0.0.0.0:${info.port} (data: ${cfg.dataDir})`);
  });
}
