#!/usr/bin/env node
// =====================================================================
//  dy-monitor CLI（P3：與 Python 版 history.py 的功能對等）
//  用法：
//    DY_CLI_PASSWORD=xxx node scripts/dy-cli.mjs list [--limit 20]
//    DY_CLI_PASSWORD=xxx node scripts/dy-cli.mjs show <session_id>
//    DY_CLI_PASSWORD=xxx node scripts/dy-cli.mjs events <session_id> [--type Gift] [--q 關鍵字] [--limit 50]
//  環境變數：DY_CLI_BASE（預設 http://127.0.0.1:3001）、DY_CLI_PASSWORD
// =====================================================================
const BASE = (process.env.DY_CLI_BASE ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const PASSWORD = process.env.DY_CLI_PASSWORD ?? "";
const API = `${BASE}/api/tools/dy-monitor`;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "list";
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]?.startsWith("--")));

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function login() {
  if (!PASSWORD) die("需要 DY_CLI_PASSWORD 環境變數（管理密碼）");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) die(`登入失敗（HTTP ${res.status}）`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) die("登入回應沒有 cookie");
  return cookie;
}

async function get(path, cookie) {
  const res = await fetch(API + path, { headers: { cookie } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) die(`API 失敗：${json.error ?? res.status}`);
  return json;
}

const pad = (n, w = 2) => String(n).padStart(w, " ");
const dt = (sec) =>
  sec
    ? new Date(sec * 1000).toLocaleString("zh-TW", { hour12: false })
    : "—";
const dur = (a, b) => {
  if (!a) return "—";
  const sec = Math.max(0, (b ?? Date.now() / 1000) - a);
  const h = Math.floor(sec / 3600);
  return h ? `${h}h${pad(Math.floor((sec % 3600) / 60))}m` : `${Math.floor(sec / 60)}m`;
};
const n = (v) => Number(v ?? 0).toLocaleString("en-US");

async function main() {
  const cookie = await login();

  if (cmd === "list") {
    const limit = Number(flag("limit", "20"));
    const { total, sessions } = await get(`/history/sessions?limit=${limit}`, cookie);
    console.log(`歷史場次：共 ${total} 場（顯示 ${sessions.length}）\n`);
    console.log("  id  主播                 開播              時長   在線峰/均     禮物鑽/次      聊天   進場");
    for (const s of sessions) {
      console.log(
        `  ${pad(s.id, 3)} ${String(s.anchor_name ?? s.web_rid).slice(0, 18).padEnd(18)} ` +
          `${dt(s.started_at).padEnd(17)} ${dur(s.started_at, s.ended_at).padEnd(6)} ` +
          `${pad(n(s.peak_viewers), 6)}/${n(Math.round(s.avg_viewers)).padEnd(7)} ` +
          `${n(s.gift_diamonds).padStart(10)}/${n(s.gift_events).padEnd(6)} ` +
          `${n(s.chat_count).padStart(6)} ${n(s.member_count).padStart(6)}`
      );
    }
    return;
  }

  const sid = Number(positional[1] ?? flag("id", "0"));
  if (!sid) die("需要 session id：show <sid> / events <sid>");

  if (cmd === "show") {
    const d = await get(`/history/session/${sid}`, cookie);
    const s = d.session;
    console.log(`場次 #${s.id}  ${s.anchor_name ?? ""}  ${s.title ?? ""}`);
    console.log(
      `開播 ${dt(s.started_at)} → ${dt(s.ended_at)}（${dur(s.started_at, s.ended_at)}${s.partial ? "，中途開始" : ""}）`
    );
    console.log(
      `在線 峰值 ${n(s.peak_viewers)} / 平均 ${n(Math.round(s.avg_viewers))}　` +
        `點讚 +${n(s.likes_end - s.likes_start)}　禮物 ${n(s.gift_diamonds)} 鑽 / ${n(s.gift_events)} 次`
    );
    console.log(
      `聊天 ${n(s.chat_count)} 則（${n(s.chat_users)} 人）　進場 ${n(s.member_count)}　快照 ${n(s.snapshot_count)} 筆`
    );
    const counts = Object.entries(d.event_counts ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(`事件：${counts || "—"}`);
    console.log("\n送禮 Top 10：");
    for (const [i, g] of (d.gift_top ?? []).entries()) {
      console.log(`  ${pad(i + 1)}. ${String(g.nickname || "匿名").slice(0, 16).padEnd(16)} ${n(g.d).padStart(10)} 鑽 / ${n(g.c)} 次`);
    }
    console.log("\n熱門禮物：");
    for (const g of (d.gift_names ?? []).slice(0, 8)) {
      console.log(`  ${String(g.gift_name || "（未知）").padEnd(10)} ${n(g.n).padStart(6)} 個 / ${n(g.d).padStart(9)} 鑽`);
    }
    if (d.fans) {
      console.log(
        `\n粉絲團：${d.fans.club_name ?? ""}（${d.fans.fans_name ?? ""}）活躍 ${n(d.fans.active)} / 總數 ${n(d.fans.total)} / 今日 +${n(d.fans.today_new)}`
      );
    }
    return;
  }

  if (cmd === "events") {
    const limit = Number(flag("limit", "50"));
    const type = flag("type", "");
    const q = flag("q", "");
    const params = new URLSearchParams({ limit: String(limit), offset: "0" });
    if (type) params.set("type", type);
    if (q) params.set("q", q);
    const d = await get(`/history/session/${sid}/events?${params}`, cookie);
    console.log(`事件 ${d.total} 筆（顯示 ${d.events.length}）`);
    for (const e of d.events) {
      const t = new Date(e.ts * 1000).toLocaleTimeString("zh-TW", { hour12: false });
      console.log(
        `  ${t}  ${String(e.type).padEnd(6)} ${String(e.nickname ?? "").slice(0, 14).padEnd(14)} ` +
          `${String(e.content ?? "").slice(0, 40)}${e.diamonds ? `  (${n(e.diamonds)} 鑽)` : ""}`
      );
    }
    return;
  }

  die(`未知指令：${cmd}（可用 list / show / events）`);
}

main().catch((e) => die(`執行失敗：${e.message}`));
