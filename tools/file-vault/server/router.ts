// =====================================================================
//  FILE VAULT 後端路由（P2 實作完整 API）
//  註冊位置：
//    /api/tools/file-vault/*  管理 API（requireAuth）
//    /s/*                     公開分享頁（無需登入）
// =====================================================================
import { Hono } from "hono";
import type { ServerToolContext } from "../../types.js";

export function registerFileVault(app: Hono, ctx: ServerToolContext): void {
  void app;
  void ctx; // P2 實作
}
