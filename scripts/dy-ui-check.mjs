// =====================================================================
//  dy-monitor UI 驗證（本地）：登入牆 → 儀表板 → 截圖 → console 錯誤
//  用法：node scripts/dy-ui-check.mjs [baseUrl] [password]
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

await page.goto(`${base}/tools/dy-monitor`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dym-lock-panel, .dym", { timeout: 20000 });
const locked = await page.locator(".dym-lock-panel").count();
console.log("鎖定畫面:", locked === 1 ? "OK" : "MISSING");

if (locked) {
  await page.fill(".dym-lock-panel input", password);
  await page.click(".dym-lock-panel button[type=submit]");
}
await page.waitForSelector(".dym-kpis", { timeout: 25000 });
await page.waitForTimeout(4500); // 等兩輪輪詢

const info = await page.evaluate(() => {
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
  const kpis = Array.from(document.querySelectorAll(".dym-kpi")).map((el) => ({
    label: el.querySelector(".dym-kpi-label")?.textContent?.trim(),
    value: el.querySelector(".dym-kpi-value")?.textContent?.trim(),
  }));
  return {
    title: document.title,
    live: txt(".dym-live"),
    anchor: txt(".dym-anchor"),
    kpis,
    panels: Array.from(document.querySelectorAll(".dym-panel-head span:first-child")).map((e) => e.textContent?.trim()),
    chatRows: document.querySelectorAll(".dym-chat-row").length,
    rankRows: document.querySelectorAll(".dym-rank-row").length,
    chartPoints: (document.querySelector(".dym-svg polyline")?.getAttribute("points") ?? "").split(" ").length,
    dims: {
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    },
    gridCenter: (() => {
      const g = document.querySelector(".dym-grid");
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { center: Math.round(r.left + r.width / 2), viewportCenter: Math.round(window.innerWidth / 2) };
    })(),
  };
});

await page.screenshot({ path: "/tmp/dy-monitor-desktop.png", fullPage: false });

// 抽屜
await page.click(".dym-head-right .dym-btn");
await page.waitForTimeout(600);
const drawer = await page.locator(".dym-drawer.is-open").count();
await page.screenshot({ path: "/tmp/dy-monitor-drawer.png" });

// 手機版
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const mp = await mobile.newPage();
await mp.goto(`${base}/tools/dy-monitor`, { waitUntil: "domcontentloaded" });
await mp.waitForSelector(".dym-lock-panel, .dym", { timeout: 20000 });
if (await mp.locator(".dym-lock-panel").count()) {
  await mp.fill(".dym-lock-panel input", password);
  await mp.click(".dym-lock-panel button[type=submit]");
}
await mp.waitForSelector(".dym-kpis", { timeout: 25000 });
await mp.waitForTimeout(2500);
const mobileDims = await mp.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth,
  cols: getComputedStyle(document.querySelector(".dym-grid")).gridTemplateColumns,
}));
await mp.screenshot({ path: "/tmp/dy-monitor-mobile.png", fullPage: false });

console.log(JSON.stringify({ ...info, drawerOpen: drawer === 1, mobile: mobileDims, errors }, null, 1));
await browser.close();
