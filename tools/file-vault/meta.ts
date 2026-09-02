// =====================================================================
//  FILE VAULT // 檔案保險箱 —— tool 純資料（無 side effect，雙端共用）
// =====================================================================
import type { ToolMeta, ToolProjectCard } from "../types.js";

export const fileVaultMeta: ToolMeta = {
  id: "file-vault",
  title: "FILE VAULT",
  zhTitle: "檔案保險箱",
};

export const fileVaultProjectCard: ToolProjectCard = {
  title: "FILE VAULT",
  zh: "檔案保險箱",
  desc: "自毀式檔案分享系統：上傳的每個檔案 72 小時後自動湮滅，以 PIN 鎖定分享連結，不留痕跡。",
  tags: ["Hono", "SQLite", "React"],
};
