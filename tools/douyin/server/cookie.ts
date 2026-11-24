// =====================================================================
//  Douyin cookie 管理
//  - 接受 Playwright 匯出的 JSON 陣列，或 `name=value; ...` 原始 header
//  - 寫檔前先驗證（profile/self），失敗不覆蓋舊檔
//  - 原子寫入（tmp + rename）、權限 0600、永不回傳 cookie 值
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import type { CookieStatus } from "../types.js";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const MAX_BYTES = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex -- 控制字元是刻意要擋的
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const EXPIRY_NAMES = new Set(["sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt"]);

export class CookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieError";
  }
}

export interface ParsedCookie {
  header: string;
  names: string[];
  /** epoch ms；取 sessionid／sid_guard 等最早到期者 */
  expiresAt: number | null;
}

interface RawEntry {
  name: string;
  value: string;
  expirationDate?: number;
}

function parseJsonArray(text: string): RawEntry[] {
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new CookieError("JSON 格式錯誤");
  }
  if (!Array.isArray(arr)) throw new CookieError("JSON 必須是 cookie 陣列");
  const out: RawEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") throw new CookieError("cookie 陣列內有非物件項目");
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.value !== "string") {
      throw new CookieError("每個 cookie 都需要 name 與 value 字串");
    }
    out.push({
      name: rec.name,
      value: rec.value,
      expirationDate: typeof rec.expirationDate === "number" ? rec.expirationDate : undefined,
    });
  }
  return out;
}

function parseHeader(text: string): RawEntry[] {
  const out: RawEntry[] = [];
  for (const part of text.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const idx = s.indexOf("=");
    if (idx <= 0) throw new CookieError(`cookie 片段缺少 '='：${s.slice(0, 24)}`);
    out.push({ name: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim() });
  }
  return out;
}

/** 解析並驗證輸入；失敗丟 CookieError（訊息可直接給前端） */
export function parseCookieInput(raw: string, maxBytes = MAX_BYTES): ParsedCookie {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new CookieError(`cookie 內容超過 ${Math.round(maxBytes / 1024)}KB`);
  }
  const text = raw.trim();
  if (!text) throw new CookieError("cookie 內容是空的");
  const entries = text.startsWith("[") ? parseJsonArray(text) : parseHeader(text);
  if (entries.length === 0) throw new CookieError("找不到任何 cookie");

  const map = new Map<string, RawEntry>();
  for (const e of entries) {
    if (!NAME_RE.test(e.name)) throw new CookieError(`cookie 名稱不合法：${e.name.slice(0, 32)}`);
    if (CONTROL_RE.test(e.value)) throw new CookieError(`cookie ${e.name} 含有控制字元`);
    map.set(e.name, e);
  }
  const session = map.get("sessionid")?.value || map.get("sessionid_ss")?.value;
  if (!session) throw new CookieError("缺少 sessionid 或 sessionid_ss，這不是已登入的 cookie");

  let expiresAt: number | null = null;
  const candidates: number[] = [];
  for (const [name, e] of map) {
    if (typeof e.expirationDate !== "number" || !Number.isFinite(e.expirationDate)) continue;
    const ms = e.expirationDate * 1000;
    if (EXPIRY_NAMES.has(name)) candidates.push(ms);
    else expiresAt = expiresAt === null ? ms : Math.min(expiresAt, ms);
  }
  if (candidates.length > 0) expiresAt = Math.min(...candidates);

  return {
    header: [...map.values()].map((e) => `${e.name}=${e.value}`).join("; "),
    names: [...map.keys()],
    expiresAt,
  };
}

/** 讀檔；不存在回 null */
export function readCookieFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 原子寫入（tmp + rename、0600）；回傳解析結果 */
export function writeCookieFile(file: string, raw: string): ParsedCookie {
  const parsed = parseCookieInput(raw);
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, raw.trim() + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* Windows 可能不支援，忽略 */
    }
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new CookieError(`寫入 cookie 檔失敗：${(err as Error).message}`);
  }
  return parsed;
}

