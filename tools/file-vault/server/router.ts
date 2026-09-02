// =====================================================================
//  FILE VAULT 後端路由
//    /api/tools/file-vault/*  管理 API（requireAuth）
//      POST   /upload          多檔上傳（multipart, busboy 串流）
//      GET    /files           列出全部
//      GET    /download/:id    下載（管理端）
//      DELETE /delete/:id      刪除
//      POST   /share/:id       建立分享（share_id + pin）
//      DELETE /share/:id       撤銷分享
//    /s/*                      公開分享
//      GET    /:shareId        分享頁（精簡 HTML）
//      POST   /:shareId        pin 驗證 → 成功即串流下載（rate-limit 10/15min）
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import busboy from "busboy";
import { Hono } from "hono";
import type { ServerToolContext } from "../../types.js";
import { requireAuth } from "../../../server/auth.js";
import { makeRateLimiter } from "../../../server/rate-limit.js";
import { Vault } from "./vault.js";
import { fmtSize, sharePageHtml } from "./share-page.js";
import type { UploadResultItem } from "../types.js";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB（與 nginx client_max_body_size 一致）
const PIN_RATE_MAX = 10;
const PIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 3600 * 1000; // 每小時

function streamFile(c: import("hono").Context, vault: Vault, storedName: string, originalName: string, size: number) {
  const p = vault.filePath(storedName);
  if (!fs.existsSync(p)) return null;
  const nodeStream = fs.createReadStream(p);
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  const encoded = encodeURIComponent(originalName).replace(/['()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return c.body(web, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
    "Content-Length": String(size),
  });
}

