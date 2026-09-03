// =====================================================================
//  請求來源 IP 解析（單一來源，server/index 與 tools router 共用）
//  - trustProxy=true：信任 X-Forwarded-For（僅限 node 位於可信 nginx 之後）
//  - trustProxy=false：一律用 TCP 連線位址（H3：防 XFF 偽造繞過 rate limit）
// =====================================================================
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  try {
    const info = getConnInfo(c);
    return info.remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
