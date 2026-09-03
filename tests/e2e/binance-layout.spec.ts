// =====================================================================
//  BINANCE QUANT 全貌鎖高 e2e（BQ_DEMO=1 假行情下驗證版面）
//  - 寬版（>980px）：整頁零滾動（scrollHeight ≤ innerHeight）＋六區全見
//  - 窄版（≤980px）：單欄自然滾動、無橫向溢出、tape（第六區）存在
//  - 依賴 playwright webServer 的 BQ_DEMO=1（見 playwright.config.ts）
// =====================================================================
import { test, expect, type Page } from "@playwright/test";

const SECTIONS = [
  ".bq-radar",
  ".bq-account",
  ".bq-matrix",
  ".bq-ledger",
  ".bq-trend",
  ".bq-trades",
];

interface RectInfo {
  top: number;
  bottom: number;
  height: number;
  width: number;
}

interface LayoutInfo {
  scrollH: number;
  innerH: number;
  scrollW: number;
  innerW: number;
  rects: (RectInfo | null)[];
}

async function measureLayout(page: Page): Promise<LayoutInfo> {
  return page.evaluate((sels: string[]) => {
    const rects = sels.map((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
    });
    const de = document.documentElement;
    return {
      scrollH: de.scrollHeight,
      innerH: window.innerHeight,
      scrollW: de.scrollWidth,
      innerW: window.innerWidth,
      rects,
    };
  }, SECTIONS);
}

/** 等引擎 state 流入（六區 render） */
async function openDashboard(page: Page): Promise<void> {
  await page.goto("/tools/binance-api");
  await expect(page.locator(".bq-grid")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(900); // 等 SSE 首波 + canvas rAF 穩定
}

test.describe("BINANCE QUANT 全貌鎖高", () => {
  const wide = [
    { w: 1920, h: 1080 },
    { w: 1536, h: 864 },
    { w: 1366, h: 768 },
    { w: 1280, h: 720 },
  ];

  for (const vp of wide) {
    test(`寬版 ${vp.w}×${vp.h}：整頁零滾動、六區皆在視窗內`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await openDashboard(page);

      const m = await measureLayout(page);

      // 整頁零滾動（tool-shell--lock 100dvh overflow hidden）
      expect(m.scrollH, `scrollHeight ${m.scrollH} 不得超過 innerHeight ${m.innerH}`).toBeLessThanOrEqual(
        m.innerH
      );
      expect(m.scrollW, "寬版不得橫向溢出").toBeLessThanOrEqual(m.innerW);

      for (let i = 0; i < SECTIONS.length; i += 1) {
        const r = m.rects[i];
        expect(r, `${SECTIONS[i]} 應存在於版面`).not.toBeNull();
        expect(r!.height, `${SECTIONS[i]} 高度應大於 40px（未被裁平）`).toBeGreaterThan(40);
        expect(r!.bottom, `${SECTIONS[i]} 底部 ${r!.bottom} 應在視窗 ${m.innerH} 內（未被裁切）`).toBeLessThanOrEqual(
          m.innerH
        );
        expect(r!.top, `${SECTIONS[i]} 頂部 ${r!.top} 應 ≥ 0`).toBeGreaterThanOrEqual(0);
      }
    });
  }

  const narrow = [
    { w: 390, h: 844 },
    { w: 768, h: 1024 },
  ];

  for (const vp of narrow) {
    test(`窄版 ${vp.w}×${vp.h}：單欄堆疊、無橫向溢出、tape 在堆疊最底`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await openDashboard(page);

      const m = await measureLayout(page);

      // 無橫向溢出（單欄自然滾動可接受垂直滾動）
      expect(m.scrollW, `scrollWidth ${m.scrollW} 不得超過 innerWidth ${m.innerW}`).toBeLessThanOrEqual(
        m.innerW
      );

      for (let i = 0; i < SECTIONS.length; i += 1) {
        const r = m.rects[i];
        expect(r, `${SECTIONS[i]} 應存在於版面（tape 窄版不得消失）`).not.toBeNull();
        expect(r!.height, `${SECTIONS[i]} 高度應大於 40px`).toBeGreaterThan(40);
      }

      // tape（.bq-trades，最後一區）在堆疊最底
      const rects = m.rects.filter((r): r is RectInfo => r !== null);
      const trades = rects[rects.length - 1];
      const maxBottom = Math.max(...rects.map((r) => r.bottom));
      expect(trades.bottom, "tape 應為單欄堆疊最底一區").toBeGreaterThanOrEqual(maxBottom - 2);
    });
  }
});
