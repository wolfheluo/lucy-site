// BreachBuffer 逐格鎖定測試（Breach Protocol 風格餘額元件）
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import BreachBuffer from "../src/components/BreachBuffer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cellText(container: HTMLElement): string {
  return [...container.querySelectorAll(".bp-cell")].map((c) => c.textContent).join("");
}

describe("BreachBuffer 逐格鎖定", () => {
  it("instant：直接顯示最終數字（無等待）", () => {
    const { container } = render(<BreachBuffer text="12.90" instant />);
    expect(container.querySelector(".bp")?.getAttribute("aria-label")).toBe("12.90");
    expect(cellText(container)).toBe("12.90");
  });

  it("start=false：空格占位等待（未破解）", () => {
    const { container } = render(<BreachBuffer text="12.90" start={false} />);
    // 小數點格恆顯示 '.'；數字格全空（未鎖定 → 不洩露最終值）
    expect(cellText(container)).toBe(".");
    expect(container.querySelectorAll(".bp-cell.locked").length).toBe(0);
  });

  it("start=true：逐格鎖定 → 完成顯示最終數字", async () => {
    const { container } = render(<BreachBuffer text="12.90" start />);
    // 首幀後非最終（亂碼輪播中）
    expect(cellText(container)).not.toBe("12.90");
    await sleep(1200); // 5 格 × 150ms + 餘裕
    expect(cellText(container)).toBe("12.90");
    // 全部鎖定 → locked class
    const locked = container.querySelectorAll(".bp-cell.locked").length;
    expect(locked).toBe(4); // 數字 4 格（不含小數點）
  });

  it("text 變更（值變）→ 重破解 → 新值", async () => {
    const { container, rerender } = render(<BreachBuffer text="12.90" start />);
    await sleep(1200);
    expect(cellText(container)).toBe("12.90");
    rerender(<BreachBuffer text="11.88" start />);
    expect(cellText(container)).not.toBe("11.88"); // 重播中
    await sleep(1200);
    expect(cellText(container)).toBe("11.88");
  });

  it("hover 重播：完成後 mouseEnter 再破解一輪仍顯示正確值", async () => {
    const { container } = render(<BreachBuffer text="12.90" start hover />);
    await sleep(1200);
    expect(cellText(container)).toBe("12.90");
    fireEvent.mouseEnter(container.querySelector(".bp")!);
    await sleep(1200);
    expect(cellText(container)).toBe("12.90");
  });

  it("reduced-motion（instant）text 變更：直接換值、無重播等待", () => {
    const { container, rerender } = render(<BreachBuffer text="12.90" instant />);
    rerender(<BreachBuffer text="11.88" instant />);
    expect(cellText(container)).toBe("11.88");
  });
});
