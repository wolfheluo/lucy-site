// MatrixDecode 矩陣掃描解密測試（nav 餘額矩陣版）
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import MatrixDecode from "../src/components/MatrixDecode";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 完整播放 ≈ 5×130 + 260 + 380 ≈ 1.3s → 等 2.2s */
const PLAY_WAIT = 2200;

describe("MatrixDecode 矩陣掃描解密", () => {
  it("instant：直接顯示數字", () => {
    const { container } = render(<MatrixDecode text="12.90" instant />);
    expect(container.querySelector(".md")?.getAttribute("aria-label")).toBe("12.90");
    expect(container.querySelector(".md-value")?.textContent).toBe("12.90");
  });

  it("start=false：idle 佔位（未掃描、不洩露數字）", () => {
    const { container } = render(<MatrixDecode text="12.90" start={false} />);
    expect(container.querySelector(".md-value")).toBeNull();
    expect(container.querySelector(".md-idle")).not.toBeNull();
    expect(container.querySelector(".md-matrix")).toBeNull();
  });

  it("start=true：掃描播放 → 完成後數字原位顯示", async () => {
    const { container } = render(<MatrixDecode text="12.90" start />);
    // 播放中：矩陣浮層存在
    expect(container.querySelector(".md-matrix")).not.toBeNull();
    await sleep(PLAY_WAIT);
    expect(container.querySelector(".md-value")?.textContent).toBe("12.90");
    expect(container.querySelector(".md-matrix")).toBeNull();
  });

  it("text 變更 → 重掃 → 新值", async () => {
    const { container, rerender } = render(<MatrixDecode text="12.90" start />);
    await sleep(PLAY_WAIT);
    expect(container.querySelector(".md-value")?.textContent).toBe("12.90");
    rerender(<MatrixDecode text="11.88" start />);
    expect(container.querySelector(".md-matrix")).not.toBeNull(); // 重掃中
    await sleep(PLAY_WAIT);
    expect(container.querySelector(".md-value")?.textContent).toBe("11.88");
  });

  it("hover 重播：完成後 mouseEnter → 矩陣再現 → 回到數字", async () => {
    const { container } = render(<MatrixDecode text="12.90" start hover />);
    await sleep(PLAY_WAIT);
    expect(container.querySelector(".md-value")?.textContent).toBe("12.90");
    fireEvent.mouseEnter(container.querySelector(".md")!);
    expect(container.querySelector(".md-matrix")).not.toBeNull();
    await sleep(PLAY_WAIT);
    expect(container.querySelector(".md-value")?.textContent).toBe("12.90");
  });

  it("reduced-motion（instant）text 變更：直接換值", () => {
    const { container, rerender } = render(<MatrixDecode text="12.90" instant />);
    rerender(<MatrixDecode text="11.88" instant />);
    expect(container.querySelector(".md-value")?.textContent).toBe("11.88");
  });
});
