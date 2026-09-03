// =====================================================================
//  請求來源 IP 解析（單一來源，server/index 與 tools router 共用）
//  - trustProxy=true（位於可信代理之後）：
//      a) 優先採用 CF-Connecting-IP —— Cloudflare 保證覆寫、客戶端
//         無法偽造，是 CF 架構下的真實訪客 IP（C-1 修補）
//      b) 無 CF 時退回 X-Forwarded-For「最後一個」值 —— 最後一跳代理
//         附加的真實來源；最左值為客戶端可控（XFF 是附加語意）不可信
//  - trustProxy=false：一律用 TCP 連線位址（H3：防 XFF 偽造繞過 rate limit）
// =====================================================================
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = c.req.header("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
  }
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
