// 一次性驗證：分享頁錯 pin 3 次 → 能量封鎖 UI + 倒數
const { chromium } = require("playwright");

(async () => {
  const base = "http://127.0.0.1:3998";
  // 建分享：login → upload → share
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-pass" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const buf = Buffer.from("LOCK-TEST-CONTENT");
  const fd = new FormData();
  fd.append("file", new Blob([buf]), "lock-test.txt");
  const up = await fetch(base + "/api/tools/file-vault/upload", {
    method: "POST",
    headers: { cookie },
    body: fd,
  });
  const upJson = await up.json();
  const fileId = upJson.files[0].file.id;
  const shareRes = await fetch(base + "/api/tools/file-vault/share/" + fileId, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const share = (await shareRes.json()).share;
  console.log("share:", share.shareId, "pin:", share.pin);

  const browser = await chromium.launch({ args: ["--force-prefers-reduced-motion=no-preference"] });
  const page = await browser.newPage();
  await page.goto(base + "/s/" + share.shareId, { waitUntil: "networkidle" });

  // 錯 pin 3 次（第 3 次回應 = 鎖定頁 429）
  for (let i = 1; i <= 3; i++) {
    await page.fill("#pin", "0000");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }).catch(() => {}),
      page.click("button[type=submit]"),
    ]);
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => ({
      url: location.pathname,
      locked: document.body.classList.contains("locked"),
      denied: document.body.classList.contains("denied"),
      disabled: document.querySelector("#pin")?.disabled,
      err: document.querySelector(".err")?.textContent?.trim().slice(0, 30),
      cd: document.getElementById("lockcd")?.textContent ?? null,
      until: document.body.getAttribute("data-lock-until"),
    }));
    console.log(`#${i} 錯 pin →`, JSON.stringify(st));
  }

  // 倒數驗證：等 2.5s 數字應下降
  const cd1 = await page.evaluate(() => document.getElementById("lockcd")?.textContent);
  await page.waitForTimeout(2500);
  const cd2 = await page.evaluate(() => document.getElementById("lockcd")?.textContent);
  console.log("倒數:", cd1, "→", cd2, cd2 < cd1 ? "✅ 下降" : "❌ 沒動");

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("VERIFY FAIL:", e.message); process.exit(1); });
