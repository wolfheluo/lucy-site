// =====================================================================
//  抖音資料層（逐欄對照 Python 版 dycore.py）
//  - 全部走 live.douyin.com 的 webcast 端點，零瀏覽器
//  - 免簽名：room/web/enter、im/fetch、fansclub/*、gift/list
//  - 需簽名：ranklist/audience（P1 由 signer stub 明確回報未啟用）
//  - 每次請求都有 timeout 與有限重試，慢房不得卡住整個輪詢
// =====================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeIm } from "./parser.js";
import { stubSigner, type AbogusSigner } from "./signer.js";
import type {
  DecodedIm,
  FansMeta,
  FansRank,
  GiftCatalogEntry,
  RankMember,
  RoomSnapshot,
} from "../types.js";
import { ROOM_STATUS_TEXT } from "../types.js";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export const COMMON_PARAMS: Record<string, string> = {
  aid: "6383",
  app_name: "douyin_web",
  live_id: "1",
  device_platform: "web",
  language: "zh-CN",
  cookie_enabled: "true",
  screen_width: "1440",
  screen_height: "900",
  browser_language: "zh-CN",
  browser_platform: "Linux x86_64",
  browser_name: "Chrome",
  browser_version: "141.0.0.0",
  os_name: "Windows",
  os_version: "10",
};

export interface DyClientOptions {
  /** cookie 檔（JSON 陣列或 name=value; 字串）*/
  cookieFile?: string;
  /** 直接給 cookie header（測試用）*/
  cookieHeader?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  signer?: AbogusSigner;
  userAgent?: string;
}

export interface AudienceResult {
  members: RankMember[];
  total: string;
}

/** 讀 cookie：支援 JSON 陣列（Playwright 格式）與原始 header 字串 */
export function loadCookieHeader(file: string | undefined): string {
  if (!file) return "";
  const resolved = file.startsWith("~")
    ? path.join(os.homedir(), file.slice(1))
    : file;
  try {
    const raw = fs.readFileSync(resolved, "utf8").trim();
    if (raw.startsWith("[")) {
      const list = JSON.parse(raw) as { name?: string; value?: string }[];
      return list
        .filter((c) => c.name)
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    }
    return raw;
  } catch {
    return "";
  }
}

