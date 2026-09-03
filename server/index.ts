// =====================================================================
//  lucy-site server 入口
//  - createApp(config)：建立 Hono app（測試可直接 app.request()）
//  - 直接執行時 listen（tsx server/index.ts / node dist-server/server/index.js）
//  - LucyApp = Hono + db：測試可於 afterAll 關閉 SQLite（M1）
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { loadConfig, type ServerConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import { clientIp } from "./request-ip.js";
import {
  checkPassword,
  clearSession,
  isAuthed,
  issueSession,
} from "./auth.js";
import { makeRateLimiter } from "./rate-limit.js";
import { mountTools } from "./registry.js";

/** Hono app + 共享 SQLite 實例（M1：測試結束可 db.close()） */
export interface LucyApp extends Hono {
  db: Db;
}

/** 公開端 body 上限（H4：login / pin 皆為小型表單，超限直接 413） */
const MAX_FORM_BODY = 64 * 1024;

export function createApp(cfg: ServerConfig = loadConfig()): LucyApp {
  const db = openDb(cfg.dataDir);
  const app = new Hono() as LucyApp;
  app.db = db;

  const loginLimiter = makeRateLimiter(db, {
    max: cfg.loginRateMax,
    windowMs: cfg.loginRateWindowMs,
  });

  const toolCtx = {
    db,
    dataDir: cfg.dataDir,
    adminPassword: cfg.adminPassword,
    sessionSecret: cfg.sessionSecret,
    trustProxy: cfg.trustProxy,
  };

  // ── health ─────────────────────────────────────────────────────────
  app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

  // ── admin auth ─────────────────────────────────────────────────────
  app.post("/api/auth/login", async (c) => {
    const ip = clientIp(c, cfg.trustProxy);
    const key = `login:${ip}`;
    const status = loginLimiter.hit(key);
    if (!status.allowed) {
      // L8：標準 Retry-After header
      c.header("Retry-After", String(status.retryAfterSec));
      return c.json(
        { ok: false, error: "嘗試次數過多，請稍後再試", retryAfterSec: status.retryAfterSec },
        429
      );
    }
    // H4：避免超大 body 被 c.req.json() 整包讀入記憶體
    const contentLen = Number(c.req.header("content-length") ?? 0);
    if (contentLen > MAX_FORM_BODY) {
      return c.json({ ok: false, error: "請求內容過大" }, 413);
    }
    const body = await c.req.json().catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!checkPassword(cfg.adminPassword, password)) {
      return c.json(
        { ok: false, error: "密碼錯誤", remaining: status.remaining },
        401
      );
    }
    issueSession(c, cfg.sessionSecret, cfg.cookieSecure);
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

  // 未匹配任何路由 → 統一 JSON 404（L11）
  app.notFound((c) => c.json({ ok: false, error: "Not Found" }, 404));

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
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bindHost }, (info) => {
    console.log(
      `[lucy-server] listening on http://${cfg.bindHost}:${info.port} (data: ${cfg.dataDir}, trustProxy: ${cfg.trustProxy})`
    );
  });
}
