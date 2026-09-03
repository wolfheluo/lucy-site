// M-8 回歸測試（jsdom）：401 處理鏈兩條斷裂路徑
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// sfx mock（audio engine 在 jsdom 無 AudioContext）
vi.mock("../../../src/audio/engine", () => ({
  sfx: { click: vi.fn(), denied: vi.fn(), ping: vi.fn(), line: vi.fn() },
}));

import { VaultApi } from "../tools/file-vault/client/api";
import type { FileListItem, ShareInfo } from "../tools/file-vault/types";
import { vaultApi } from "../tools/file-vault/client/api";

// framer-motion 需要 matchMedia + IntersectionObserver（jsdom 缺）
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
  root = null;
  rootMargin = "";
  thresholds = [];
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

/** 假 XHR：立刻以指定 status 回應 */
function stubXhr(status: number, body: unknown) {
  class FakeXHR {
    static _last: FakeXHR;
    status = 0;
    responseText = "";
    upload = { onprogress: null as null | ((e: unknown) => void) };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    timeout = 0;
    responseType = "";
    open(_m: string, _u: string) {}
    send(_d?: unknown) {
      FakeXHR._last = this;
      this.status = status;
      this.responseText = JSON.stringify(body);
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  return FakeXHR;
}

const shareInfo: ShareInfo = { shareId: "abcd", pin: "1234", createdAt: 0 };

function makeFile(over: Partial<FileListItem> = {}): FileListItem {
  return {
    id: "f1",
    originalName: "t.txt",
    size: 3,
    uploadTime: 0,
    expireTime: 999999999,
    share: shareInfo,
    ...over,
  };
}

describe("M-8 上傳 XHR 錯誤帶 status", () => {
  it("HTTP 401 → reject 的 ApiError.status === 401（doUpload 的 401 分支不再死碼）", async () => {
    stubXhr(401, { ok: false, error: "未授權" });
    const api = new VaultApi();
    const file = new File(["x"], "a.txt");
    await expect(api.upload([file])).rejects.toMatchObject({ status: 401 });
  });
});

describe("M-8 ShareModal revoke 401 → onUnauthorized", () => {
  it("revoke 收到 401 → 呼叫 onUnauthorized（回鎖定畫面）而非 unhandled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const err = new Error("未授權") as Error & { status: number };
    err.status = 401;
    vi.spyOn(vaultApi, "revoke").mockRejectedValueOnce(err);

    const onUnauthorized = vi.fn();
    const onClose = vi.fn();
    const onRevoked = vi.fn();

    const { ShareModal } = await import("../tools/file-vault/client/VaultUI");
    render(
      <ShareModal
        file={makeFile()}
        rm={false}
        onClose={onClose}
        onRevoked={onRevoked}
        onUnauthorized={onUnauthorized}
      />
    );

    // 找撤銷按鈕（text 含 revoke / 撤銷）
    const btn = screen.getAllByRole("button").find((b) => /撤銷|REVOKE/i.test(b.textContent ?? ""));
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