export function registerFileVault(app: Hono, ctx: ServerToolContext): void {
  const vault = new Vault({
    db: ctx.db,
    dir: path.join(ctx.dataDir, "vault"),
  });
  const pinLimiter = makeRateLimiter(ctx.db, {
    max: PIN_RATE_MAX,
    windowMs: PIN_RATE_WINDOW_MS,
  });

  // 啟動即清一次 + 每小時排程（unref：不擋 process exit）
  vault.cleanupExpired();
  const timer = setInterval(() => {
    try {
      vault.cleanupExpired();
    } catch (e) {
      console.error("[file-vault] cleanup error:", e);
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref();

  // ── 管理 API ──────────────────────────────────────────────────────
  const admin = new Hono();
  admin.use("*", requireAuth(ctx.sessionSecret));

  admin.post("/upload", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("multipart/form-data")) {
      return c.json({ ok: false, error: "需要 multipart/form-data" }, 400);
    }
    const bb = busboy({
      headers: { "content-type": ct },
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 50 },
      defParamCharset: "utf8", // 中文檔名正確解碼（預設 latin1 會 mojibake）
    });
    const results: UploadResultItem[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        let pending = 0;
        let closed = false;
        const maybeDone = () => {
          if (pending === 0 && closed) resolve();
        };

        bb.on("file", (_name, stream, info) => {
          pending++;
          const stored = vault.newStoredName();
          const dest = vault.filePath(stored);
          const ws = fs.createWriteStream(dest);
          let size = 0;
          let truncated = false;
          let failed: string | null = null;

          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
          });
          stream.on("limit", () => {
            truncated = true;
          });
          stream.on("error", (e: Error) => {
            failed = e.message;
          });
          ws.on("error", (e: Error) => {
            failed = e.message;
          });
          ws.on("finish", () => {
            pending--;
            try {
              if (failed) {
                results.push({ ok: false, error: "寫入失敗" });
              } else if (truncated) {
                results.push({ ok: false, error: "檔案超過 2GB 上限" });
              } else {
                const rec = vault.register({
                  originalName: info.filename,
                  size,
                  storedName: stored,
                });
                results.push({ ok: true, file: rec });
              }
            } catch (e) {
              results.push({ ok: false, error: (e as Error).message });
            } finally {
              if (failed || truncated) {
                try {
                  fs.unlinkSync(dest);
                } catch {
                  /* ignore */
                }
              }
            }
            maybeDone();
          });
          stream.pipe(ws);
        });
        bb.on("close", () => {
          closed = true;
          maybeDone();
        });
        bb.on("error", (e: Error) => reject(e));
        const nodeIn = Readable.fromWeb(
          c.req.raw.body as unknown as import("node:stream/web").ReadableStream
        );
        nodeIn.on("error", (e: Error) => reject(e));
        nodeIn.pipe(bb);
      });
    } catch (e) {
      return c.json({ ok: false, error: `上傳失敗：${(e as Error).message}` }, 500);
    }

    if (results.length === 0) {
      return c.json({ ok: false, error: "沒有收到任何檔案" }, 400);
    }
    return c.json({ ok: results.some((r) => r.ok), files: results });
  });

  admin.get("/files", (c) => {
    return c.json({ ok: true, files: vault.list() });
  });

  admin.get("/download/:id", (c) => {
    const rec = vault.get(c.req.param("id"));
    if (!rec) return c.json({ ok: false, error: "找不到檔案或已自毀" }, 404);
    const resp = streamFile(c, vault, rec.storedName, rec.originalName, rec.size);
    if (!resp) {
      vault.delete(rec.id);
      return c.json({ ok: false, error: "檔案已不存在於磁碟" }, 404);
    }
    return resp;
  });

  admin.delete("/delete/:id", (c) => {
    const r = vault.delete(c.req.param("id"));
    if (!r.ok) return c.json({ ok: false, error: "找不到檔案" }, 404);
    return c.json({ ok: true });
  });

  admin.post("/share/:id", (c) => {
    const share = vault.createShare(c.req.param("id"));
    if (!share) {
      const rec = vault.get(c.req.param("id"));
      if (!rec) return c.json({ ok: false, error: "找不到檔案" }, 404);
      return c.json({ ok: false, error: "此檔案已有分享連結" }, 409);
    }
    return c.json({ ok: true, share });
  });

  admin.delete("/share/:id", (c) => {
    if (!vault.revokeShare(c.req.param("id"))) {
      return c.json({ ok: false, error: "找不到分享連結" }, 404);
    }
    return c.json({ ok: true });
  });

  app.route("/api/tools/file-vault", admin);

  // ── 公開分享（/s/:shareId）────────────────────────────────────────
  const pub = new Hono();

  pub.get("/:shareId", (c) => {
    const shareId = c.req.param("shareId");
    const rec = vault.getByShareId(shareId);
    if (!rec || !vault.ensureOnDisk(rec)) {
      return c.html(sharePageHtml({ shareId: null }), 404);
    }
    return c.html(
      sharePageHtml({ shareId, fileName: rec.originalName, sizeFmt: fmtSize(rec.size) })
    );
  });

  pub.post("/:shareId", async (c) => {
    const shareId = c.req.param("shareId");
    const rec = vault.getByShareId(shareId);
    if (!rec || !vault.ensureOnDisk(rec)) {
      return c.html(sharePageHtml({ shareId: null }), 404);
    }

    const ip = xffIp(c);
    const limit = pinLimiter.hit(`pin:${ip}:${shareId}`);
    if (!limit.allowed) {
      return c.html(
        sharePageHtml({
          shareId,
          fileName: rec.originalName,
          sizeFmt: fmtSize(rec.size),
          lockedSec: limit.retryAfterSec,
        }),
        429
      );
    }

    const body = await c.req.parseBody().catch(() => ({}));
    const pin = String((body as Record<string, unknown>).pin ?? "").trim();
    const ok = vault.verifyShare(shareId, pin);
    if (!ok) {
      return c.html(
        sharePageHtml({
          shareId,
          fileName: rec.originalName,
          sizeFmt: fmtSize(rec.size),
          error: "PIN 錯誤，請重試",
        }),
        401
      );
    }

    const resp = streamFile(c, vault, rec.storedName, rec.originalName, rec.size);
    if (!resp) {
      vault.delete(rec.id);
      return c.html(sharePageHtml({ shareId: null }), 404);
    }
    return resp;
  });

  app.route("/s", pub);
}

/** 公開端 IP（XFF 由 nginx 設定，node 只 listen localhost） */
function xffIp(c: import("hono").Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}
