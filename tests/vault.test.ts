// vault 服務層單元測試（時鐘注入 + temp dir）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../server/db.js";
import { Vault } from "../tools/file-vault/server/vault.js";

const dir = mkdtempSync(path.join(tmpdir(), "vault-unit-"));
const db = openDb(dir);
const FILES_DIR = path.join(dir, "files");

let t = 1_000_000;
const now = () => t; // 可控時鐘

function makeVault(expiryMs?: number) {
  return new Vault({ db, dir: FILES_DIR, now, expiryMs });
}

/** 建一個假檔並 register */
function seed(vault: Vault, name: string, size = 10) {
  const stored = vault.newStoredName();
  writeFileSync(vault.filePath(stored), Buffer.alloc(size, 0x61));
  return vault.register({ originalName: name, size, storedName: stored });
}

beforeAll(() => {
  t = 1_000_000;
});

beforeEach(() => {
  // 測試隔離：清空 vault_files 與實體檔目錄
  db.prepare(`DELETE FROM vault_files`).run();
  rmSync(FILES_DIR, { recursive: true, force: true });
  mkdirSync(FILES_DIR, { recursive: true });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("sanitizeName", () => {
  it("去除路徑（含反斜線）只留 basename", () => {
    expect(Vault.sanitizeName("../../etc/passwd")).toBe("passwd");
    expect(Vault.sanitizeName("C:\\Users\\evil\\file.txt")).toBe("file.txt");
    expect(Vault.sanitizeName("..%2F..%2Fetc")).toBe("..%2F..%2Fetc"); // %2F 非分隔符，保留但無害
  });
  it("去除控制字元", () => {
    expect(Vault.sanitizeName("bad\u0000name.txt")).toBe("badname.txt");
  });
  it("保留中文檔名", () => {
    expect(Vault.sanitizeName("測試報告 2026.pdf")).toBe("測試報告 2026.pdf");
  });
  it("空檔名拋錯", () => {
    expect(() => Vault.sanitizeName("///")).toThrow();
  });
});

describe("generateShare", () => {
  it("share_id 為 4 小寫字母、pin 為 4 位數", () => {
    for (let i = 0; i < 50; i++) {
      const { shareId, pin } = Vault.generateShare();
      expect(shareId).toMatch(/^[a-z]{4}$/);
      expect(pin).toMatch(/^\d{4}$/);
    }
  });
});

describe("vault CRUD", () => {
  it("register 後 get/list 一致，expiry = now + 72h", () => {
    const v = makeVault();
    const f = seed(v, "hello.txt");
    expect(f.originalName).toBe("hello.txt");
    expect(f.expireTime - f.uploadTime).toBe(72 * 3600 * 1000);
    expect(v.get(f.id)?.size).toBe(10);
    const list = v.list();
    expect(list[0].ttlSec).toBe(72 * 3600);
    expect(existsSync(v.filePath(f.storedName))).toBe(true);
  });

  it("list 依上傳時間倒序", () => {
    const v = makeVault();
    t += 1000;
    const a = seed(v, "a.txt");
    t += 1000;
    const b = seed(v, "b.txt");
    const ids = v.list().map((x) => x.id);
    expect(ids).toEqual([b.id, a.id]);
  });

  it("delete 移除記錄與實體檔", () => {
    const v = makeVault();
    const f = seed(v, "del.txt");
    expect(v.delete(f.id).ok).toBe(true);
    expect(v.get(f.id)).toBeNull();
    expect(existsSync(v.filePath(f.storedName))).toBe(false);
    expect(v.delete("none").ok).toBe(false);
  });
});

describe("share", () => {
  it("createShare 回傳 4+4 格式並寫入記錄", () => {
    const v = makeVault();
    const f = seed(v, "share.txt");
    const share = v.createShare(f.id);
    expect(share).not.toBeNull();
    expect(share!.shareId).toMatch(/^[a-z]{4}$/);
    expect(share!.pin).toMatch(/^\d{4}$/);
    expect(v.get(f.id)!.share?.shareId).toBe(share!.shareId);
  });

  it("重複建立分享被拒", () => {
    const v = makeVault();
    const f = seed(v, "dup.txt");
    v.createShare(f.id);
    expect(v.createShare(f.id)).toBeNull();
  });

  it("getByShareId / verifyShare（constant-time，錯 pin 拒絕）", () => {
    const v = makeVault();
    const f = seed(v, "verify.txt");
    const s = v.createShare(f.id)!;
    expect(v.getByShareId(s.shareId)?.id).toBe(f.id);
    expect(v.verifyShare(s.shareId, s.pin)?.id).toBe(f.id);
    expect(v.verifyShare(s.shareId, "0000")).toBeNull();
    expect(v.verifyShare(s.shareId, "00000")).toBeNull(); // 長度不同
    expect(v.verifyShare("zzzz", s.pin)).toBeNull();
    expect(v.verifyShare(s.shareId, "")).toBeNull();
  });

  it("revokeShare 清除分享", () => {
    const v = makeVault();
    const f = seed(v, "revoke.txt");
    v.createShare(f.id);
    expect(v.revokeShare(f.id)).toBe(true);
    expect(v.get(f.id)!.share).toBeNull();
    expect(v.getByShareId("abcd")).toBeNull();
    expect(v.revokeShare(f.id)).toBe(false);
  });
});

describe("cleanupExpired（時鐘注入）", () => {
  it("只刪過期檔，未到期保留", () => {
    const v = makeVault(3600 * 1000); // 1h 壽命
    t = 10_000;
    const fresh = seed(v, "fresh.txt");
    t = 20_000;
    const older = seed(v, "older.txt");
    // 推進時鐘：fresh 已過 1.1h、older 0.9h
    t = 10_000 + 3600 * 1000 + 1000;
    expect(v.cleanupExpired()).toBe(1);
    expect(v.get(fresh.id)).toBeNull();
    expect(v.get(older.id)).not.toBeNull();
  });

  it("過期檔的分享連結一併失效", () => {
    const v = makeVault(1000); // 1s 壽命
    t = 50_000;
    const f = seed(v, "exp.txt");
    const s = v.createShare(f.id)!;
    t = 50_000 + 2000; // 過期
    v.cleanupExpired();
    expect(v.getByShareId(s.shareId)).toBeNull();
    expect(readdirSync(path.join(dir, "files")).length).toBe(0);
  });
});

describe("ensureOnDisk", () => {
  it("磁碟檔遺失 → 記錄清除", () => {
    const v = makeVault();
    const f = seed(v, "ghost.txt");
    const p = v.filePath(f.storedName);
    expect(existsSync(p)).toBe(true);
    // 模擬檔案被外部刪除
    rmSync(p);
    expect(v.ensureOnDisk(v.get(f.id)!)).toBe(false);
    expect(v.get(f.id)).toBeNull();
  });
});
