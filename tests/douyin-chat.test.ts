// =====================================================================
//  im/fetch 必須先簽名（未簽名回空 body，2026-11 實測）
// =====================================================================
import { describe, it, expect } from "vitest";
import { DyClient } from "../tools/douyin/server/dycore.js";
import type { AbogusSigner } from "../tools/douyin/server/signer.js";

const signer = {
  ready: true,
  generate: () => ({ ok: true, aBogus: "SIG123", userAgent: "UA-signed" }),
} as unknown as AbogusSigner;

describe("fetchChat 簽名", () => {
  it("第一次請求帶 a_bogus，空 body 才退回未簽名", async () => {
    const urls: string[] = [];
    const client = new DyClient({
      cookieHeader: "sessionid=test",
      signer,
      retries: 1,
      fetchImpl: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(new Uint8Array(0), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await expect(client.fetchChat("7711643363811920674")).rejects.toThrow();

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/webcast/im/fetch/");
    expect(urls[0]).toContain("a_bogus=SIG123");
    expect(urls[0]).toContain("room_id=7711643363811920674");
    expect(urls[1]).not.toContain("a_bogus=");
  });
});