export interface CookieProbe {
  ok: boolean;
  account: CookieStatus["account"];
  error: string | null;
}

export interface CookieManagerOptions {
  file: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  timeoutMs?: number;
}

export class CookieManager {
  readonly file: string;
  private header = "";
  private status: CookieStatus;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;

  constructor(opts: CookieManagerOptions) {
    this.file = opts.file;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.status = {
      configured: false,
      valid: null,
      checked_at: null,
      expires_at: null,
      account: null,
      last_error: null,
      path: this.file,
    };
  }

  /** 從檔案載入（不驗證）；解析失敗只記錄狀態 */
  load(): void {
    const raw = readCookieFile(this.file);
    if (raw === null) return;
    this.status.configured = true;
    try {
      const parsed = parseCookieInput(raw);
      this.header = parsed.header;
      this.status.expires_at = parsed.expiresAt;
    } catch (err) {
      this.status.valid = false;
      this.status.last_error = (err as Error).message;
    }
  }

  getHeader(): string {
    return this.header;
  }

  statusOf(): CookieStatus {
    return {
      ...this.status,
      configured: this.status.configured || this.header.length > 0,
      path: this.file,
    };
  }

  /** 用目前的 header 檢查登入狀態 */
  async check(): Promise<CookieStatus> {
    if (!this.header) {
      this.status.configured = fs.existsSync(this.file);
      this.status.valid = null;
      this.status.account = null;
      return this.statusOf();
    }
    const probe = await this.probe(this.header);
    this.status.checked_at = this.now();
    this.status.valid = probe.ok;
    this.status.account = probe.account;
    this.status.last_error = probe.error;
    return this.statusOf();
  }

  /** 貼上新 cookie：先驗證，通過才寫檔與熱重載 */
  async update(raw: string): Promise<CookieStatus> {
    const parsed = parseCookieInput(raw);
    const probe = await this.probe(parsed.header);
    this.status.checked_at = this.now();
    this.status.expires_at = parsed.expiresAt;
    if (!probe.ok) {
      this.status.valid = false;
      this.status.account = null;
      this.status.last_error = probe.error ?? "登入驗證失敗";
      return this.statusOf();
    }
    writeCookieFile(this.file, raw);
    this.header = parsed.header;
    this.status.configured = true;
    this.status.valid = true;
    this.status.account = probe.account;
    this.status.last_error = null;
    this.log(`[cookie] 已更新（${parsed.names.length} 項，帳號 ${probe.account?.nickname ?? "?"}）`);
    return this.statusOf();
  }

  /** 清除 cookie 檔與記憶體 header */
  clear(): CookieStatus {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
    this.header = "";
    this.status = {
      configured: false,
      valid: null,
      checked_at: null,
      expires_at: null,
      account: null,
      last_error: null,
      path: this.file,
    };
    return this.statusOf();
  }

  /** 對 profile/self 發一次請求；不帶任何 cookie 值到 log */
  async probe(header: string): Promise<CookieProbe> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(
        "https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383&device_platform=web",
        {
          headers: {
            "User-Agent": DEFAULT_UA,
            Cookie: header,
            Referer: "https://www.douyin.com/",
            Accept: "application/json, text/plain, */*",
          },
          signal: ctrl.signal,
        }
      );
      if (!res.ok) return { ok: false, account: null, error: `HTTP ${res.status}` };
      const text = await res.text();
      let json: { status_code?: number; user?: Record<string, unknown> };
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, account: null, error: "回應不是 JSON（cookie 可能失效）" };
      }
      const user = json.user;
      if (json.status_code !== 0 || !user || typeof user.uid !== "number" && typeof user.uid !== "string") {
        return { ok: false, account: null, error: `status_code=${json.status_code ?? "?"}` };
      }
      const uid = String(user.uid);
      return {
        ok: true,
        account: {
          uid_tail: uid.slice(-4),
          nickname: String(user.nickname ?? ""),
          unique_id: String(user.unique_id ?? ""),
        },
        error: null,
      };
    } catch (err) {
      const e = err as Error;
      return { ok: false, account: null, error: `${e.name}: ${e.message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
