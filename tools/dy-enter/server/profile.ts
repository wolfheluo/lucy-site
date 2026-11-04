// =====================================================================
//  以 UID 反查抖音暱稱（免簽名）
//  端點：GET https://www.douyin.com/aweme/v1/web/user/profile/other/?user_id=<uid>&aid=6383...
//  · 實測（2026-11）：不需要 a_bogus，帶登入 cookie 即可
//  · 神祕人的事件暱稱被遮蔽，但 uid 是真的 → 由此拿回真實暱稱
//  · 抖音號（unique_id／short_id）也在回應裡
// =====================================================================
import type { DyClient } from "../../dy-monitor/server/dycore.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export interface ProfileHit {
  uid: string;
  nickname: string;
  uniqueId: string;
  shortId: string;
  secUid: string;
  followers: number;
  awemes: number;
  signature: string;
}

interface CacheRow {
  at: number;
  hit: ProfileHit | null;
}

export class ProfileResolver {
  private cookie: string;
  private ua: string;
  private log: (m: string) => void;
  private cache = new Map<string, CacheRow>();
  private cacheTtlMs = 30 * 60_000;
  /** 兩次查詢之間的最小間隔（避免被風控） */
  private minGapMs = 1_100;
  private lastAt = 0;

  constructor(client: DyClient, log: (m: string) => void = () => {}) {
    this.cookie = client.cookie;
    this.ua = DEFAULT_UA;
    this.log = log;
  }

  private async waitGap(): Promise<void> {
    const delta = Date.now() - this.lastAt;
    if (delta < this.minGapMs) await new Promise((r) => setTimeout(r, this.minGapMs - delta));
    this.lastAt = Date.now();
  }

  /** 抖音號（自訂 ID）→ sec_uid（免簽名，iesdouyin 分享端點） */
  private async secUidFromHandle(handle: string): Promise<string | null> {
    const url =
      "https://www.iesdouyin.com/web/api/v2/user/info/?unique_id=" + encodeURIComponent(handle);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": this.ua,
          Cookie: this.cookie,
          Referer: "https://www.douyin.com/",
          Accept: "application/json, text/plain, */*",
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let j: { status_code?: number; user_info?: { sec_uid?: string } };
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`iesdouyin 回應不是 JSON（cookie 可能失效，長度 ${text.length}）`);
      }
      if (j.status_code !== 0) return null;   // 查無此抖音號
      return j.user_info?.sec_uid || null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 反查單一 uid。
   *  · 回 null ＝ 明確查無此人（可計為一次失敗）
   *  · throw  ＝ 網路／風控等暫時性錯誤（呼叫端不要累計重試次數）
   */
  async resolve(idOrHandle: string): Promise<ProfileHit | null> {
    const key = String(idOrHandle || "").trim();
    if (!key) return null;
    // 自訂抖音號（非數字、非 sec_uid）→ 先換成 sec_uid
    if (!/^\d{5,20}$/.test(key) && !key.startsWith("MS4wLjAB")) {
      const sec = await this.secUidFromHandle(key);
      if (!sec) return null;
      return this.resolveSecUid(sec);
    }
    if (key.startsWith("MS4wLjAB")) return this.resolveSecUid(key);
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.cacheTtlMs) return c.hit;

    return this.resolveBy("user_id", key);
  }

  /** 用 sec_user_id 查（自訂抖音號轉來的） */
  private async resolveSecUid(secUid: string): Promise<ProfileHit | null> {
    const c = this.cache.get(secUid);
    if (c && Date.now() - c.at < this.cacheTtlMs) return c.hit;
    return this.resolveBy("sec_user_id", secUid);
  }

  private async resolveBy(param: "user_id" | "sec_user_id", value: string): Promise<ProfileHit | null> {
    const key = value;
    await this.waitGap();
    const url =
      "https://www.douyin.com/aweme/v1/web/user/profile/other/" +
      `?${param}=${encodeURIComponent(key)}&aid=6383&device_platform=web&origin=${encodeURIComponent("https://www.douyin.com")}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      const res = await fetch(url, {
        headers: {
          "User-Agent": this.ua,
          Cookie: this.cookie,
          Referer: "https://www.douyin.com/",
          Accept: "application/json, text/plain, */*",
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let j: { status_code?: number; user?: Record<string, unknown> };
      try {
        j = JSON.parse(text);
      } catch {
        // 常見原因：cookie 失效被導到驗證頁
        throw new Error(`回應不是 JSON（cookie 可能失效，長度 ${text.length}）`);
      }
      const u = j.user;
      if (j.status_code !== 0 || !u || typeof u.nickname !== "string") {
        this.cache.set(key, { at: Date.now(), hit: null });
        return null;
      }
      const hit: ProfileHit = {
        uid: String(u.uid ?? key),
        nickname: String(u.nickname ?? ""),
        uniqueId: String(u.unique_id ?? ""),
        shortId: String(u.short_id ?? ""),
        secUid: String(u.sec_uid ?? ""),
        followers: Number(u.follower_count ?? 0),
        awemes: Number(u.aweme_count ?? 0),
        signature: String(u.signature ?? ""),
      };
      this.cache.set(key, { at: Date.now(), hit });
      return hit;
    } catch (e) {
      this.log(`[dy-enter] 反查 ${key} 失敗：${(e as Error).message}`);
      throw e;
    }
  }
}
