// =====================================================================
//  FILE VAULT 服務層（SQLite CRUD + 分享 + 自毀清理）
//  - 儲存隔離：實體檔名 = <uuid>.dat（副檔名無意義，防直接執行/路徑穿越）
//  - 原始檔名只保留 basename，去除控制字元
//  - 分享：share_id 4 小寫字母 + pin 4 位數（crypto，constant-time 驗證）
//  - 自毀：讀取路徑（get/getByShareId/list）發現過期即時湮滅；cleanupExpired 為兜底
//    （now 可注入供測試）
// =====================================================================
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { posix } from "node:path";
import type { Db } from "../../../server/db.js";
import type { FileListItem, ShareInfo, VaultFile } from "../types.js";

export const DEFAULT_EXPIRY_MS = 72 * 3600 * 1000; // 72h

export interface VaultDeps {
  db: Db;
  /** 存放 *.dat 的目錄（會自動 mkdir） */
  dir: string;
  /** 可注入時鐘（測試） */
  now?: () => number;
  /** 檔案壽命（測試可縮短） */
  expiryMs?: number;
}

export interface NewFileInput {
  originalName: string;
  size: number;
}

export class Vault {
  private db: Db;
  private dir: string;
  private nowFn: () => number;
  private expiryMs: number;
  private insertStmt;

  constructor(deps: VaultDeps) {
    this.db = deps.db;
    this.dir = deps.dir;
    this.nowFn = deps.now ?? Date.now;
    this.expiryMs = deps.expiryMs ?? DEFAULT_EXPIRY_MS;
    fs.mkdirSync(this.dir, { recursive: true });
    this.insertStmt = this.db.prepare(
      `INSERT INTO vault_files
         (id, original_name, stored_name, size, upload_time, expire_time,
          share_id, share_pin, share_created_at)
       VALUES (@id, @originalName, @storedName, @size, @uploadTime, @expireTime,
          NULL, NULL, NULL)`
    );
  }

  now(): number {
    return this.nowFn();
  }

  /** 淨化原始檔名：只留 basename + 去控制字元（保留 UTF-8 顯示名） */
  static sanitizeName(name: string): string {
    let base = posix.basename(name.replace(/\\/g, "/"));
    base = base.replace(/[\u0000-\u001f\u007f]/g, "");
    if (!base) throw new Error("無效的檔案名稱");
    return base;
  }

  /** 產生分享碼（4 小寫字母）與 pin（4 位數） */
  static generateShare(): { shareId: string; pin: string } {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    let shareId = "";
    for (let i = 0; i < 4; i++) shareId += letters[crypto.randomInt(26)];
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    return { shareId, pin };
  }

  /** 實體路徑（stored_name 一律由內部產生，不接受外部輸入） */
  filePath(storedName: string): string {
    return path.join(this.dir, storedName);
  }

