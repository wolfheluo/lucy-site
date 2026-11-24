// =====================================================================
//  DOUYIN client API（同源 cookie session）
// =====================================================================
import type {
  CookieStatus,
  EntrantRow,
  EntrantStats,
  ProfileHit,
  RankMember,
  SessionRow,
  TargetRow,
} from "../types";

const BASE = "/api/tools/douyin";

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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || json.ok === false) throw new ApiError(json.error || `HTTP ${res.status}`);
  return json;
}

export interface StateChat {
  id: number;
  type: string;
  nickname: string;
  content: string;
  gift_name?: string;
  diamonds?: number | null;
  repeat?: number;
  ts: number;
}

export interface StatePayload {
  room: Record<string, unknown>;
  loading: boolean;
  stale: boolean;
  series: { ts: number; viewers: number; likes: number; status: number }[];
  rank: RankMember[];
  fans: { club_name?: string; fans_name?: string; active?: number; total?: number; members?: { nickname: string; intimacy: number; level: number }[] };
  fans_ok: boolean;
  fans_meta: Record<string, unknown>;
  ts: { rank: number; fans: number; gift: number; chat: number; now: number };
  db: { session_id: number | null; size_mb: number; warning: boolean };
  gifts: {
    total_diamonds: number;
    events: number;
    catalog: number;
    top: { uid: string; nickname: string; diamonds: number; count: number }[];
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
  chat: StateChat[];
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
}

export interface EntrantsPayload {
  session_id: number | null;
  stats: EntrantStats | null;
  entrants: EntrantRow[];
}

export interface SessionsPayload {
  current: number | null;
  total: number;
  sessions: SessionRow[];
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
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(j.error || "登入失敗");
      }
    }),
  logout: () => fetch("/api/auth/logout", { method: "POST", credentials: "include" }),

  state: (since = 0) => req<StatePayload & { ok: boolean }>(`/state?since=${since}`),
  targets: () => req<{ selected: string; max_targets: number; targets: TargetWithState[] }>("/targets"),
  addTarget: (url: string) =>
    req<{ target: TargetRow }>("/targets", { method: "POST", body: JSON.stringify({ url }) }),
  patchTarget: (rid: string, body: Record<string, unknown>) =>
    req<{ target: TargetRow }>(`/targets/${rid}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTarget: (rid: string) => req<{ ok: true }>(`/targets/${rid}`, { method: "DELETE" }),
  selectTarget: (rid: string) =>
    req<{ web_rid: string }>(`/targets/${rid}/select`, { method: "POST" }),

  cookie: () => req<{ status: CookieStatus }>("/cookie"),
  updateCookie: (raw: string) =>
    req<{ status: CookieStatus }>("/cookie", { method: "PUT", body: JSON.stringify({ cookie: raw }) }),
  verifyCookie: () => req<{ status: CookieStatus }>("/cookie/verify", { method: "POST" }),
  clearCookie: () => req<{ status: CookieStatus }>("/cookie", { method: "DELETE" }),

  entrants: (opts: { sessionId?: number; mark?: string; q?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.sessionId) p.set("session_id", String(opts.sessionId));
    if (opts.mark) p.set("mark", opts.mark);
    if (opts.q) p.set("q", opts.q);
    p.set("limit", String(opts.limit ?? 800));
    return req<EntrantsPayload & { ok: true }>(`/entrants?${p}`);
  },
  entrantEvents: (uid: string, sessionId?: number) =>
    req<{ events: { ts: number; type: string; content: string | null; gift_name: string | null; diamonds: number | null }[] }>(
      `/entrants/${encodeURIComponent(uid)}/events${sessionId ? `?session_id=${sessionId}` : ""}`
    ),
  deleteEntrant: (uid: string, sessionId?: number) =>
    req<{ deleted: { removed: number; events: number } }>(
      `/entrants/${encodeURIComponent(uid)}${sessionId ? `?session_id=${sessionId}` : ""}`,
      { method: "DELETE" }
    ),
  profile: (idOrHandle: string, sessionId?: number) =>
    req<{ profile: ProfileHit; session_id: number | null; matched_nickname: string | null }>(
      `/profile/${encodeURIComponent(idOrHandle)}${sessionId ? `?session_id=${sessionId}` : ""}`
    ),

  sessions: () => req<SessionsPayload & { ok: true }>("/sessions?limit=100"),
  stopSession: (sid: number) => req<{ session: SessionRow }>(`/sessions/${sid}/stop`, { method: "POST" }),
  resumeSession: (sid: number) => req<{ session: SessionRow }>(`/sessions/${sid}/resume`, { method: "POST" }),
  deleteSession: (sid: number) =>
    req<{ deleted: { removed: number; events: number; entrants: number } }>(`/sessions/${sid}`, {
      method: "DELETE",
    }),
  health: () => req<Record<string, unknown>>("/health"),
};

export function csvUrl(sessionId?: number | null): string {
  return `${BASE}/entrants/export.csv${sessionId ? `?session_id=${sessionId}` : ""}`;
}
