// =====================================================================
//  Server tool registry：新 tool 在此加一行 { meta, register }
// =====================================================================
import type { Hono } from "hono";
import type {
  ServerToolContext,
  ServerToolHandle,
  ServerToolModule,
} from "../tools/types.js";
import { fileVaultMeta } from "../tools/file-vault/meta.js";
import { registerFileVault } from "../tools/file-vault/server/router.js";
import { binanceApiMeta } from "../tools/binance-api/meta.js";
import { registerBinanceApi } from "../tools/binance-api/server/router.js";

export const SERVER_TOOLS: ServerToolModule[] = [
  { meta: fileVaultMeta, register: registerFileVault },
  { meta: binanceApiMeta, register: registerBinanceApi },
];

/** 依序讓每個 tool 把自己的路由掛到 app；收集各 tool 的生命週期 handle */
export function mountTools(
  app: Hono,
  ctx: ServerToolContext
): Record<string, ServerToolHandle> {
  const handles: Record<string, ServerToolHandle> = {};
  for (const tool of SERVER_TOOLS) {
    const handle = tool.register(app, ctx);
    if (handle) handles[tool.meta.id] = handle;
  }
  return handles;
}
