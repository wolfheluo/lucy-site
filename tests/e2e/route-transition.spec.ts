// RouteTransition 黑屏防回歸（2026-09 修復）
//  進入工具頁的深潛過場 overlay 必須保證移除——碎裂 animationend / timeout 兜底 / state unmount，
//  任何情況不得殘留黑幕（舊版 framer exit 卡住 → 黑屏需 refresh）
import { test, expect } from "@playwright/test";

test.describe("RouteTransition 過場 overlay 必消失（黑屏防回歸）", () => {
  test("動畫模式（no-preference）：點 FILE VAULT 卡 → 過場 overlay 出現後必定移除", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    await page.goto("/");
    const card = page.locator('a[href="/tools/file-vault"]').first();
    await expect(card).toBeVisible({ timeout: 20_000 }); // 等主站 boot 結束
    await card.click();
    await expect(page).toHaveURL(/\/tools\/file-vault/, { timeout: 10_000 });
    await expect(page.locator(".route-boot")).toHaveCount(1, { timeout: 5_000 });
    // 碎裂（0.42s）/ 節流 / timeout 兜底（900ms）後必須移除——不得殘留黑幕
    await expect(page.locator(".route-boot")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".tool-body")).toBeVisible({ timeout: 15_000 });
    await ctx.close();
  });

  test("reduced-motion：直接導航，overlay 不殘留", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    const card = page.locator('a[href="/tools/file-vault"]').first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    await expect(page).toHaveURL(/\/tools\/file-vault/, { timeout: 10_000 });
    await expect(page.locator(".route-boot")).toHaveCount(0, { timeout: 5_000 });
    await ctx.close();
  });
});
