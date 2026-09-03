# lucy-site 程式碼審查報告（Code Review）

> 審查日期：2026-09-03
> 審查範圍：全倉庫（`src/` 前端、`server/` 後端、`tools/` file-vault 工具、測試與建置設定）
> 驗證環境：Windows（本機）、Node via `tsx` / `vitest` / `vite`
> 更新：2026-09-03 依審查清單完成修補並重新驗證（見 §0）

---

## 0. 修補狀態更新（v2・2026-09-03）

依 code review 勾選清單完成修補並全數重新驗證（lint / typecheck / test / build / runtime smoke）。
各項處置如下（✅ = 已修補並驗證；⏸️ = 依決策維持原樣）：

| 編號 | 處置 | 修補摘要 |
|---|---|---|
| H1 | ✅ | `server/config.ts`：啟動自動載入 `.env`（Node ≥20.12 `loadEnvFile`）；`NODE_ENV=production` 使用預設密碼/密鑰 → `throw`；新增 `.env`（隨機值）與 `.env.example` |
| H2 | ⏸️ | 依決策不改（維持 4+4 分享憑證） |
| H3 | ✅ | `HOST` 預設 `127.0.0.1` 並傳入 `serve`；新增 `TRUST_PROXY` 開關與共用 `server/request-ip.ts`；測試 `cfg` 設 `TRUST_PROXY=1` |
| H4 | ✅ | `login` 與 `/s/:shareId` POST：`Content-Length > 64KB → 413`；上傳 >2GB 先行擋下 |
| H5 | ✅ | busboy `limits: { fields: 0, parts: 50 }` |
| M1 | ✅ | `createApp` 回傳 `LucyApp`（Hono + `db`）；測試 `afterAll` 先 `db.close()` 再刪目錄 |
| M2 | ⏸️ | 依決策不改（rate_limits 保留） |
| M3 | ✅ | 每檔 `finalize()` 防 error 卡死；request 結束清除未 register 的 orphan `.dat` |
| M4 | ✅ | `api.ts` 新增 `ApiError.retryAfterSec`；`LockScreen` 直接讀取（移除 regex） |
| M5 | ✅ | `VaultUI` 新增 `onUnauthorized`；401 → 回鎖定畫面；用 ref 保存最新 callback |
| M6 | ✅ | flash 計算與 setTimeout 移出 `setState` updater（updater 恢復 pure） |
| M7 | ⏸️ | 依決策不改（tsconfig 未開 strict） |
| M8 | ⏸️ | 依決策不改（e2e POSIX 前提，README 已註明） |
| M9 | ✅ | `Scene3D` 改 `React.lazy` + Suspense 分包 |
| L1 | ✅ | `issueSession(c, secret, secure)` 由 config 統一決定 cookie Secure |
| L2 / L3 / L4 | ⏸️ | 依決策不改 |
| L5 | ✅ | `ToolShell` / `PortfolioPage` 各自設定 `document.title` |
| L6 | ⏸️ | 依決策不改 |
| L7 | ✅ | `intEnv()` 數值驗證（非法 / NaN → fallback） |
| L8 | ✅ | 429 回應加標準 `Retry-After` header |
| L9 | ✅ | 新增 `.env.example`；README 補 env 表格與 nginx 反代說明 |
| L10 | ⏸️ | 依決策不改 |
| L11 | ✅ | `app.notFound` 統一 JSON 404 |
| L12 | ⏸️ | 依決策不改（10 個既有 warnings 保留） |
| L13 | ✅ | README：檔案結構含 server/tools/tests、lazy 分包、e2e 說明 |
| L14 | ✅ | `.gitignore` 新增 `.env`、`test-results/`、`playwright-report` |

**修補後重新驗證結果：**

| 驗證 | 結果 |
|---|---|
| `npm run typecheck:server` / `typecheck:app` | ✅ 通過 |
| `npm run lint` | ✅ 0 errors / 10 warnings（既有，未列入本次修補） |
| `npm test`（vitest） | ✅ **35/35 全過**（Windows EPERM 已根治） |
| `npm run build` | ✅ 通過；主 chunk 1,367 kB → **599.8 kB**，Scene3D 獨立 1,099 kB chunk 延後載入 |
| runtime smoke（直接打 Hono app） | ✅ H1 production throw、.env 載入、login 與 /s 413、429 帶 Retry-After、JSON 404 |

> 註：驗證期間曾出現一次 1/35 失敗，係五個 npm 指令並行執行互相搶 `tsbuildinfo`/資源所致；
> 單獨重跑即 35/35 全過，與程式碼無關。

**剩餘待辦（依決策未處理）**：H2（分享憑證熵）、M2（rate_limits 清理）、M7（前端 strict）、M8（e2e
跨平台），以及 Low 的 L2 / L3 / L4 / L6 / L10 / L12。日後若要再收斂，建議優先 **H2**。

---

## 目錄

