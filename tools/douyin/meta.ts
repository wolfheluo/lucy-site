// =====================================================================
//  DOUYIN LIVE — meta（純資料，client / server 共用）
// =====================================================================
import type { ToolMeta, ToolProjectCard } from "../types.js";

export const douyinMeta: ToolMeta = {
  id: "douyin",
  title: "DOUYIN LIVE",
  zhTitle: "抖音直播",
};

export const douyinProjectCard: ToolProjectCard = {
  title: "DOUYIN LIVE",
  zh: "抖音直播監控",
  desc: "直播數據、進場名單與真名反查，一場直播的完整觀測站。",
  tags: ["Hono", "SQLite", "Webcast", "React"],
};