function newUserUniqueId(): string {
  let out = "";
  for (let i = 0; i < 19; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DyClient {
  readonly cookie: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly signer: AbogusSigner;
  readonly userUniqueId = newUserUniqueId();

  constructor(opts: DyClientOptions = {}) {
    this.cookie = opts.cookieHeader ?? loadCookieHeader(opts.cookieFile);
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.retries = opts.retries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.signer = opts.signer ?? stubSigner;
  }

  private async request(
    url: string,
    referer: string,
    opts: { retries?: number; timeoutMs?: number; userAgent?: string } = {}
  ): Promise<Buffer> {
    const retries = opts.retries ?? this.retries;
    let lastErr: unknown = null;
    for (let i = 0; i < retries; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          headers: {
            "User-Agent": opts.userAgent ?? this.userAgent,
            Cookie: this.cookie,
            Referer: referer,
            Accept: "application/json, text/plain, */*",
          },
          signal: ctrl.signal,
        });
        const buf = Buffer.from(await res.arrayBuffer());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return buf;
      } catch (err) {
        lastErr = err;
        await sleep(600 * (i + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("request failed");
  }

  private async getJson<T>(url: string, referer = "https://live.douyin.com/"): Promise<T> {
    const buf = await this.request(url, referer);
    return JSON.parse(buf.toString("utf8")) as T;
  }

  private async signedGetJson<T>(
    urlPath: string,
    params: Record<string, string>,
    referer: string
  ): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const signed = this.signer.generate(qs);
    if (!signed.ok || !signed.aBogus) {
      throw new Error(signed.reason ?? "a_bogus 簽名失敗");
    }
    const url = `https://live.douyin.com${urlPath}?${qs}&a_bogus=${signed.aBogus}`;
    const buf = await this.request(url, referer, { userAgent: signed.userAgent });
    return JSON.parse(buf.toString("utf8")) as T;
  }

  // ---------- 1) 房間快照 ----------
  async roomSnapshot(
    webRid: string,
    opts: { timeoutMs?: number; retries?: number } = {}
  ): Promise<RoomSnapshot | null> {
    const params = { ...COMMON_PARAMS, web_rid: webRid, enter_from: "web_live" };
    const buf = await this.request(
      `https://live.douyin.com/webcast/room/web/enter/?${new URLSearchParams(params)}`,
      `https://live.douyin.com/${webRid}`,
      { timeoutMs: opts.timeoutMs ?? 14_000, retries: opts.retries ?? 2 }
    );
    const json = JSON.parse(buf.toString("utf8")) as {
      data?: {
        data?: Record<string, unknown>[];
        user?: Record<string, unknown>;
      };
    };
    const rooms = json.data?.data ?? [];
    if (rooms.length === 0) return null;
    const user = json.data?.user ?? {};
    const r = rooms[0] as Record<string, unknown>;
    const stats = (r.room_view_stats ?? {}) as Record<string, unknown>;
    const owner = (r.owner ?? {}) as Record<string, unknown>;
    const status = Number(r.status ?? 0);
    const coverList = ((r.cover ?? {}) as { url_list?: string[] }).url_list ?? [];
    return {
      web_rid: webRid,
      room_id: String(r.id_str ?? ""),
      status,
      status_text: ROOM_STATUS_TEXT[status] ?? "未知",
      title: String(r.title ?? ""),
      viewer_text: String(r.user_count_str ?? ""),
      viewers: Number(stats.display_value ?? 0),
      viewers_desc: String(stats.display_long ?? ""),
      like_count: Number(r.like_count ?? 0),
      total_user: String(((r.stats ?? {}) as Record<string, unknown>).total_user_str ?? ""),
      anchor_id: String(owner.id_str ?? user.id_str ?? ""),
      anchor_name: String(owner.nickname ?? user.nickname ?? ""),
      anchor_sec_uid: String(owner.sec_uid ?? user.sec_uid ?? ""),
      cover: coverList[0] ?? "",
      has_goods: Boolean(r.has_commerce_goods),
      auth: (r.room_auth ?? {}) as Record<string, unknown>,
      ts: Date.now() / 1000,
    };
  }

  // ---------- 2) 在線觀眾榜（需 a_bogus）----------
  async audienceList(snap: RoomSnapshot, count = 10): Promise<AudienceResult> {
    const params: Record<string, string> = {
      ...COMMON_PARAMS,
      enter_from: "link_share",
      webcast_sdk_version: "2450",
      room_id: snap.room_id,
      anchor_id: snap.anchor_id,
      sec_anchor_id: snap.anchor_sec_uid,
      ignoreToast: "true",
      rank_type: "30",
    };
    const json = await this.signedGetJson<{ data?: { ranks?: Record<string, unknown>[]; user_count_desc?: string } }>(
      "/webcast/ranklist/audience/",
      params,
      `https://live.douyin.com/${snap.web_rid}`
    );
    const d = json.data ?? {};
    const members: RankMember[] = (d.ranks ?? []).slice(0, count).map((row, idx) => {
      const u = (row.user ?? {}) as Record<string, unknown>;
      const pg = (u.pay_grade ?? {}) as Record<string, unknown>;
      const fcData = ((u.fans_club ?? {}) as Record<string, unknown>).data as Record<string, unknown> | undefined;
      const fc = fcData ?? {};
      return {
        rank: Number(row.rank ?? idx + 1),
        nickname: String(u.desensitized_nickname ?? u.nickname ?? "（匿名）"),
        pay_level: Number(pg.level ?? 0),
        fans_level: Number(fc.level ?? 0),
        guard: Boolean(fc.user_guard_status),
        mystery: Boolean(u.mystery_man),
      };
    });
    return { members, total: String(d.user_count_desc ?? "") };
  }

  // ---------- 3) 彈幕（免簽名，cursor 增量）----------
  async fetchChat(roomId: string, cursor = ""): Promise<DecodedIm> {
    const params: Record<string, string> = {
      resp_content_type: "protobuf",
      did_rule: "3",
      app_name: "douyin_web",
      endpoint: "live_pc",
      support_wrds: "1",
      user_unique_id: this.userUniqueId,
      identity: "audience",
      need_persist_msg_count: "15",
      room_id: roomId,
      version_code: "180800",
      last_rtt: "0",
      live_id: "1",
      aid: "6383",
      fetch_rule: "1",
      insert_task_id: "",
      live_reason: "",
      device_platform: "web",
      cookie_enabled: "true",
      screen_width: "1440",
      screen_height: "900",
      browser_language: "zh-CN",
      browser_platform: "Linux x86_64",
      browser_name: "Mozilla",
      browser_version:
        "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      browser_online: "true",
      tz_name: "UTC",
      cursor,
    };
    const buf = await this.request(
      `https://live.douyin.com/webcast/im/fetch/?${new URLSearchParams(params)}`,
      "https://live.douyin.com/"
    );
    return decodeIm(buf);
  }

  // ---------- 4) 粉絲團親密度榜（免簽名）----------
  async fansClubRank(anchorId: string, count = 20): Promise<FansRank> {
    const params: Record<string, string> = {
      ...COMMON_PARAMS,
      anchor_id: anchorId,
      anchor_open_id: anchorId,
      source: "6",
      request_scene: "1",
      action: "1",
      count: String(count),
      offset: "0",
    };
    const json = await this.getJson<{
      data?: {
        club_info?: Record<string, unknown>;
        club_user_list?: Record<string, unknown>[];
      };
    }>(`https://live.douyin.com/webcast/fansclub/club_user_list/?${new URLSearchParams(params)}`);
    const d = json.data ?? {};
    const ci = d.club_info ?? {};
    const members = (d.club_user_list ?? []).map((u) => {
      const fi = (u.user_fansclub_info ?? {}) as Record<string, unknown>;
      const ui = (u.user_info ?? {}) as Record<string, unknown>;
      return {
        nickname: String(ui.nickname ?? "（遮蔽）"),
        intimacy: Number(fi.intimacy ?? 0),
        level: Number(fi.level ?? 0),
      };
    });
    members.sort((a, b) => b.intimacy - a.intimacy);
    return {
      club_name: String(ci.name ?? ""),
      fans_name: String(ci.fans_name ?? ""),
      active: Number(ci.active_fans_count ?? 0),
      total: Number(ci.total_fans_count ?? 0),
      members: members.slice(0, 10),
    };
  }

  // ---------- 4b) 粉絲團 meta ----------
  async fansClubMeta(anchorId: string): Promise<Partial<FansMeta>> {
    const params: Record<string, string> = {
      ...COMMON_PARAMS,
      anchor_id: anchorId,
      anchor_open_id: anchorId,
      source: "6",
      request_scene: "1",
      action: "1",
    };
    const json = await this.getJson<{ data?: Record<string, unknown> }>(
      `https://live.douyin.com/webcast/fansclub/homepage/?${new URLSearchParams(params)}`
    );
    const d = json.data ?? {};
    const ci = (d.club_info ?? {}) as Record<string, unknown>;
    const lv = (ci.club_level_info ?? {}) as Record<string, unknown>;
    return {
      club_name: String(ci.name ?? ""),
      fans_name: String(ci.fans_name ?? ""),
      active: Number(ci.active_fans_count ?? 0),
      total: Number(ci.total_fans_count ?? 0),
      today_new: Number(ci.today_new_fans_count ?? 0),
      max_level: Number(ci.max_level ?? 0),
      level_value: Number(lv.cur_value ?? 0),
      level_min: Number(lv.cur_level_min ?? 0),
      level_max: Number(lv.cur_level_max ?? 0),
      guard: Boolean(d.is_sign_up_guard),
      guard_time: Number(d.guard_online_time ?? 0),
    };
  }

  // ---------- 5) 禮物目錄（免簽名）----------
  async giftCatalog(roomId: string, anchorId: string): Promise<Record<string, GiftCatalogEntry>> {
    const params: Record<string, string> = {
      ...COMMON_PARAMS,
      room_id: roomId,
      anchor_id: anchorId,
    };
    const json = await this.getJson<{
      data?: { gifts?: Record<string, unknown>[] };
    }>(`https://live.douyin.com/webcast/gift/list/?${new URLSearchParams(params)}`);
    const out: Record<string, GiftCatalogEntry> = {};
    for (const g of json.data?.gifts ?? []) {
      out[String(g.id ?? 0)] = {
        name: String(g.name ?? ""),
        diamond: Number(g.diamond_count ?? 0),
      };
    }
    return out;
  }
}
