// =====================================================================
//  DOUYIN ENTER LOG // 抖音進場名單 —— tool 純資料（無 side effect）
//  只做一件事：記錄「誰進過直播間」，並標註神秘人／疑似隱身
// =====================================================================
import type { ToolMeta, ToolProjectCard } from "../types.js";

export const dyEnterMeta: ToolMeta = {
  id: "dy-enter",
  title: "ENTER LOG",
  zhTitle: "抖音進場名單",
};

export const dyEnterProjectCard: ToolProjectCard = {
  title: "ENTER LOG",
  zh: "抖音進場名單",
  desc: "貼上直播間網址即開始記錄進場用戶（uid／抖音號／進場次數），並標註神秘人與疑似隱身；資料寫入獨立 SQLite，場次永久保留可切回。",
  tags: ["Webcast API", "Hono", "SQLite", "React"],
};
