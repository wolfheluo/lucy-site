// =====================================================================
//  dy-enter client API（同源 cookie session；401 → 上層切回鎖定畫面）
// =====================================================================
const BASE = "/api/tools/dy-enter";

export type EnterMark = "" | "mystery" | "suspect_hidden";

export interface EnterSession {
  id: number;
  web_rid: string;
  room_id: string | null;
  anchor_name: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen_at: number | null;
}

export interface Entrant {
  uid: string;
  nickname: string | null;
  display_id: string | null;
  sec_uid: string | null;
  mark: EnterMark;
  first_ts: number;
  last_ts: number;
  visits: number;
}

export interface Stats {
  total: number;
  mystery: number;
  suspect_hidden: number;
  visits: number;
}

export interface StatePayload {
  ok: boolean;
  session: EnterSession | null;
  live: boolean;
  stats: Stats | null;
  recent: Entrant[];
  last_error?: string;
  chat_ok?: boolean;
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

export const enterApi = {
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
  startSession: (url: string) =>
    req<{ session: EnterSession; live: boolean }>("/session", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  selectSession: (sid: number) =>
    req<{ session: EnterSession }>(`/session/${sid}/select`, { method: "POST" }),
  state: (limit = 20) => req<StatePayload>(`/state?limit=${limit}`),
  entrants: (sessionId: number, mark?: EnterMark, limit = 500) => {
    const p = new URLSearchParams({ session_id: String(sessionId), limit: String(limit) });
    if (mark) p.set("mark", mark);
    return req<{ session_id: number; stats: Stats; entrants: Entrant[] }>(`/entrants?${p}`);
  },
  entries: (uid: string, sessionId: number) =>
    req<{ entries: { ts: number }[] }>(`/entrants/${encodeURIComponent(uid)}/entries?session_id=${sessionId}`),
  sessions: (limit = 50) =>
    req<{ current: number | null; sessions: EnterSession[] }>(`/sessions?limit=${limit}`),
};
