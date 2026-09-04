// GlitchText re-decode on text change 測試（nav 餘額刷新場景）
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// sfx mock（audio engine 在 jsdom 無 AudioContext）；路徑與 import 一致才能攔截
vi.mock("../src/audio/engine", () => ({
  sfx: { decode: vi.fn(), click: vi.fn(), denied: vi.fn(), ping: vi.fn(), line: vi.fn() },
}));

import GlitchText from "../src/components/GlitchText";
import { sfx } from "../src/audio/engine";

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  // jsdom 內建 rAF callback 不帶 timestamp（decode loop 的 p 會 NaN 卡死）→ 強制覆寫
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 16)) as unknown as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) =>
    window.clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
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
  vi.mocked(sfx.decode).mockClear();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DECODE_MS = 950;

function decText(container: HTMLElement): string {
  return container.querySelector(".dec")?.textContent ?? "";
}

function glitching(container: HTMLElement): boolean {
  return container.querySelector(".glitch-box")?.classList.contains("glitching") ?? false;
}

describe("GlitchText 文字變更重播（餘額刷新解碼）", () => {
  it("初始 decode：start 後亂碼解碼 → 完成顯示最終文字", async () => {
    const { container } = render(<GlitchText text="12.34" start />);
    expect(glitching(container)).toBe(true); // 解碼中（jitter）
    await sleep(DECODE_MS + 250);
    expect(glitching(container)).toBe(false);
    expect(decText(container)).toBe("12.34");
  });

  it("text 變更 → 重新解碼（decode SFX 再播）→ 顯示新值", async () => {
    const { container, rerender } = render(<GlitchText text="12.34" start />);
    await sleep(DECODE_MS + 250);
    expect(decText(container)).toBe("12.34");
    const callsBefore = vi.mocked(sfx.decode).mock.calls.length;

    rerender(<GlitchText text="11.88" start />);
    expect(glitching(container)).toBe(true); // 重播中
    expect(vi.mocked(sfx.decode).mock.calls.length).toBe(callsBefore + 1);
    await sleep(DECODE_MS + 250);
    expect(decText(container)).toBe("11.88");
    expect(glitching(container)).toBe(false);
  });

  it("reduced-motion（instant）：直接顯示、text 變更也不解碼", () => {
    const { container, rerender } = render(<GlitchText text="12.34" instant />);
    expect(decText(container)).toBe("12.34");
    expect(glitching(container)).toBe(false);
    const callsBefore = vi.mocked(sfx.decode).mock.calls.length;
    rerender(<GlitchText text="11.88" instant />);
    expect(decText(container)).toBe("11.88");
    expect(glitching(container)).toBe(false);
    expect(vi.mocked(sfx.decode).mock.calls.length).toBe(callsBefore);
  });
});
