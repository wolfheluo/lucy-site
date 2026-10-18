// =====================================================================
//  dy-monitor 歷史頁 UI 驗證（P3）：列表 → 單場詳情 → 事件篩選/搜尋
//  用法：node scripts/dy-history-ui-check.mjs [baseUrl] [password]
// =====================================================================
import { chromium } from "@playwright/test";

// 每次執行用不同來源 IP，避免 login rate-limit（5 次/15 分）
const RANDOM_IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

const base = process.argv[2] ?? "http://127.0.0.1:3911";
const password = process.argv[3] ?? "local-test-pass";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// 先登入（API），再用 cookie 開頁面
await page.request.post(`${base}/api/auth/login`, {
  data: { password },
  headers: { "content-type": "application/json", "x-forwarded-for": RANDOM_IP },
});

await page.goto(`${base}/tools/dy-monitor/history`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dym-h-table tbody tr", { timeout: 20000 });
await page.waitForTimeout(500);

const list = await page.evaluate(() => ({
  rows: document.querySelectorAll(".dym-h-table tbody tr").length,
  headers: Array.from(document.querySelectorAll(".dym-h-table th")).map((e) => e.textContent?.trim()),
  firstRow: Array.from(document.querySelectorAll(".dym-h-table tbody tr:first-child td")).map((e) =>
    e.textContent?.trim()
  ),
  title: document.title,
}));
await page.screenshot({ path: "/tmp/dy-history-list.png" });

// 點第一列 → 詳情
await page.click(".dym-h-table tbody tr:first-child");
await page.waitForSelector(".dym-kpis", { timeout: 20000 });
await page.waitForTimeout(700);
const detail = await page.evaluate(() => ({
  url: location.pathname,
  kpis: Array.from(document.querySelectorAll(".dym-kpi")).map((el) => ({
    label: el.querySelector(".dym-kpi-label")?.textContent?.trim(),
    value: el.querySelector(".dym-kpi-value")?.textContent?.trim(),
  })),
  panels: Array.from(document.querySelectorAll(".dym-panel-head span:first-child")).map((e) =>
    e.textContent?.trim()
  ),
  eventRows: document.querySelectorAll(".dym-h-events tbody tr").length,
  chartPoints: (document.querySelector(".dym-svg polyline")?.getAttribute("points") ?? "").split(" ")
    .length,
}));
await page.screenshot({ path: "/tmp/dy-history-session.png" });

// 事件篩選（Gift）
const giftBtn = page.locator(".dym-filters .dym-chip", { hasText: "Gift" }).first();
await giftBtn.click();
await page.waitForTimeout(800);
const filtered = await page.evaluate(() => ({
  rows: document.querySelectorAll(".dym-h-events tbody tr").length,
  types: Array.from(document.querySelectorAll(".dym-h-events tbody tr td:nth-child(2)")).map((e) =>
    e.textContent?.trim()
  ),
}));

// 搜尋
await page.fill(".dym-search input", "小心心");
await page.click(".dym-search button");
await page.waitForTimeout(900);
const search = await page.evaluate(() => ({
  rows: document.querySelectorAll(".dym-h-events tbody tr").length,
  firstContent: document.querySelector(".dym-h-events tbody tr td:nth-child(4)")?.textContent?.trim(),
}));

// 手機版列表
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const mp = await mobile.newPage();
await mp.request.post(`${base}/api/auth/login`, {
  data: { password },
  headers: { "content-type": "application/json", "x-forwarded-for": RANDOM_IP },
});
await mp.goto(`${base}/tools/dy-monitor/history`, { waitUntil: "domcontentloaded" });
await mp.waitForSelector(".dym-h-table tbody tr", { timeout: 20000 });
const mobileDims = await mp.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth,
}));

console.log(JSON.stringify({ list, detail, filtered, search, mobile: mobileDims, errors }, null, 1));
await browser.close();
