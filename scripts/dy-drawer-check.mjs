// 抽屜不遮頂欄 + 輸入列單行 的版面驗證
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const password = process.argv[3] ?? "local-test-pass";

const browser = await chromium.launch();
const out = {};

async function check(name, viewport, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile });
  const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  await ctx.request.post(`${base}/api/auth/login`, {
    data: { password },
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message)));
  await page.goto(`${base}/tools/dy-monitor`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dym-cards", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.click(".dym-btn:has-text('監控清單')");
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const mask = document.querySelector(".dym-mask");
    const drawer = document.querySelector(".dym-drawer");
    return {
      vw: innerWidth,
      vh: innerHeight,
      topbar: rect(".dym-topbar"),
      drawer: rect(".dym-drawer"),
      mask: rect(".dym-mask"),
      formTop: Math.round(document.querySelector(".dym-roomform--drawer").getBoundingClientRect().top),
      input: rect(".dym-roomform--drawer input"),
      btn: rect(".dym-roomform--drawer button"),
      drawerInlineTop: drawer.style.top,
      maskInlineTop: mask.style.top,
      drawerOpen: drawer.classList.contains("is-open"),
      hintFs: getComputedStyle(document.querySelector(".dym-drawer-hint")).fontSize,
      docH: document.documentElement.scrollHeight,
      innerH: innerHeight,
      rows: document.querySelectorAll(".dym-trow").length,
    };
  });
  await page.screenshot({ path: `/tmp/dym-drawer-${name}.png` });
  out[name] = { ...info, errs };
  await ctx.close();
}

await check("1440", { width: 1440, height: 900 });
await check("1180", { width: 1180, height: 800 });
await check("390", { width: 390, height: 844 }, true);
console.log(JSON.stringify(out, null, 1));
await browser.close();
