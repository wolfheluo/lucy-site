// =====================================================================
//  dy-monitor 共用型別（server 與 client 皆可 import；不得有 runtime 依賴）
//  時間單位一律「秒」（float），與 Python 版資料庫一致，搬資料零轉換。
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
  /** epoch 秒 */
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

/** v4 收錄細項（0/1） */
export interface CaptureFlags {
  chat: number;
  gift: number;
  member: number;
  snap: number;
  rank: number;
}

export const CAPTURE_KEYS = ["chat", "gift", "member", "snap", "rank"] as const;
export type CaptureKey = (typeof CAPTURE_KEYS)[number];

export interface TargetRow {
  web_rid: string;
  label: string | null;
  anchor_name: string | null;
  notify_live: number;
  notify_end: number;
  capture: number;
  cap_chat: number;
  cap_gift: number;
  cap_member: number;
  cap_snap: number;
  cap_rank: number;
  added_at: number | null;
  last_status: number | null;
  last_notify_at: number | null;
  last_checked_at: number | null;
}

export interface SessionRow {
  id: number;
  web_rid: string;
  source: string;
  room_id: string | null;
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
  flags: string | null;
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