0. [修補狀態更新](#0-修補狀態更新)
1. [執行摘要](#1-執行摘要)
2. [驗證記錄（本次實際執行）](#2-驗證記錄本次實際執行)
3. [總體評價與優點](#3-總體評價與優點)
4. [架構與專案組織](#4-架構與專案組織)
5. [問題清單（依嚴重度分級）](#5-問題清單依嚴重度分級)
6. [模組細評](#6-模組細評)
7. [可近用性 / 效能 / SEO](#7-可近用性--效能--seo)
8. [測試品質](#8-測試品質)
9. [總結建議優先序](#9-總結建議優先序)

---

## 1. 執行摘要

這是一個以《電馭叛客：邊緣行者》為主題的 3D 個人作品集網站（Vite + React 19 + React Three Fiber），
並內建一套全棧「工具註冊制」架構，目前已實作 **FILE VAULT 檔案保險箱**（Hono + better-sqlite3 +
React 管理端 + 零 React 的公開分享頁）。

整體評價：**程式品質高於平均水準**。架構切割清楚、安全意識明確（constant-time 比對、HMAC
session、路徑穿越防護、uuid 實體檔隔離、rate limiting 等都有做對），`reduced-motion` / 行動裝置降級 /
可近用性處理細膩，測試覆蓋（單元 + 整合 + E2E）在同類個人專案中相當完整。程式註解品質極佳。

主要風險集中在 **file-vault 的「分享憑證熵值 + 部署信任邊界」**、**production 預設密碼/密鑰無防呆**、
以及 **測試在 Windows 上必定失敗的清理問題**。其餘多為 Medium/Low 級可改善事項，不影響主站正常運作。

> **v2 更新**：除 H2 / M2 / M7 / M8 與部分 Low（依決策保留）外，上述風險點皆已修補並通過
> 重新驗證，詳見 [§0](#0-修補狀態更新)。

### 快速結論（TL;DR）

| 面向 | 結論 |
|---|---|
| 前端（R3F / motion / CSS） | 佳。降級與 a11y 考量完整 |
| 後端（Hono / SQLite） | 佳。認證與 rate-limit 有做對 |
| file-vault 安全性 | v1：分享碼/PIN 熵過低、XFF 信任、/s body 無上限 → **v2：H3/H4/H5 已修**；H2 依決策保留 |
| 設定 / 部署 | v1：production 預設密碼/密鑰無防呆、無 env 文件 → **v2：H1 已修 + .env/.env.example 已建立** |
| 測試 | 佳。v1 時 Windows 上 `npm test` 會因 temp 清理失敗（EPERM）；**v2 已修補，35/35 全過** |
| 建置 | 通過。v1 主 chunk 1.37MB；**v2 已對 3D 場景 lazy 分包**（主 chunk 599.8 kB） |

---

## 2. 驗證記錄（本次實際執行）

> v1 初審記錄；修補後的最新驗證結果見 [§0](#0-修補狀態更新)。

| 指令 | 結果 |
|---|---|
| `npm run lint`（oxlint） | ✅ 0 errors / 10 warnings |
| `npm run typecheck:app`（tsc -b） | ✅ 通過 |
| `npm run typecheck:server`（tsc -p server） | ✅ 通過 |
| `npm run build` | ✅ 通過（vite 主 chunk 1,367 kB 警告） |
| `npm test`（vitest） | ⚠️ **35/35 tests 全過，但 2 個 suite 在 `afterAll` 清理 temp 目錄時失敗**（Windows `EPERM`，原因見 M1） |

> `npm run test` 的失敗並非測試斷言失敗，而是 `rmSync(tmpdir)` 刪不掉仍被開啟的 SQLite
> 檔案（better-sqlite3 connection 未 close）。在 macOS/Linux 上不會浮現，屬跨平台 bug，詳見 [M1](#m1)。

---

## 3. 總體評價與優點

值得保留與學習的設計：

- **Tool registry 架構**（`tools/types.ts`、`server/registry.ts`、`src/tools.ts`）：新工具只需五步即可
  全棧註冊（meta / server router / client lazy page / server registry / client registry），
  是乾淨的可擴充模式。`types.ts` 刻意維持 type-only、`meta.ts` 零 runtime 依賴，避免 client
  bundle 誤拉 node 依賴——這個約束在 `tools/README.md` 有明確文件化，很好。
- **安全基元正確**：
  - `server/auth.ts`：無狀態 HMAC-signed session cookie（base64url + 前 16B 簽章、`timingSafeEqual`
    驗證、TTL 7 天、nonce、httpOnly + SameSite=Lax + Secure）。不需 server session store，多 process 可擴充。
  - `checkPassword` / `verifyShare` 都用 `timingSafeEqual`。
  - `server/vault.ts`：實體檔一律 `<uuid>.dat`（副檔名無意義、不可執行、不可路徑穿越）；
    原始檔名只留 basename 並剝除控制字元；`sanitizeName` 有單元測試覆蓋 `../`、`C:\`、中文檔名。
  - `share-page.ts`：所有動態輸出都過 `escapeHtml`（含 404 / 檔名 / 錯誤訊息），inline 樣式與 JS
    無使用者資料注入點。
- **上傳串流**：busboy 直接 pipe 到 disk（`router.ts`），記憶體不隨檔大小成長；`files:50` 與
  `fileSize: 2GB` 有設界。
- **時鐘注入**（`now`）與 temp dir 讓 `vault.test.ts` 可以穩定測「72h 自毀」而不用等真實時間。
- **前端降級層層分明**（`PortfolioPage.tsx`）：reduced-motion → 無 3D；coarse pointer / 窄畫面 →
  靜態背景；WebGL 偵測 + Error Boundary（`SceneBoundary`）；CRT 濾鏡與自訂游標可一鍵關閉。
  自訂游標只在 `pointer: fine` 掛載，不犧牲觸控可用性。
- **`prefers-reduced-motion` 覆蓋完整**：CSS 全域 media query、JS hooks、`BootScreen` /
  `LockScreen` / `VaultUI` / `RouteTransition` 都有 `instant`/`rm` 快路徑，連分享頁 inline CSS/JS
  都有處理（`share-page.ts`）。
- **註解與文件品質高**：模組檔頭說明用途與約定；`tools/README.md` 寫明擴充流程與踩坑；全域 lint /
  typecheck 全綠。

---

## 4. 架構與專案組織

```
src/                   前端 SPA（Portfolio + ToolShell）
├── three/Scene3D.tsx  月球場景（相機路徑、Bloom、單分子線）
├── audio/engine.ts    Web Audio 合成音效 + BGM
├── components/        Boot / HUD / Sections / GlitchText / ToolShell ...
└── content.ts         內容檔（唯一手動維護點）

server/                Hono 後端（auth / db / rate-limit / config / registry）
tools/
├── types.ts           tool 契約（type-only）
└── file-vault/
    ├── meta.ts        純資料
    ├── types.ts       共享型別
    ├── server/        Hono 路由 + Vault 服務層 + 分享頁 SSR
    └── client/        React 管理頁（lazy 載入）

tests/                 vitest（unit + API 整合）
tests/e2e/             Playwright
```

- 前端路由與 API 前綴分工明確：`/tools/:toolId`（SPA）、`/api/...`（管理）、`/s/:shareId`（公開分享）。
- `vite.config.ts` dev proxy 把 `/api`、`/s/` 轉給 3001，production 由 Hono 同時 serve `dist/` +
  SPA fallback——一套 code 兩種跑法，測試能直接 `app.request()` 不需 listen，設計良好。
- 命名、註解、目錄慣例一致（繁體中文註解、英文識別字）。

一個值得注意的組織問題：**同一份「分享頁」CSS/JS 以 template literal 內嵌在 `share-page.ts`**
（約 200 行 inline `<style>` / `<script>`）。`public/code-rain.js` 已抽出共用，其餘樣式與互動
JS 仍為內嵌字串，改動時須小心字串跳脫。可接受，但屬技術債。

---

## 5. 問題清單（依嚴重度分級）

### 5.1 High（建議優先處理）

> 修補狀態（見 §0）：H1、H3、H4、H5 ✅ 已修補；H2 ⏸️ 依決策不改。

#### H1. production 無「預設密碼 / 預設密鑰」防呆

- **位置**：`server/config.ts:32-33`（`adminPassword` 預設 `"admin123"`、`sessionSecret` 預設
  `"dev-secret-change-me"`）
- **說明**：註解已標「⚠️ 僅開發預設」，但程式沒有阻止任何人以預設值啟動 production。一旦部署者
  漏設 env，等於管理端公開（`admin123`）、且 session 密鑰公開（任何人都能偽造管理員 cookie，
  見 `server/auth.ts` 的 `signSession`）。
- **建議**：
  ```ts
  const isProd = env.NODE_ENV === "production";
  if (isProd && (adminPassword === DEFAULT_PW || sessionSecret === DEFAULT_SECRET)) {
    throw new Error("production 必須設定 VAULT_ADMIN_PASSWORD / VAULT_SESSION_SECRET");
  }
  ```
  或至少 `console.warn` + 啟動延遲。也建議在 README「上線前要做的」補上 env 清單（見 L9）。

#### H2. 分享憑證熵值不足 + 暴力防護可被繞過

- **位置**：`tools/file-vault/server/vault.ts:66-73`（`generateShare`：share_id = 4 小寫字母、
  pin = 4 位數）、`tools/file-vault/server/router.ts:26-28`（PIN rate limit 10 次 / 15 分 / per-IP-per-share）
- **說明**：
  - PIN 僅 10,000 種組合。rate limit 的 key 是 `pin:${ip}:${shareId}`——**以「IP」為單位**。
    分散來源（botnet / IPv6 / 偽造 XFF，見 H3）可繞過單 IP 限制，10 萬次請求即可窮舉。
  - share_id 僅 456,976 種，而 **`GET /s/:shareId` 完全沒有 rate limit**
    （`router.ts:206-215`），可低成本批量掃描猜出有效分享連結。
  - 若設計前提是「連結 + PIN 雙因素、連結本身即 secret」，則長度過短。
- **建議**：
  1. 拉高熵：share_id 至少 8 字元（可混數字），PIN 至少 6 位數，或改為 8~10 字元代碼。
  2. rate limit 增加 **per-share 的累計失敗上限**（不只看 IP）：例如每 share 全域 30 次失敗即鎖定，
     另外對 `GET /s/` 也套用較寬的 rate limit，避免掃描。
  3. 產生 share_id 時避開易混淆字元（如 `0/o`、`1/l`），提升可讀性。

#### H3. 信任 `X-Forwarded-For`，但 server 實際 listen 0.0.0.0

- **位置**：`server/index.ts:31-40`（`clientIp`）、`tools/file-vault/server/router.ts:265-268`
  （`xffIp`）、`server/index.ts:124-125`（`serve({ port })`，log 顯示 `0.0.0.0`）、`server/config.ts`
  （無 bind host 欄位）
- **說明**：程式註解假設「node 只 listen 127.0.0.1、由 nginx 覆寫 XFF」，但程式碼並沒有綁定
  loopback——`@hono/node-server` 預設 listen 所有介面，且 `config.ts` 無 `bindHost` 選項。若 node
  進程可被直接觸達（未正確經 nginx / 防火牆），任何人可自訂 `X-Forwarded-For`，**直接廢掉
  login / PIN 的 rate limit**（配合 H2 等於管理密碼可暴力破解）。
- **建議**：`config` 增加 `bindHost`（預設 `127.0.0.1`）並傳給 `serve`；或提供明確的
  `TRUST_PROXY` 開關，只有設為信任代理時才採用 XFF，否則一律用 `getConnInfo().remote.address`。

#### H4. `/s/:shareId` POST 對 body 無大小限制（記憶體 DoS 風險）

- **位置**：`tools/file-vault/server/router.ts:238`（`await c.req.parseBody()`）
- **說明**：分享頁只需要 1 個 4 字元欄位，但 `parseBody()` 會把整個 request body 讀入記憶體。
  若部署時 nginx 的 `client_max_body_size` 沒設小、或 node 直接被觸達（見 H3），送一個超大 body
  即可造成記憶體耗盡。
- **建議**：先用 `Content-Length` 檢查（例如 > 4KB 直接 413），或改用 streaming 解析（busboy）
  並設 `limits: { fields: 1, fieldSize: 64, files: 0 }`。

#### H5. 上傳 multipart 未限制欄位數量

- **位置**：`tools/file-vault/server/router.ts:76-80`（busboy `limits` 只有 `fileSize` 與 `files`）
- **說明**：admin 上傳端不收任何欄位，但 busboy 預設接受無限欄位與 `parts`，異常 client 可送大量
  欄位消耗 CPU/記憶體。
- **建議**：`limits: { fileSize, files: 50, fields: 0, parts: 50 }`（`fields: 0` 表示拒絕欄位）。

### 5.2 Medium（建議盡快改善）

> 修補狀態（見 §0）：M1、M3、M4、M5、M6、M9 ✅ 已修補；M2、M7、M8 ⏸️ 依決策不改。

#### M1. 測試在 Windows 上清理失敗（`EPERM`）→ `npm test` 必失敗

- **位置**：`tests/auth.test.ts:35-37`、`tests/file-vault-api.test.ts:69-71`（`afterAll` 中
  `rmSync(dataDir)`）；`server/index.ts:43`（`openDb` 的 connection 從未 close）
- **說明**：`createApp()` 內部 `openDb()` 開的 better-sqlite3 connection 沒有被任何地方關閉。
  測試結束後 `rmSync` 刪除 temp 目錄時，Windows 因檔案仍被開啟而回 `EPERM`；macOS/Linux 允許
  刪除開啟中的檔案所以不會發現。本次實測：`vault.test.ts`（有 `db.close()`）通過，其餘兩檔失敗。
- **建議**：
  1. 讓 `createApp` 回傳（或另外取得）db 實例／`dispose()`，測試在 `afterAll` 先關閉 db 再 `rmSync`。
  2. 或測試改為「刪不掉也忽略」（`force: true` 已設，Windows 仍會 throw；可 try/catch），
     但根治仍是關閉 connection。

#### M2. `rate_limits` 表只增不減

- **位置**：`server/db.ts:20-41`（migration 僅建表＋index）、`server/rate-limit.ts:25-31`
- **說明**：每個不同的 `login:<ip>` / `pin:<ip>:<shareId>` key 都會永久留一行，沒有 TTL 清理。
  正常使用量小沒問題；若遭遇偽造 IP 的大量請求（見 H3），SQLite 檔案會無限成長。
- **建議**：定期（可併入 vault 的每小時 cleanup）執行
  `DELETE FROM rate_limits WHERE window_start < now - 2*windowMs`；或 migration 時對舊 row 加
  清理邏輯。視窗資訊只有 `window_start`，可估算到期。

#### M3. 上傳中斷／錯誤時殘留未註冊的 `.dat` 檔（orphan）

- **位置**：`tools/file-vault/server/router.ts:84-155`
- **說明**：多檔上傳時若任一步 reject（client 斷線、busboy error、`nodeIn` error），程式直接回 500，
  已寫入且未 `register`（無 DB 記錄）的暫存 `.dat` 不會被清理；`cleanupExpired` 只清有 DB 記錄的檔，
  因此 orphan 會永久殘留磁碟。
- **建議**：在 request scope 追蹤所有產生的 `stored` 名稱，`finally` / error 路徑統一
  `unlinkSync`；另外可考慮「以目錄掃描比對 DB」的 orphan 清理，納入每小時 cleanup。

#### M4. 管理端 429 的 `retryAfterSec` 未傳回 UI（鎖定倒數恆為 60 秒）

- **位置**：`server/index.ts:67-70`（回應含 `retryAfterSec`）→ `tools/file-vault/client/api.ts:17-25`
  （`j()` 只保留 `error` message）→ `tools/file-vault/client/LockScreen.tsx:179`
  （`/(\d+)/.exec(...) ?? 60`）
- **說明**：server 的 login 429 error message「嘗試次數過多，請稍後再試」不含數字，client 用 regex
  抓不到 → fallback 固定 60 秒。也就是管理畫面鎖定倒數與伺服器實際 `retryAfterSec` 不一致
  （測試 `auth.test.ts:113` 只驗證 server 端大於 0，client 端沒驗證）。
- **建議**：把 `retryAfterSec` 放進 Error 物件屬性（`err.retryAfterSec`），`LockScreen` 直接讀取；
  避免用 regex 解析人類可讀訊息。

#### M5. Session 失效後 UI 不會回鎖定畫面（靜默吞錯 + unhandled rejection）

- **位置**：`tools/file-vault/client/VaultUI.tsx:34-53`（`refresh` 的 `catch {}` 靜默）、
  `tools/file-vault/client/VaultUI.tsx:89-99`（`remove` 只有 `try/finally` 沒有 `catch`）
- **說明**：
  - `refresh()` 對任何錯誤（包括 401）都靜默——cookie 過期後畫面停留在「VAULT ONLINE // 0 FILES」，
    使用者看起來像正常但其實已無權限。
  - `remove()`（與 `onLogout` 之外的 API 呼叫）失敗時產生 **unhandled promise rejection**。
- **建議**：`vaultApi` 已會拋 `err.status`；`refresh`/`remove` 的 catch 判斷 `status === 401` 時
  呼叫 `onUnauthorized`（由 `FileVaultPage` 統一 `setPhase("locked")`），其餘錯誤顯示 toast/message。
  把 `onLogout` 改成可同時被「主動登出」與「被登出」使用。

#### M6. setState updater 內有 side-effect

- **位置**：`tools/file-vault/client/VaultUI.tsx:37-47`（`setFiles(prev => {...})` 內呼叫
  `setFlashIds`、`window.setTimeout`）
- **說明**：React 要求 updater 為 pure function；React 19 StrictMode 下 updater 可能被 double-invoke，
  造成重複的 flash 與重複 setTimeout（本專案 `main.tsx` 有用 StrictMode）。目前副作用「碰巧無害」，
  但屬不穩定寫法。
- **建議**：先從 `refresh()` 拿到的 `next` 與 `prevIds.current` 算出 `fresh` 清單（在 updater 外），
  再一次 `setFiles(next)` + `setFlashIds(fresh)`。

#### M7. 前端 TypeScript 未開 `strict`

- **位置**：`tsconfig.app.json`（含 `vite.config.ts` 的 `tsconfig.node.json`）都沒有 `"strict": true`；
  只有 `tsconfig.server.json` 有開。
- **說明**：前端程式因此缺少 `noImplicitAny` / `strictNullChecks` 等保護。目前靠開發者自律與
  oxlint，沒有型別層防線。日後 3D / 動畫程式碼複雜化後風險會上升。
- **建議**：於 `tsconfig.app.json` / `tsconfig.node.json` 補上 `"strict": true`，並考慮
  `noUncheckedIndexedAccess`（`content.ts`、`vault.ts` 有大量陣列/物件索引）。

#### M8. Playwright e2e 設定只能在 POSIX shell 執行

- **位置**：`playwright.config.ts:18`（`command: "rm -rf /tmp/lucy-e2e-data && ..."`）
- **說明**：`rm -rf /tmp/...` 是 bash 語法；本專案開發環境為 Windows（`npm run dev` 在 win32），
  在此環境跑 e2e 會直接失敗。目前 e2e 大概只在 CI / WSL 執行。
- **建議**：用 Node 小腳本清資料夾（例如 `node -e "fs.rmSync('/tmp/lucy-e2e-data',{recursive:true,force:true})"`）
  或把 command 改為 `VAULT_DATA_DIR=... npx tsx ...` 搭配 cross-env；並補 `npm run test:e2e` script。
  也注意 `timeout: 45_000` 搭配 1.3MB SPA + boot 動畫（reducedMotion 已關閉動畫）尚可。

#### M9. 主 bundle 1.37MB（three.js 全包）

- **位置**：`src/three/Scene3D.tsx`、`vite.config.ts`（無手動 chunk 策略）；build 實測主 chunk
  `index-*.js 1,367 kB`（gzip 385 kB）
- **說明**：README「已知事項」已記錄 1.3MB 且工具頁有 `React.lazy` 分包（`FileVaultPage` 獨立
  15.9 kB chunk），但 **首頁的 3D 場景沒有分包**，因此首載仍要下載全部 three / drei / postprocessing。
- **建議**：把 `Scene3D` 用 `React.lazy`（或直接 `Canvas` 內容 dynamic import）切成 async chunk，
  讓首頁 LCP 只載核心 UI；或 `build.rolldownOptions.output.codeSplitting` 手動把 three vendor
  拆出做長效快取。工具頁已示範 lazy 模式，首頁可套用同一招。

### 5.3 Low / Nit

> 修補狀態（見 §0）：L1、L5、L7、L8、L9、L11、L13、L14 ✅ 已修補；L2、L3、L4、L6、L10、L12 ⏸️ 依決策不改。

#### L1. cookie `Secure` 旗標雙源頭不一致

- `server/config.ts:18,35` 算出 `cfg.cookieSecure`，但**從未被使用**；`server/auth.ts:70`
  `issueSession` 自己讀 `process.env.NODE_ENV === "production"` 決定 `secure`。兩邊邏輯重複且來源
  不一（測試用 `NODE_ENV=test` 時行為又不同）。建議 `issueSession(c, secret, { secure })` 由 config 統一注入。

#### L2. SPA fallback 每次 request 都 `readFileSync(index.html)`

- `server/index.ts:107-109`。流量大時屬不必要的同步 IO。可在啟動時讀一次並 cache（留意 dist 更新）。

#### L3. `index.html` 缺社群分享 meta（OG / Twitter）

- 個人作品集最常被貼到社群，目前無 `og:title` / `og:description` / `og:image`（可用
  `favicon.svg` 或 hero 圖）。建議補上並提供 1200×630 預覽圖。

#### L4. 分享頁可連點重複觸發下載儀式

- `tools/file-vault/server/share-page.ts:275-304`：`animating` 只在整個 ACCESS GRANTED 動畫
  **結束後的 callback** 才設為 `true`；動畫進行中再次 submit 不會被擋，可能疊出多個 overlay /
  多次 `form.submit()`。建議在 submit handler 進入點就先鎖（設 `busy` flag 並 disable button）。

#### L5. 工具頁未更新 `document.title`

- `ToolShell.tsx` 無對應 effect；停留在 `/tools/file-vault` 時分頁標題仍是
  `NETRUNNER PORTFOLIO`（`main.tsx:8` 只在啟動設一次）。建議 `ToolShell` 依 `tool.meta` 設定
  `document.title` 並在 unmount 還原。

#### L6. 刪除「正在被下載」的檔案在 Windows 會 `EPERM` → ghost `.dat`

- `tools/file-vault/server/vault.ts:149-159`（`delete()` 先刪 DB row 再 `unlinkSync`，catch 吞錯）。
  當檔案正被 `createReadStream` 讀取（有人正在下載）時，Windows 上 `unlinkSync` 失敗，留下無 DB
  記錄的 `.dat`。Linux 上可正常刪除開啟中的檔案所以不易察覺。若以 Windows 當 server，需要 retry
  或延遲刪除機制。

#### L7. env 數值無驗證（`NaN` 會靜默）

- `server/config.ts:30,36`：`Number(env.PORT ?? 3001)`、`Number(env.VAULT_LOGIN_RATE_MAX ?? 5)`
  若 env 給非數字 → `NaN`。`PORT: NaN` 會讓 listen 失敗；`loginRateMax: NaN` 會使
  `count > NaN` 恆為 false → **rate limit 形同關閉**。建議 `parseInt` + `Number.isFinite` 檢查並 fallback。

#### L8. 未回標準 `Retry-After` header

- 429 時只用自訂 `retryAfterSec` JSON。可加 `c.header("Retry-After", String(sec))`，讓標準 client /
  proxy / 瀏覽器可讀。

#### L9. 缺少 env 部署文件與 `.env.example`

- `server/config.ts` 有 6+ 個 env（`VAULT_ADMIN_PASSWORD`、`VAULT_SESSION_SECRET`、`VAULT_DATA_DIR`、
  `PORT`…），但 README「上線前要做的」只提到換內容與部署 dist，**沒列出必設 env 與預設值警告**
  （呼應 H1）。建議補一份「Production 部署檢查清單」。

#### L10. 分享下載 header 只有 `filename*=` 無 `filename=` fallback

- `tools/file-vault/server/router.ts:36-43`：對不支援 RFC 5987 的老下載器，`Content-Disposition`
  沒有 ASCII fallback 檔名。可加 `filename="download.dat"` 作為第二段。

#### L11. 未匹配 API route 回空 body 而非 JSON

- 非 GET 的 `/api/*` 未命中時走 Hono 預設 404（空 body）；`server/index.ts:102-106` 的 JSON 404
  只涵蓋 GET。建議 `app.notFound` 統一 JSON（`{ ok:false, error:"Not Found" }`）。

#### L12. oxlint 10 個 warnings 建議清理

- 較實質的：`react(set-state-in-effect)`（`PortfolioPage.tsx:44`、`GlitchText.tsx:49`、
  `LockScreen.tsx:82,112`）可用 lazy initializer 或 event 內處理；`no-control-regex`
  （`vault.ts:61`）可加 disable 註解或改用逐字元判斷；`no-useless-escape`（`GlitchText.tsx:14`）、
  `only-export-components`（`RouteTransition.tsx:20`）、React Compiler immutability 提示
  （`Scene3D.tsx` 對 texture/camera 的修改屬 R3F 慣用法，可忽略或局部 suppress）。

#### L13. README 小過時

- 已知事項寫「單一 chunk 約 1.3MB」→ 現為 1.37MB；「唯一要改 content.ts」與實際需維護
  `tools/`、`server/` 略有出入。建議在檔案結構段落補上 `server/`、`tools/` 與測試目錄。

#### L14. `.gitignore` 未忽略 `code-review.md` 以外的本機暫存檔（nit）

- 無實質問題；`data/`、`dist-server/`、`preview-*.png` 等都有正確忽略。唯一建議：確認
  `test-results/`（Playwright 產物）也要忽略（目前清單未見），避免誤 commit 截圖/trace。



---

## 6. 模組細評

### 6.1 `server/auth.ts` — session 設計

優點：無狀態、簽章驗證用 `timingSafeEqual`、有 TTL 與 nonce、cookie 旗標正確。設計合理。

可討論點：
- 無狀態 session 的缺點是**無法主動撤銷**（logout 只是請瀏覽器刪 cookie）；若 cookie 被竊，7 天內
  都有效。單人管理工具可接受，但密鑰輪換會讓所有 session 失效——這其實是 feature 不是 bug。
- `verifySession` 對 payload 只驗 `v === 1` 與 `at` 型別；簽章正確時完整性已由 HMAC 保證，OK。
- `checkPassword(actual, input)` 在兩者都為空字串時會對空 buffer 呼叫 `timingSafeEqual`（會 throw）。
  目前實際值不會是空字串（config 有 default），但值得加 `if (!a.length) return false` 防呆。

### 6.2 `server/rate-limit.ts` — SQLite 固定窗口

優點：實作精簡、可注入時鐘、`remaining` 回報貼心。

可討論點：
- **固定窗口邊界問題**：`window_start = now - now % windowMs`，在窗口邊界可「尾段 10 次 + 頭段 10 次」
  使實際上限翻倍。對 login 暴力防護影響有限（需連續失敗），可接受；若要更嚴可改 sliding log。
- 每次 `hit` 都是 1 次 INSERT + 1 次 SELECT（同步），高頻下是 SQLite 寫放大。流量小時無感。

### 6.3 `tools/file-vault/server/vault.ts` — 服務層

優點：DB 與檔案操作集中、實體檔名隔離、`ensureOnDisk` 防 ghost 記錄、時鐘注入測試友善。

可討論點：
- `sanitizeName` 保留 `..%2F..` 這類字串（測試也註明「保留但無害」）——實體檔名是 uuid，原始檔名
  只作為顯示與 Content-Disposition，確實無害；但未來若把 originalName 拿去當路徑要特別小心。
- `verifyShare` 對「shareId 存在但 pin 長度不同」回 null；因 pin 長度固定，無 oracle 增益。OK。

### 6.4 `tools/file-vault/server/router.ts` — API 層

優點：busboy streaming 正確、`maybeDone` 計數處理多檔完成、錯誤路徑大致有清理、`Content-Disposition`
有 UTF-8 編碼。管理與公開 API 以兩個 Hono instance 分開掛載，乾淨。

可討論點：
- 見 H2–H5、M3。upload handler 的 Promise 包裝較長（約 70 行），若再引入「總大小上限」或 orphan
  清理，建議抽出獨立函式/class 讓 router 更薄。
- 兩個 IP 解析函式（`server/index.ts: clientIp` 與 `router.ts: xffIp`）邏輯重複，建議統一放
  `server/` 共用（配合 H3 的 trust proxy 設定）。

### 6.5 file-vault client（`VaultUI.tsx` / `LockScreen.tsx`）

- VaultUI：狀態管理（loading / uploading / busyId / shareFor / flash）清楚；dropzone 用
  `dragDepth` 正確處理巢狀 dragenter/leave；XHR 上傳進度正確（作者有意識到 fetch 無 upload progress）。
- LockScreen：破碎/重生動畫狀態多（gen / breaking / leaving / hacking），用 ref 防重入，設計用心。
- 問題集中在 M4 / M5 / M6（retryAfter 遺失、session 失效不回鎖、updater side-effect）與 L4。

### 6.6 `src/three/Scene3D.tsx` — R3F 場景

- 相機路徑用 `CatmullRomCurve3` + 平滑阻尼（`1 - exp(-dt*k)`）手法正確；`dt` clamp 0.05 避免
  切分頁大跳。滑鼠視差只小量偏移視線/鏡頭，克制。
- Bloom + ACES + Vignette 參數合理。Monowire 用 `TubeGeometry` + 微量旋轉，成本可接受。
- 提示：`Canvas` 持續 render（即使分頁隱藏仍耗 GPU）。目前工具頁與首頁互斥（unmount 即停），
  影響有限；若要更省可於 `document.hidden` 時暫停。

### 6.7 `src/components/Sections.tsx` / `content.ts`

- 內容與元件分離徹底。`about.paragraphs` 走 `dangerouslySetInnerHTML` 以支援 `<strong>`；目前資料
  為 trusted 靜態檔可接受，但這是唯一的 HTML 注入面，若未來接 CMS/API 前務必 sanitize 或改結構化資料。
- `toolProjectCards` 自動接續 P-04 卡片，idx 接續邏輯正確。

### 6.8 `public/code-rain.js` + `HackerCodeRain.tsx`

- 單一來源（分享頁與工具頁共用）是正確決定；`window.startCodeRain(el)` 回傳 stop 讓 React 可清理。
- 批次 flush（60ms）避免逐字 DOM 寫入、textContent 上限截斷、reduced-motion 空操作，都有顧到。
- Nit：載入失敗時背景留空（可接受的優雅降級）。

---

## 7. 可近用性 / 效能 / SEO

### 可近用性（整體佳）
- `:focus-visible` 全域樣式存在（`index.css:59`）；互動元素大多為原生 `a`/`button`。
- `prefers-reduced-motion` 在 CSS / JS hooks / 分享頁 inline 都有處理（見第 3 節）。
- `aria-hidden` 大量用於裝飾層；`GlitchText` 用 `aria-label` + 真實文字層保證可讀。
- 可改善：
  - 色盤次要文字（`--dim:#8ba2b8`、`--faint:#56697c`，`index.css` 變數）在小字（0.65rem）下對比
    可能不足 WCAG AA（<18pt 需 ≥4.5:1）。屬主題取捨，可抽檢。
  - share-page 錯誤重繪用 `document.write`（`share-page.ts` 內 inline JS）——功能正確但屬舊 API，
    可改用 `outerHTML` 取代，列為 Low。

### 效能
- 首載主 chunk 1.37MB（M9）；CSS 37.8KB（gzip 8.7KB）合理；工具頁已 lazy。
- 3D：`dpr` 上限 1.75、multisampling 4、Bloom mipmapBlur，低階 GPU 較吃力，但有 mobile /
  reduced-motion fallback 保護。
- VaultUI 每秒 `setNow` 讓所有列重算 ttl；檔案量大時可只更新時間欄。目前量級可忽略。
- `ProgressBar` / `CameraRig` 用 rAF 常駐；背景分頁時 rAF 自動暫停，OK。

### SEO / 分享
- 見 L3（缺 OG meta）。`index.html` 的 title/description/`lang="zh-Hant"` 已正確設置。
- SPA 內容由 JS 渲染，爬蟲對 `/tools/*` 索引有限；個人站可接受。

---

## 8. 測試品質

優點（值得肯定）：
- **分層完整**：unit（`vault.test.ts` 15 項，時鐘注入測自毀）＋ API 整合（`auth` 9 項、
  `file-vault-api` 11 項，直接打 Hono `app.request`）＋ Playwright e2e（關鍵路徑含真實瀏覽器）。
- 測試隔離做得好：temp dir、`beforeEach` 清表清檔、login 用不同 IP 避免 rate-limit 互相污染。
- 覆蓋到安全關鍵點：偽造簽章 cookie、竄改 cookie、路徑穿越檔名、中文檔名 header、pin 錯 10 次鎖定、
  撤銷後 404。

缺口與建議：
1. **M1（Windows 清理失敗）**：先修，否則本機 `npm test` 恆紅。
2. **client 端未測**：無 React Testing Library；`LockScreen`/`VaultUI` 的行為（429 倒數、401 回鎖）
   只靠 e2e 間接涵蓋。至少對 M4/M5 的修正補 unit test。
3. **e2e 覆蓋有限**：`file-vault.spec.ts` 未涵蓋「登入被鎖定倒數」「session 過期強制回鎖」。
4. **上傳失敗/中斷路徑無測試**（對應 M3 orphan）：可測 busboy error 或關閉串流後確認無殘留檔。
5. `vitest.config.ts` include 只吃 `tests/**/*.test.ts`，若要加 client component test 需調整設定。

---

## 9. 總結建議優先序

### v2 現況（2026-09-03 修補後）

| 優先序 | 項目 | 狀態 |
|---|---|---|
| P0 | H1：production 預設密碼/密鑰防呆 | ✅ 已完成（throw + .env 支援） |
| P0 | H3：bind host / trust proxy | ✅ 已完成（127.0.0.1 + TRUST_PROXY） |
| P0 | M1：測試 Windows 清理 | ✅ 已完成（35/35 全過） |
| P1 | H4 / H5：/s body 上限、multipart fields 限制 | ✅ 已完成 |
| P1 | M4 / M5：retryAfter 傳遞、session 失效回鎖 | ✅ 已完成 |
| P2 | M3：upload orphan .dat | ✅ 已完成 |
| P2 | M9：3D 分包 | ✅ 已完成（主 chunk 599.8 kB） |
| P2 | L1/L5/L7/L8/L9/L11/L13/L14 | ✅ 已完成 |
| 剩餘 | H2：分享憑證熵 / M2：rate_limits 清理 / M7：strict / M8：e2e 跨平台 | ⏸️ 依決策保留 |
| 剩餘 | Low：L2/L3/L4/L6/L10/L12 | ⏸️ 依決策保留 |

**一句話結論（v2）**：審查建議的修補項目已全數完成並通過重新驗證（lint / typecheck / 35/35 tests /
build / runtime smoke）；主要風險「production 預設值、監聽位址/代理信任、Windows 測試清理」均已解除。
剩餘為依決策保留的 H2 / M2 / M7 / M8 與部分 Low——若要再進一步強化，下一優先建議 **H2**
（提高分享憑證熵 + per-share 失敗上限 + 對 `GET /s/` 套用 rate limit）。

---

## 附錄 A：審查時參考的主要檔案行號速查

> 行號對應 **v1 審查當下**的檔案內容；v2 修補後部分檔案行號已偏移，
> 修補項目與現行位置請以 §0 表格為準。

| 主題 | 位置 |
|---|---|
| 預設密碼/密鑰 | `server/config.ts:32-33` |
| cookieSecure 死碼 | `server/config.ts:18,35` ↔ `server/auth.ts:70` |
| XFF 信任 + 0.0.0.0 listen | `server/index.ts:31-40,124-125`；`router.ts:265-268` |
| 分享碼/PIN 產生 | `tools/file-vault/server/vault.ts:66-73` |
| PIN rate limit 與 /s 路由 | `tools/file-vault/server/router.ts:26-28,206-259` |
| upload multipart limits | `tools/file-vault/server/router.ts:76-80` |
| upload error / orphan | `tools/file-vault/server/router.ts:84-155` |
| rate_limits 只增不減 | `server/db.ts:20-41` |
| 429 retryAfter 斷鏈 | `server/index.ts:67-70` → `client/api.ts:17-25` → `LockScreen.tsx:179` |
| refresh 靜默吞錯 / remove 無 catch | `client/VaultUI.tsx:34-53,89-99` |
| updater side-effect | `client/VaultUI.tsx:37-47` |
| tsconfig 缺 strict | `tsconfig.app.json`、`tsconfig.node.json` |
| Playwright POSIX command | `playwright.config.ts:18` |
| 分享頁連點 | `tools/file-vault/server/share-page.ts:275-304` |
| 測試 temp 清理 EPERM | `tests/auth.test.ts:36`、`tests/file-vault-api.test.ts:70` |

---

*本報告由靜態閱讀 + 實際執行（lint / typecheck / build / vitest）交叉驗證產出；未執行 e2e
（需 Playwright 瀏覽器與 POSIX shell）。*


