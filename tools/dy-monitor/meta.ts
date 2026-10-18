// =====================================================================
//  DOUYIN MONITOR // 抖音直播監控台 —— tool 純資料（無 side effect，雙端共用）
// =====================================================================
import type { ToolMeta, ToolProjectCard } from "../types.js";

export const dyMonitorMeta: ToolMeta = {
  id: "dy-monitor",
  title: "DOUYIN MONITOR",
  zhTitle: "抖音直播監控台",
};

export const dyMonitorProjectCard: ToolProjectCard = {
  title: "DOUYIN MONITOR",
  zh: "抖音直播監控台",
  desc: "以抖音 webcast 端點即時監控直播間：開播通知、在線人數曲線、彈幕與禮物貢獻榜、粉絲團親密度，並將每個場次寫入 SQLite 供離線複盤。",
  tags: ["Webcast API", "Hono", "SQLite", "React"],
};
