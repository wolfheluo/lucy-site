// file-vault 關鍵路徑 e2e：鎖定畫面 → 登入 → 上傳 → 分享 → 公開下載
import { test, expect, type Page } from "@playwright/test";

const ADMIN_PW = "admin123";

async function unlock(page: Page) {
  await page.goto("/tools/file-vault");
  await expect(page.locator(".vault-lock-title")).toBeVisible();
  await page.fill("#vault-pw", ADMIN_PW);
  await page.click('button:has-text("UNLOCK")');
  await expect(page.getByText("VAULT ONLINE")).toBeVisible({ timeout: 10_000 });
}

test.describe("file-vault 關鍵路徑", () => {
  test("鎖定畫面：錯密碼被拒、對密碼進入", async ({ page }) => {
    await page.goto("/tools/file-vault");
    await expect(page.locator(".vault-lock-title")).toBeVisible();
    await expect(page.getByText("RESTRICTED AREA")).toBeVisible();

    // 錯密碼 → 拒絕
    await page.fill("#vault-pw", "wrong-pass");
    await page.click('button:has-text("UNLOCK")');
    await expect(page.getByText("ACCESS DENIED // 密碼錯誤")).toBeVisible();

    // 正確密碼 → 進入
    await page.fill("#vault-pw", ADMIN_PW);
    await page.click('button:has-text("UNLOCK")');
    await expect(page.getByText("VAULT ONLINE")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("VAULT EMPTY")).toBeVisible();
  });

  test("上傳多檔 → 列表顯示 → 刪除", async ({ page }) => {
    await unlock(page);
    await page.setInputFiles('input[type="file"]', [
      { name: "e2e-中文檔.txt", mimeType: "text/plain", buffer: Buffer.from("hello e2e 內容", "utf8") },
      { name: "note.md", mimeType: "text/markdown", buffer: Buffer.from("# note", "utf8") },
    ]);
    await expect(page.getByText("e2e-中文檔.txt")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("note.md")).toBeVisible();
    await expect(page.getByText(/2 個檔案已存入保險箱/)).toBeVisible();

    // 剩餘壽命倒數顯示
    await expect(page.getByText(/湮滅倒數/).first()).toBeVisible();

    // 刪除一檔
    page.once("dialog", (d) => void d.accept());
    const row = page.locator("li.vault-file", { hasText: "note.md" });
    await row.locator("button.vault-action.del").click();
    await expect(page.getByText("note.md")).not.toBeVisible();
    await expect(page.getByText("e2e-中文檔.txt")).toBeVisible();
  });

  test("分享 → modal 顯示連結/PIN → 公開頁輸 pin 下載 → 撤銷", async ({ page, request }) => {
    await unlock(page);
    await page.setInputFiles('input[type="file"]', [
      { name: "share-target.bin", mimeType: "application/octet-stream", buffer: Buffer.from("SECRET-E2E-DATA-123") },
    ]);
    await expect(page.getByText("share-target.bin")).toBeVisible({ timeout: 10_000 });

    await page.click('li.vault-file:has-text("share-target.bin") button.vault-action.share');
    await expect(page.locator(".vault-modal-title")).toBeVisible();
    const urlText = (await page.locator(".vault-share-url").innerText()).trim();
    const shareUrl = urlText.split("\n")[0].trim();
    const pin = (await page.locator(".vault-pin").innerText()).trim();
    expect(shareUrl).toMatch(/\/s\/[a-z]{4}$/);
    expect(pin).toMatch(/^\d{4}$/);

    // 匿名（無 cookie）公開下載：先錯 pin
    const bad = await request.post(shareUrl, { form: { pin: "0000" } });
    expect(bad.status()).toBe(401);
    // 對 pin → 檔案內容一致
    const ok = await request.post(shareUrl, { form: { pin } });
    expect(ok.status()).toBe(200);
    expect(ok.headers()["content-type"]).toContain("application/octet-stream");
    expect((await ok.body()).toString("utf8")).toBe("SECRET-E2E-DATA-123");

    // 公開頁 GET 顯示檔名
    const pageGet = await request.get(shareUrl);
    expect((await pageGet.text()).replace(/&#39;|&quot;/g, "")).toContain("share-target.bin");

    // 撤銷分享 → 公開頁 404
    page.once("dialog", (d) => void d.accept());
    await page.click(".vault-modal-foot .vault-btn-danger");
    await expect(page.locator(".vault-modal")).not.toBeVisible();
    const gone = await page.request.get(shareUrl);
    expect(gone.status()).toBe(404);
  });

  test("LOGOUT 回鎖定畫面", async ({ page }) => {
    await unlock(page);
    await page.click('button:has-text("LOGOUT")');
    await expect(page.locator(".vault-lock-title")).toBeVisible();
  });

  test("首頁 Projects 區含 FILE VAULT 卡（P-02），可點入工具", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("a.pcard.clickable", { hasText: "P-02" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("FILE VAULT")).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await expect(page).toHaveURL(/\/tools\/file-vault$/);
    await expect(page.locator(".vault-lock-title")).toBeVisible();
  });
});
