// =====================================================================
//  SQLite 每日備份（vault.db + dy-monitor.db）
//  - 用 better-sqlite3 的線上 backup API（WAL 模式下安全，不需停服務）
//  - 保留最近 KEEP 份（每個 DB 各自輪替）
//  用法：node scripts/backup-dbs.mjs [appDir] [destDir]
//       預設 appDir=/www/wwwroot/lucy-site  destDir=/root/backups/lucy-site
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const appDir = process.argv[2] ?? "/www/wwwroot/lucy-site";
// 腳本放在 app 目錄外（/root/scripts），用 app 的 node_modules 解析 better-sqlite3
const require = createRequire(path.join(appDir, "package.json"));
const Database = require("better-sqlite3");
const destDir = process.argv[3] ?? "/root/backups/lucy-site";
const KEEP = Number(process.env.BACKUP_KEEP ?? 7);

const DB_FILES = ["vault.db", "dy-monitor.db"];

fs.mkdirSync(destDir, { recursive: true });
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+/, "")
  .replace("T", "-");

let failed = 0;
for (const file of DB_FILES) {
  const src = path.join(appDir, "data", file);
  if (!fs.existsSync(src)) {
    console.log(`skip ${file}（不存在）`);
    continue;
  }
  const base = file.replace(/\.db$/, "");
  const dest = path.join(destDir, `${base}-${stamp}.db`);
  try {
    const db = new Database(src, { readonly: true });
    await db.backup(dest);
    db.close();
    const size = (fs.statSync(dest).size / 1048576).toFixed(2);
    console.log(`ok   ${file} → ${dest}（${size} MB）`);

    // 輪替：只留最近 KEEP 份
    const olds = fs
      .readdirSync(destDir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith(".db"))
      .map((f) => ({ f, t: fs.statSync(path.join(destDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(KEEP);
    for (const o of olds) fs.rmSync(path.join(destDir, o.f), { force: true });
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${file}: ${err.message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
