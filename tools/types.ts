// =====================================================================
//  tools 契約（純型別，client / server 共用）
//
//  新增一個 tool 的步驟（詳見 tools/README.md）：
//    1. tools/<id>/meta.ts       —— 純資料：id / 標題 / 作品卡
//    2. tools/<id>/server/       —— 後端：register(app, ctx) 掛 Hono 路由
//    3. tools/<id>/client/       —— 前端：React 頁面元件
//    4. server/registry.ts       —— 加一行 { meta, register }
//    5. src/tools.ts             —— 加一行 { meta, Component }
//
//  ⚠️ 本檔只能有 type-only import（編譯後全被 erase），
//      client bundle 才不會誤拉 node 依賴。
// =====================================================================
import type { Hono } from "hono";
import type Database from "better-sqlite3";

/** tool 基本資料（無任何 runtime 依賴，client/server 皆可 import） */
export interface ToolMeta {
  /** URL-safe id，如 "file-vault"；前端 route 為 /tools/<id> */
  id: string;
  /** 英文標題（HUD/工具殼顯示） */
  title: string;
  /** 中文標題 */
  zhTitle: string;
}

/** 出現在作品集 Projects 區的卡片資料（選用：不給就不上作品欄） */
export interface ToolProjectCard {
  title: string;
  zh: string;
  desc: string;
  tags: string[];
}

/** server 端共用上下文（createApp 時建立，傳給每個 tool） */
export interface ServerToolContext {
  /** 共享 SQLite（含 rate_limits 等通用表） */
  db: Database.Database;
  /** 全域資料目錄（data/） */
  dataDir: string;
  /** 管理密碼（env） */
  adminPassword: string;
  /** HMAC 簽名密鑰（session cookie 用） */
  sessionSecret: string;
}

export interface ServerToolModule {
  meta: ToolMeta;
  /** 自行將路由掛到 app（可掛多前綴，例如 /api/tools/<id> 與 /s） */
  register: (app: Hono, ctx: ServerToolContext) => void;
}
