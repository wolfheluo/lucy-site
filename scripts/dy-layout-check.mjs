// =====================================================================
//  dy-monitor 版面驗證（原版 3×2 鎖高）：1440×900 / 1180×800 / 390×844
//  用法：node scripts/dy-layout-check.mjs [baseUrl] [password]
// =====================================================================
import { chromium } from "@playwright/test";

// 每次執行用不同來源 IP，避免 login rate-limit（5 次/15 分）
const RANDOM_IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

const base = process.argv[2] ?? "http://127.0.0.1:3911";
const password = process.argv[3] ?? "local-test-pass";

const browser = await chromium.launch();
const errors = [];
const results = {};

async function check(name, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: !!opts.mobile });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${name}: pageerror ${e.message}`));
  // DY_COOKIE 可直接帶既有 session（避免反覆登入觸發 5/15min 限制）
  if (process.env.DY_COOKIE) {
    await ctx.setExtraHTTPHeaders({ cookie: process.env.DY_COOKIE });
  } else {
    await ctx.request.post(`${base}/api/auth/login`, {
      data: { password },
      headers: { "content-type": "application/json", "x-forwarded-for": RANDOM_IP },
    });
  }
  await page.goto(`${base}/tools/dy-monitor`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dym-cards", { timeout: 25000 });
  await page.waitForTimeout(3500);

  const info = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const cards = Array.from(document.querySelectorAll(".dym-card")).map((el) => ({
      label: el.querySelector("h3")?.textContent?.trim(),
      value: el.querySelector(".val")?.textContent?.trim(),
      sub: el.querySelector(".sub")?.textContent?.trim(),
    }));
    return {
      cards,
      areas: {
        chart: rect(".dym-p-chart"),
        rank: rect(".dym-p-rank"),
        chat: rect(".dym-p-chat"),
        fans: rect(".dym-p-fans"),
        gifters: rect(".dym-p-gifters"),
      },
      docH: document.documentElement.scrollHeight,
      docW: document.documentElement.scrollWidth,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      chatRows: document.querySelectorAll(".dym-crow").length,
      chatTags: Array.from(new Set(Array.from(document.querySelectorAll(".dym-tag")).map((e) => e.textContent?.trim()))),
      rankRows: document.querySelectorAll(".dym-p-rank tbody tr").length,
      fanRows: document.querySelectorAll(".dym-p-fans tbody tr").length,
      gifterRows: document.querySelectorAll(".dym-p-gifters tbody tr").length,
      chartPts: (document.querySelector(".dym-svg polyline")?.getAttribute("points") ?? "").split(" ").length,
      foot: document.querySelector(".dym-foot")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 140),
      statusPill: document.querySelector(".dym-status")?.textContent?.trim(),
      cardsCols: getComputedStyle(document.querySelector(".dym-cards")).gridTemplateColumns.split(" ").length,
      mainCols: getComputedStyle(document.querySelector(".dym-main")).gridTemplateColumns.split(" ").length,
    };
  });
  await page.screenshot({ path: `/tmp/dy-layout-${name}.png`, fullPage: false });
  results[name] = info;
  await ctx.close();
}

await check("1440", { width: 1440, height: 900 });
await check("1180", { width: 1180, height: 800 });
await check("390", { width: 390, height: 844 }, { mobile: true });

console.log(JSON.stringify({ results, errors }, null, 1));
await browser.close();
