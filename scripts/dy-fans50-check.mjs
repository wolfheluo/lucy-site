// 驗證：親密度榜渲染 50 列（以偽造的 /api/state 注入 60 名成員）
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const password = process.argv[3] ?? "local-test-pass";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.request.post(`${base}/api/auth/login`, {
  data: { password },
  headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.201" },
});

const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message)));

// 先拿一份真實 state 當底，再塞 60 名粉絲團成員
const real = await (await ctx.request.get(`${base}/api/tools/dy-monitor/state?since=0`)).json();
const members = Array.from({ length: 60 }, (_, i) => ({
  nickname: `粉絲${String(i + 1).padStart(2, "0")}`,
  intimacy: 100000 - i * 1000,
  level: 20 - (i % 20),
}));
real.fans = { club_name: "測試團", fans_name: "團員", active: 12, total: 3456, members };
real.fans_ok = true;

await page.route("**/api/tools/dy-monitor/state*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(real) })
);

await page.goto(`${base}/tools/dy-monitor`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dym-p-fans tbody tr", { timeout: 30000 });
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll(".dym-p-fans tbody tr"));
  const wrap = document.querySelector(".dym-p-fans .dym-tablewrap");
  const ranks = rows.map((r) => r.querySelector("td")?.textContent?.trim());
  return {
    rows: rows.length,
    firstRank: ranks[0],
    lastRank: ranks[ranks.length - 1],
    firstNick: rows[0]?.children[1]?.textContent?.trim(),
    lastNick: rows[rows.length - 1]?.children[1]?.textContent?.trim(),
    scrollable: wrap ? wrap.scrollHeight > wrap.clientHeight : null,
    wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : null,
    wrapScrollH: wrap ? wrap.scrollHeight : null,
    docH: document.documentElement.scrollHeight,
    innerH: innerHeight,
  };
});
await page.screenshot({ path: "/tmp/dym-fans-50.png" });
console.log(JSON.stringify({ ...info, errs }, null, 1));
await browser.close();
