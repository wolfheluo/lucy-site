// =====================================================================
//  一次性匯入：Python 版 monitor.db → TS 版 dy-monitor.db
//  用法：npx tsx scripts/import-dy-monitor.mjs --from <python.db> --to <ts.db>
//
//  - 兩邊 schema 欄位順序不同（Python 用 ALTER 補欄位），因此逐欄列出
//  - 保留原 id（events/sessions 的 FK 是隱式的 session_id）
//  - 只複製資料表；meta 只帶 selected_web_rid
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const from = getArg("from", "");
const to = getArg("to", "");
if (!from || !to) {
  console.error("用法：npx tsx scripts/import-dy-monitor.mjs --from <python.db> --to <ts.db>");
  process.exit(1);
}
if (!fs.existsSync(from)) {
  console.error(`來源不存在：${from}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true });
const db = new Database(to);
db.pragma("journal_mode = WAL");

// 先建 schema：借用 TS 版的 store（會被立即關閉，只為了 schema）
const { DyMonitorStore } = await import("../tools/dy-monitor/server/store.ts");
const init = new DyMonitorStore(to, { log: () => {} });
init.stop();

db.prepare("ATTACH DATABASE ? AS src").run(from);

const TABLES = [
  {
    name: "sessions",
    cols: "id, web_rid, source, room_id, anchor_id, anchor_name, title, started_at, ended_at, last_seen_live_at, partial, likes_start, likes_end, peak_viewers, avg_viewers, total_user, gift_diamonds, gift_events, chat_count, chat_users, member_count, snapshot_count, flags",
  },
  {
    name: "events",
    cols: "id, session_id, ts, type, nickname, user_id, content, gift_id, gift_name, repeat, diamonds, msg_id, extra",
  },
  { name: "snapshots", cols: "id, session_id, ts, status, viewers, like_count, total_user" },
  { name: "rank_snapshots", cols: "id, session_id, ts, kind, rank, nickname, score, level, payload" },
  {
    name: "fans_snapshots",
    cols: "id, session_id, ts, club_name, fans_name, active, total, today_new, guard, members",
  },
  { name: "gift_catalog", cols: "gift_id, name, diamond, updated_at" },
  {
    name: "targets",
    cols: "web_rid, label, anchor_name, notify_live, notify_end, capture, cap_chat, cap_gift, cap_member, cap_snap, cap_rank, added_at, last_status, last_notify_at, last_checked_at",
  },
  { name: "notifications", cols: "id, ts, web_rid, kind, ok, error, text" },
];

const stats = {};
const tx = db.transaction(() => {
  for (const { name, cols } of TABLES) {
    // 來源可能缺欄位（非常舊的 DB）→ 用 COALESCE 補預設
    const srcCols = new Set(
      db.prepare(`PRAGMA src.table_info(${name})`).all().map((r) => r.name)
    );
    if (srcCols.size === 0) {
      stats[name] = 0;
      continue;
    }
    const select = cols
      .split(",")
      .map((c) => c.trim())
      .map((c) => {
        if (srcCols.has(c)) return c;
        if (c === "source") return "'app' AS source";
        if (c === "flags") return "NULL AS flags";
        if (c.startsWith("cap_")) return "1 AS " + c;
        return `NULL AS ${c}`;
      })
      .join(", ");
    const info = db
      .prepare(`INSERT OR IGNORE INTO main.${name} (${cols}) SELECT ${select} FROM src.${name}`)
      .run();
    stats[name] = info.changes;
  }
  const sel = db
    .prepare("SELECT value FROM src.meta WHERE key='selected_web_rid'")
    .get();
  if (sel?.value) {
    db.prepare("INSERT OR REPLACE INTO main.meta(key,value) VALUES('selected_web_rid',?)").run(
      sel.value
    );
  }
});
tx();

db.exec("DETACH DATABASE src");

console.log("匯入完成 →", to);
for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(18)} ${v}`);
const fileSize = ["", "-wal"].reduce((a, s) => {
  try {
    return a + fs.statSync(to + s).size;
  } catch {
    return a;
  }
}, 0);
console.log(`  檔案大小           ${(fileSize / 1048576).toFixed(1)} MB`);
db.close();
