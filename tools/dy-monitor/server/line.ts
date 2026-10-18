// =====================================================================
//  LINE 通知：訊息組裝 + Messaging API push（對照 Python line_push/warden）
//  - 憑證只從 .env 來（LINE_CHANNEL_ACCESS_TOKEN / LINE_TO）
//  - 未設定時「不送出但記錄」，介面仍可測試（ok=0 + 原因）
// =====================================================================
import type { RoomSnapshot, TargetRow } from "../types.js";

export interface LineConfig {
  token?: string;
  to?: string;
  /** 通知訊息附帶的監控台網址（可留空） */
  dashboardUrl?: string;
}

export interface PushResult {
  ok: boolean;
  error: string;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function formatTime(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `（週${WEEKDAYS[d.getDay()]}）`
  );
}

export function formatDuration(start: number | null, end: number | null): string {
  if (!start) return "—";
  const sec = Math.max(0, (end ?? Date.now() / 1000) - start);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function buildLiveMessage(
  snap: RoomSnapshot,
  target?: TargetRow | null,
  dashboardUrl = ""
): string {
  const name = snap.anchor_name || target?.label || snap.web_rid;
  const lines = [`🔴 ${name} 開播了`, `📺 ${snap.title || "（無標題）"}`];
  if (snap.viewer_text || snap.viewers) {
    lines.push(`👥 目前在線 ${snap.viewer_text || snap.viewers}`);
  }
  if (target) {
    const caps = ["cap_chat", "cap_gift", "cap_member", "cap_snap", "cap_rank"].filter(
      (k) => Number(target[k as keyof TargetRow] ?? 0)
    ).length;
    lines.push(
      `🔔 通知設定：開播${target.notify_live ? "✓" : "✗"}／下播${
        target.notify_end ? "✓" : "✗"
      }／收錄${caps}/5`
    );
  }
  lines.push(`🔗 https://live.douyin.com/${snap.web_rid}`);
  if (dashboardUrl) lines.push(`🖥 ${dashboardUrl}`);
  return lines.join("\n");
}

/** 下播小結只需要這些欄位（允許 null / 缺欄） */
export interface EndSummaryLike {
  gift_diamonds?: number | null;
  gift_events?: number | null;
  chat_count?: number | null;
  chat_users?: number | null;
  member_count?: number | null;
  snapshot_count?: number | null;
  avg_viewers?: number | null;
  peak_viewers?: number | null;
  likes_start?: number | null;
  likes_end?: number | null;
  started_at?: number | null;
  ended_at?: number | null;
  partial?: number | null;
  flags?: string | null;
}

export function buildEndMessage(
  snap: RoomSnapshot,
  target: TargetRow | null | undefined,
  summary: EndSummaryLike | null,
  dashboardUrl = ""
): string {
  const name = snap.anchor_name || target?.label || snap.web_rid;
  const lines = [`⚫ ${name} 下播了`, `📺 ${snap.title || "（無標題）"}`];

  let flags: Record<string, number> | null = null;
  if (summary?.flags) {
    try {
      flags = JSON.parse(summary.flags) as Record<string, number>;
    } catch {
      flags = null;
    }
  }
  const off = (k: string) => flags !== null && !flags[k];
  const activity = summary
    ? (summary.gift_events || 0) + (summary.chat_count || 0) + (summary.member_count || 0)
    : 0;

  if (summary && (activity || flags)) {
    lines.push(
      `⏱ 本場 ${formatDuration(summary.started_at ?? null, summary.ended_at ?? null)}` +
        (summary.partial ? "（中途開始記錄）" : "")
    );
    lines.push(
      off("gift")
        ? "🎁 禮物 未收錄"
        : `🎁 禮物 ${(summary.gift_diamonds || 0).toLocaleString("en-US")} 鑽 / ${(
            summary.gift_events || 0
          ).toLocaleString("en-US")} 次`
    );
    if (off("chat") && off("member")) {
      lines.push("💬 聊天 未收錄｜👥 進場 未收錄");
    } else if (off("chat")) {
      lines.push(`💬 聊天 未收錄｜👥 進場 ${(summary.member_count || 0).toLocaleString("en-US")}`);
    } else if (off("member")) {
      lines.push(
        `💬 聊天 ${(summary.chat_count || 0).toLocaleString("en-US")} 則（${(
          summary.chat_users || 0
        ).toLocaleString("en-US")} 人）｜👥 進場 未收錄`
      );
    } else {
      lines.push(
        `💬 聊天 ${(summary.chat_count || 0).toLocaleString("en-US")} 則（${(
          summary.chat_users || 0
        ).toLocaleString("en-US")} 人）｜👥 進場 ${(summary.member_count || 0).toLocaleString("en-US")}`
      );
    }
    if (off("snap")) {
      lines.push("❤️ 點讚 未收錄｜📈 在線快照 未收錄");
    } else {
      const delta = (summary.likes_end || 0) - (summary.likes_start || 0);
      lines.push(
        `❤️ 點讚 +${delta.toLocaleString("en-US")}｜📈 峰值 ${(
          summary.peak_viewers || 0
        ).toLocaleString("en-US")}`
      );
    }
  } else if (summary) {
    lines.push("（這場沒有收到任何事件，無本場小結）");
  } else {
    lines.push("（沒有收錄資料，無本場小結）");
  }
  lines.push(`🔗 https://live.douyin.com/${snap.web_rid}`);
  if (dashboardUrl) lines.push(`🖥 ${dashboardUrl}`);
  return lines.join("\n");
}

/** 送一則文字訊息；未設定憑證時回成功但標記「未送出」語意由呼叫端決定 */
export async function pushLine(
  cfg: LineConfig,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<PushResult> {
  if (!cfg.token || !cfg.to) {
    return { ok: false, error: "LINE 未設定（未送出）" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ to: cfg.to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, error: `HTTP ${res.status} ${body}` };
    }
    return { ok: true, error: "" };
  } catch (err) {
    return { ok: false, error: `${(err as Error).name}: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
