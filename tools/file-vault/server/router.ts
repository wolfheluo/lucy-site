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
//      POST   /:shareId        pin 驗證 → 成功即串流下載（錯 pin 3 次鎖 60s，鎖 IP）
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import busboy from "busboy";
import { Hono } from "hono";
import type { ServerToolContext } from "../../types.js";
import { requireAuth } from "../../../server/auth.js";
import { clientIp } from "../../../server/request-ip.js";
import { Vault } from "./vault.js";
import { fmtSize, sharePageHtml } from "./share-page.js";
import type { UploadResultItem } from "../types.js";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB（與 nginx client_max_body_size 一致）
const MAX_FORM_BODY = 64 * 1024; // H4：公開 pin 表單上限（避免 parseBody 整包讀入記憶體）
/** 分享 pin 防護：錯 pin 才計，第 PIN_MAX_FAILS 次錯當下鎖 PIN_LOCK_MS（起算滿） */
const PIN_MAX_FAILS = 3;
const PIN_LOCK_MS = 60 * 1000;
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
  // 分享 pin 防護（錯 pin 才計；lock_until 起算滿 300s；鎖定期任何提交都拒）
  const stmtGuard = ctx.db.prepare(
    `SELECT fail_count, lock_until FROM share_pin_guards WHERE key = ?`
  );
  const stmtUpsertGuard = ctx.db.prepare(
    `INSERT INTO share_pin_guards (key, fail_count, lock_until) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fail_count = excluded.fail_count, lock_until = excluded.lock_until`
  );
  const stmtClearGuard = ctx.db.prepare(`DELETE FROM share_pin_guards WHERE key = ?`);

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
    // H4：Content-Length 可判時先擋掉超大請求（chunked 無長度者仍由 busboy fileSize 兜底）
    const contentLen = Number(c.req.header("content-length") ?? 0);
    if (contentLen > MAX_UPLOAD_BYTES) {
      return c.json({ ok: false, error: "上傳內容過大" }, 413);
    }
    const bb = busboy({
      headers: { "content-type": ct },
      // H5：不收任何欄位、限制總 part 數；fileSize 為單檔上限
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 50, fields: 0, parts: 50 },
      defParamCharset: "utf8", // 中文檔名正確解碼（預設 latin1 會 mojibake）
    });
    const results: UploadResultItem[] = [];
    /** 本次 request 建立的所有實體檔（M3：未成功 register 的於結束時一併清除） */
    const writtenStores: string[] = [];
    const registeredStores = new Set<string>();
    /** busboy 檔/part 數超限（M-9：原靜默丟棄 → 回傳明確 error item） */
    let limitExceeded = false;

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
          writtenStores.push(stored);
          const dest = vault.filePath(stored);
          const ws = fs.createWriteStream(dest);
          let size = 0;
          let truncated = false;
          let failed: string | null = null;
          let finalized = false;

          // 每檔只結算一次：finish 或任一 error 皆走這裡，避免 promise 永不 resolve
          const finalize = () => {
            if (finalized) return;
            finalized = true;
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
                registeredStores.add(stored);
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
          };

          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
          });
          stream.on("limit", () => {
            truncated = true;
          });
          stream.on("error", (e: Error) => {
            // 來源串流出錯：中斷寫入並結算（M3：避免 orphan 與 pending 卡死）
            failed = e.message;
            ws.destroy();
            finalize();
          });
          ws.on("error", (e: Error) => {
            failed = e.message;
            finalize();
            ws.destroy();
          });
          ws.on("finish", finalize);
          stream.pipe(ws);
        });
        bb.on("filesLimit", () => {
          limitExceeded = true;
        });
        bb.on("partsLimit", () => {
          limitExceeded = true;
        });
        bb.on("close", () => {
          if (limitExceeded) {
            results.push({
              ok: false,
              error: "超過單次上傳上限（50 個檔案），其餘檔案未上傳",
            });
          }
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
    } finally {
      // M3：reject / 斷線路徑可能留下「已寫入但未 register」的暫存檔，一律清除
      for (const stored of writtenStores) {
        if (registeredStores.has(stored)) continue;
        try {
          fs.unlinkSync(vault.filePath(stored));
        } catch {
          /* ignore */
        }
      }
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
    // H4：pin 表單極小；Content-Length 超限直接 413（防 parseBody 整包讀入記憶體）
    const contentLen = Number(c.req.header("content-length") ?? 0);
    if (contentLen > MAX_FORM_BODY) {
      return c.text("Payload Too Large", 413);
    }
    const rec = vault.getByShareId(shareId);
    if (!rec || !vault.ensureOnDisk(rec)) {
      return c.html(sharePageHtml({ shareId: null }), 404);
    }

    const ip = clientIp(c, ctx.trustProxy);
    const gkey = `pin:${ip}:${shareId}`;
    const guard = stmtGuard.get(gkey) as
      | { fail_count: number; lock_until: number }
      | undefined;
    const now = Date.now();
    // 鎖定期（lock_until 起算滿 300s）：任何提交（含對 pin）都拒——回剩餘秒
    // + 絕對 lockUntil（前端精確倒數、refresh 後再提交同步）
    if (guard && guard.lock_until > now) {
      const lockedSec = Math.ceil((guard.lock_until - now) / 1000);
      return c.html(
        sharePageHtml({
          shareId,
          fileName: rec.originalName,
          sizeFmt: fmtSize(rec.size),
          lockedSec,
          lockUntil: guard.lock_until,
        }),
        429
      );
    }

    const body = await c.req.parseBody().catch(() => ({}));
    const pin = String((body as Record<string, unknown>).pin ?? "").trim();
    const ok = vault.verifyShare(shareId, pin);
    if (!ok) {
      const fails = (guard?.fail_count ?? 0) + 1;
      if (fails >= PIN_MAX_FAILS) {
        // 第 PIN_MAX_FAILS 次錯：當下鎖定、起算滿 PIN_LOCK_MS
        const lockUntil = now + PIN_LOCK_MS;
        stmtUpsertGuard.run(gkey, fails, lockUntil);
        return c.html(
          sharePageHtml({
            shareId,
            fileName: rec.originalName,
            sizeFmt: fmtSize(rec.size),
            lockedSec: Math.round(PIN_LOCK_MS / 1000),
            lockUntil,
          }),
          429
        );
      }
      stmtUpsertGuard.run(gkey, fails, 0);
      return c.html(
        sharePageHtml({
          shareId,
          fileName: rec.originalName,
          sizeFmt: fmtSize(rec.size),
          error: `PIN 錯誤，請重試（剩餘 ${PIN_MAX_FAILS - fails} 次）`,
        }),
        401
      );
    }
    stmtClearGuard.run(gkey); // 對 pin：錯誤計數重置

    const resp = streamFile(c, vault, rec.storedName, rec.originalName, rec.size);
    if (!resp) {
      vault.delete(rec.id);
      return c.html(sharePageHtml({ shareId: null }), 404);
    }
    return resp;
  });

  app.route("/s", pub);
}