  private rowToFile(row: Record<string, unknown>): VaultFile {
    return {
      id: row.id as string,
      originalName: row.original_name as string,
      storedName: row.stored_name as string,
      size: row.size as number,
      uploadTime: row.upload_time as number,
      expireTime: row.expire_time as number,
      share:
        row.share_id !== null
          ? {
              shareId: row.share_id as string,
              pin: row.share_pin as string,
              createdAt: row.share_created_at as number,
            }
          : null,
    };
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  /** 記錄一個已寫入磁碟的檔案（storedName 由呼叫方產生 uuid） */
  register(input: NewFileInput & { storedName: string }): VaultFile {
    const now = this.nowFn();
    const id = crypto.randomUUID();
    this.insertStmt.run({
      id,
      originalName: Vault.sanitizeName(input.originalName),
      storedName: input.storedName,
      size: input.size,
      uploadTime: now,
      expireTime: now + this.expiryMs,
    });
    const rec = this.get(id);
    if (!rec) throw new Error("register 失敗");
    return rec;
  }

  /** 產生新 uuid 儲存名（呼叫方負責把串流寫入） */
  newStoredName(): string {
    return `${crypto.randomUUID()}.dat`;
  }

  private selectRow(id: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(`SELECT * FROM vault_files WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
  }

  /**
   * 過期即時湮滅（M-2）：讀取路徑發現已過期 → 立即刪除（DB+磁碟檔），
   * 回傳 null 視同不存在——不等待每小時 cleanup sweep。
   */
  private purgeIfExpired(rec: VaultFile): VaultFile | null {
    if (rec.expireTime <= this.nowFn()) {
      this.delete(rec.id);
      return null;
    }
    return rec;
  }

  get(id: string): VaultFile | null {
    const row = this.selectRow(id);
    if (!row) return null;
    return this.purgeIfExpired(this.rowToFile(row));
  }

  list(): FileListItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM vault_files ORDER BY upload_time DESC`)
      .all() as Record<string, unknown>[];
    const now = this.nowFn();
    const out: FileListItem[] = [];
    for (const r of rows) {
      if ((r.expire_time as number) <= now) {
        // 過期列即時湮滅，不列入清單
        this.delete(r.id as string);
        continue;
      }
      const f = this.rowToFile(r);
      out.push({
        id: f.id,
        originalName: f.originalName,
        size: f.size,
        uploadTime: f.uploadTime,
        expireTime: f.expireTime,
        ttlSec: Math.max(0, Math.round((f.expireTime - now) / 1000)),
        share: f.share,
      });
    }
    return out;
  }

  delete(id: string): { ok: boolean; file?: VaultFile } {
    // 直接 raw select（不走 get/purgeIfExpired，避免過期刪除的遞迴）
    const row = this.selectRow(id);
    if (!row) return { ok: false };
    const rec = this.rowToFile(row);
    this.db.prepare(`DELETE FROM vault_files WHERE id = ?`).run(id);
    try {
      fs.unlinkSync(this.filePath(rec.storedName));
    } catch {
      /* 檔案可能已不存在，忽略 */
    }
    return { ok: true, file: rec };
  }

  /** 磁碟檔不見 → 連記錄一起清（防 ghost 記錄） */
  ensureOnDisk(rec: VaultFile): boolean {
    if (fs.existsSync(this.filePath(rec.storedName))) return true;
    this.db.prepare(`DELETE FROM vault_files WHERE id = ?`).run(rec.id);
    return false;
  }

  // ── 分享 ────────────────────────────────────────────────────────────

  createShare(fileId: string): ShareInfo | null {
    const rec = this.get(fileId);
    if (!rec || rec.share) return null;
    const { shareId, pin } = Vault.generateShare();
    const createdAt = this.nowFn();
    this.db
      .prepare(
        `UPDATE vault_files SET share_id = ?, share_pin = ?, share_created_at = ?
         WHERE id = ?`
      )
      .run(shareId, pin, createdAt, fileId);
    return { shareId, pin, createdAt };
  }

  revokeShare(fileId: string): boolean {
    const rec = this.get(fileId);
    if (!rec || !rec.share) return false;
    this.db
      .prepare(`UPDATE vault_files SET share_id = NULL, share_pin = NULL, share_created_at = NULL WHERE id = ?`)
      .run(fileId);
    return true;
  }

  getByShareId(shareId: string): VaultFile | null {
    const row = this.db
      .prepare(`SELECT * FROM vault_files WHERE share_id = ?`)
      .get(shareId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.purgeIfExpired(this.rowToFile(row));
  }

  /** constant-time 驗證 pin */
  verifyShare(shareId: string, pinInput: string): VaultFile | null {
    const rec = this.getByShareId(shareId);
    if (!rec || !rec.share) return null;
    const a = Buffer.from(String(rec.share.pin));
    const b = Buffer.from(String(pinInput ?? "").trim());
    if (a.length !== b.length) return null;
    return crypto.timingSafeEqual(a, b) ? rec : null;
  }

  // ── 自毀清理 ────────────────────────────────────────────────────────

  /** 刪除所有已過期檔案，回傳刪除數 */
  cleanupExpired(): number {
    const now = this.nowFn();
    const rows = this.db
      .prepare(`SELECT id FROM vault_files WHERE expire_time <= ?`)
      .all(now) as { id: string }[];
    let deleted = 0;
    for (const { id } of rows) {
      const r = this.delete(id);
      if (r.ok) deleted++;
    }
    return deleted;
  }
}

export type VaultInstance = Vault;
