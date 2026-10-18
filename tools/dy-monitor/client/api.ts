// =====================================================================
//  dy-monitor client API（同源 cookie session；401 → 呼叫端切回鎖定畫面）
// =====================================================================
import type {
  FansMeta,
  FansRank,
  NotificationRow,
  RankMember,
  RoomSnapshot,
  SessionRow,
  TargetRow,
} from "../types";

const BASE = "/api/tools/dy-monitor";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || json.ok === false) {
    throw new ApiError(json.error || `HTTP ${res.status}`);
  }
  return json;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface StatePayload {
  room: Partial<RoomSnapshot>;
  loading: boolean;
  stale: boolean;
  series: { ts: number; viewers: number; likes: number; status: number }[];
  rank: RankMember[];
  fans: Partial<FansRank>;
  fans_ok: boolean;
  fans_meta: Partial<FansMeta>;
  ts: { rank: number; fans: number; gift: number; chat: number; now: number };
  db: { session_id: number | null; size_mb: number; warning: boolean };
  gifts: {
    total_diamonds: number;
    events: number;
    catalog: number;
    top: { nickname: string; diamonds: number; count: number }[];
  };
  inter: {
    minutes: number;
    chat: number;
    chat_users: number;
    member: number;
    like_events: number;
    chat_per_min: number;
    member_per_min: number;
    gift_per_min: number;
    likes_per_min: number;
  };
  chat: {
    id: number;
    type: string;
    nickname: string;
    content: string;
    gift_name: string;
    diamonds?: number;
    repeat?: number;
    ts: number;
  }[];
  chat_cursor: number;
  api: { rank_ok: boolean; chat_ok: boolean; abogus: boolean };
  uptime: number;
  errors: { ts: number; msg: string }[];
  intervals: { stats: number; chat: number; rank: number; fans: number };
  selected_web_rid: string;
}

export interface TargetWithState extends TargetRow {
  selected: boolean;
  status_text: string;
  caps_on: number;
  caps_total: number;
}

export interface ReplayPayload {
  ok: boolean;
  replay: boolean;
  web_rid: string;
  session: SessionRow;
  series: { ts: number; viewers: number; likes: number }[];
  chat: { ts: number; type: string; nickname: string; content: string; gift_name: string; diamonds: number; repeat: number }[];
  rank: RankMember[];
  fans: (Partial<FansRank> & { today_new?: number; guard?: number; ts?: number }) | null;
  gifts: { total_diamonds: number; events: number; top: { nickname: string; diamonds: number; count: number }[] };
}

export const dyApi = {
  me: () =>
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json() as Promise<{ authed?: boolean }>)
      .then((j) => Boolean(j.authed)),
  login: (password: string) =>
    fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(async (r) => {
      if (!r.ok) throw new ApiError(((await r.json().catch(() => ({}))) as { error?: string }).error || "登入失敗");
    }),
  logout: () => fetch("/api/auth/logout", { method: "POST", credentials: "include" }),
  state: (since: number) => req<StatePayload>(`/state?since=${since}`),
  targets: () => req<{ selected: string; targets: TargetWithState[] }>("/targets"),
  addTarget: (url: string) =>
    req<{ target: TargetRow }>("/targets", { method: "POST", body: JSON.stringify({ url }) }),
  patchTarget: (rid: string, body: Record<string, unknown>) =>
    req<{ target: TargetRow }>(`/targets/${rid}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTarget: (rid: string) => req<{ ok: boolean }>(`/targets/${rid}`, { method: "DELETE" }),
  selectTarget: (rid: string) => req<{ web_rid: string }>(`/targets/${rid}/select`, { method: "POST" }),
  replay: (rid: string) => req<ReplayPayload>(`/replay/${rid}`),
  notifications: (limit = 8) => req<{ notifications: NotificationRow[] }>(`/notifications?limit=${limit}`),
  testPush: () => req<{ ok: boolean; error?: string }>("/notify/test", { method: "POST" }),
  health: () => req<Record<string, unknown>>("/health"),
};
