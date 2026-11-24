// =====================================================================
//  DOUYIN 共用型別（server 與 client 皆可 import，不得有 node 依賴）
//  時間單位一律「秒」（float），與既有資料一致。
// =====================================================================

/** 抖音房間狀態：0=未開播 2=直播中 4=已下播 */
export const ROOM_STATUS_TEXT: Record<number, string> = {
  0: "未開播",
  2: "直播中",
  4: "已下播",
};

export interface RoomSnapshot {
  web_rid: string;
  room_id: string;
  status: number;
  status_text: string;
  title: string;
  viewer_text: string;
  viewers: number;
  viewers_desc: string;
  like_count: number;
  total_user: string;
  anchor_id: string;
  anchor_name: string;
  anchor_sec_uid: string;
  cover: string;
  has_goods: boolean;
  auth: Record<string, unknown>;
  user_id?: string;
  display_id?: string;
  sec_uid?: string;
  /** epoch 秒 */
  ts: number;
}

export type DyMessageType = "Chat" | "Gift" | "Member" | "Like";

export interface DyMessage {
  type: DyMessageType | string;
  nickname: string;
  content: string;
  gift_id: number;
  repeat: number;
  gift_name: string;
  msg_id: string;
  /** 禮物事件的鑽石總值（目錄價 × repeat；僅 Gift） */
  diamonds?: number;
  user_id?: string;
  display_id?: string;
  sec_uid?: string;
  ts: number;
}

export interface DecodedIm {
  messages: DyMessage[];
  cursor: string | null;
}

export interface RankMember {
  rank: number;
  nickname: string;
  pay_level: number;
  fans_level: number;
  guard: boolean;
  mystery: boolean;
  score?: number;
  diamonds?: number;
  level?: number;
}

export interface FansMember {
  nickname: string;
  intimacy: number;
  level: number;
}

export interface FansRank {
  club_name: string;
  fans_name: string;
  active: number;
  total: number;
  members: FansMember[];
}

export interface FansMeta extends FansRank {
  today_new: number;
  max_level: number;
  level_value: number;
  level_min: number;
  level_max: number;
  guard: boolean;
  guard_time: number;
}

export interface GiftCatalogEntry {
  name: string;
  diamond: number;
}

/** 標記：神秘人／疑似隱身／一般 */
export type EnterMark = "" | "mystery" | "suspect_hidden";

/** 名單篩選用：hidden = 疑似隱身 ∪ 未見進場 */
export type EntrantMarkLike = EnterMark | "hidden";

export interface TargetRow {
  web_rid: string;
  label: string | null;
  anchor_name: string | null;
  notify_live: number;
  notify_end: number;
  enabled: number;
  added_at: number | null;
  last_status: number | null;
  last_notify_at: number | null;
  last_checked_at: number | null;
}

export interface SessionRow {
  id: number;
  web_rid: string;
  room_id: string | null;
  source: string;
  anchor_id: string | null;
  anchor_name: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen_live_at: number | null;
  partial: number;
  likes_start: number;
  likes_end: number;
  peak_viewers: number;
  avg_viewers: number;
  total_user: string | null;
  gift_diamonds: number;
  gift_events: number;
  chat_count: number;
  chat_users: number;
  member_count: number;
  snapshot_count: number;
}

export interface SessionSummary {
  gift_diamonds: number;
  gift_events: number;
  chat_count: number;
  chat_users: number;
  member_count: number;
  snapshot_count: number;
  avg_viewers: number;
  peak_viewers: number;
  likes_start: number;
  likes_end: number;
  ended_at?: number;
}

export interface NotificationRow {
  id: number;
  ts: number;
  web_rid: string | null;
  kind: string | null;
  ok: number;
  error: string | null;
  text: string | null;
}

export interface EntrantRow {
  session_id: number;
  uid: string;
  nickname: string | null;
  display_id: string | null;
  sec_uid: string | null;
  mark: EnterMark;
  anonymous: number;
  hidden_flag: number;
  first_ts: number;
  last_ts: number;
  visits: number;
  chat_count: number;
  diamonds: number;
  last_gift_ts: number | null;
  real_nickname: string | null;
  real_unique_id: string | null;
  real_short_id: string | null;
  resolved_at: number | null;
  resolve_tries: number;
}

export interface EntrantStats {
  total: number;
  mystery: number;
  suspect_hidden: number;
  hidden_chat_only: number;
  anon: number;
  visits: number;
  chats: number;
  diamonds: number;
}

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

export interface ProfileRow extends ProfileHit {
  resolved_at: number;
}

/** cookie 登入狀態（不回傳任何 cookie 值） */
export interface CookieStatus {
  configured: boolean;
  valid: boolean | null;
  checked_at: number | null;
  expires_at: number | null;
  account: {
    uid_tail: string;
    nickname: string;
    unique_id: string;
  } | null;
  last_error: string | null;
  /** 檔案路徑（僅顯示，不回傳內容） */
  path: string;
}
