// =====================================================================
//  管理員認證：單一密碼 + HMAC 簽名 session cookie
//  - cookie 格式：<base64url(payload)>.<base64url(hmac-sha256 前 16B)>
//  - payload = { v: 1, at: epochMs }；簽名驗證失敗即視為未登入
//  - 無 server state → 單/多 process 皆可用，重啟不掉登入
// =====================================================================
import { createHmac, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler, Next } from "hono";

export const AUTH_COOKIE = "lucy_session";

interface SessionPayload {
  v: 1;
  at: number;
  /** 隨機 nonce，避免同秒重放外觀相同 */
  n: string;
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export function signSession(secret: string, payload: SessionPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url").slice(0, 22);
  return `${body}.${sig}`;
}

export function verifySession(secret: string, token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = createHmac("sha256", secret).update(body).digest("base64url").slice(0, 22);
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (payload.v !== 1 || typeof payload.at !== "number") return null;
    if (Date.now() - payload.at > SESSION_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 驗證密碼（constant-time） */
export function checkPassword(actual: string, input: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(input);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 登入成功後設定 cookie */
export function issueSession(c: Context, secret: string): void {
  const payload: SessionPayload = {
    v: 1,
    at: Date.now(),
    n: Math.random().toString(36).slice(2, 10),
  };
  setCookie(c, AUTH_COOKIE, signSession(secret, payload), {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
}

export function isAuthed(c: Context, secret: string): boolean {
  return verifySession(secret, getCookie(c, AUTH_COOKIE)) !== null;
}

/** Hono middleware：未登入回 401 JSON */
export function requireAuth(secret: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthed(c, secret)) {
      return c.json({ ok: false, error: "未授權" }, 401);
    }
    await next();
  };
}
