# lucy-site — 代碼審計報告 (code-review.md)

> 審計日期：2026-09-03 ｜ 審計範圍：全專案（HEAD `d8b3e33`，約 4.6K 行源碼）
> 方式：3 個平行 sub-agent 獨立深讀（server/安全面、client 主站、file-vault client+契約+測試/CI）+ 彙整 + Critical/Major 實測驗證
> 前版 code-review.md 已刪除，本報告為全新獨立審查

---

## 執行摘要

| 嚴重度 | 數量 | 重點 |
|--------|------|------|
| 🔴 Critical | 1 | XFF 偽造繞過 rate-limit（已實測證實） |
| 🟠 Major | 8 | share 低熵+列舉、72h 自毀延遲、share 碰撞、chunked 無上限、ambient 競態、rAF 效能×2、401 鏈斷裂、>50 檔靜默丟棄 |
| 🟡 Minor | 22 | session 撤銷、nonce、rate_limits 成長、CSP、錯誤訊息、timer/cleanup、死 CSS 等 |
| 🔵 Info | 10 | intEnv 靜默、文件漂移、測試缺口、正面確認等 |

**三大核心發現（均已【實測證實】）**：
1. **rate-limit 可被任意偽造 XFF 繞過** → 管理密碼可無限暴力、分享 PIN（10⁴）必破
2. **分享連結可單 IP 掃描列舉**（GET 無限速 + 26⁴ 空間）
3. **72h 自毀承諾有漏洞**：過期檔在下次清理前（最長 ~1h）仍可完整下載

---

## 🔴 Critical

### C-1. TRUST_PROXY=1 時取 X-Forwarded-For 最左值 → rate-limit 可被任意偽造繞過
- **檔案**：`server/request-ip.ts` 9-19（引用：`server/index.ts:57`、`tools/file-vault/server/router.ts:263`）｜severity 共識：3/3 sub-agent
- **問題**：`clientIp()` 在 trustProxy=true 時回傳 `xff.split(",")[0]`（最左值）。Cloudflare/nginx 對 XFF 都是「附加」而非「覆寫」（`$proxy_add_x_forwarded_for` 保留客戶端前綴），因此任何客戶端自帶 `X-Forwarded-For: <任意IP>` 即被當成真實來源。
- **影響**：登入限速（5/15min）與分享 PIN 限速（10/15min）完全可繞 → 管理員密碼可無限暴力破解；4 位數 PIN（10,000 組合）可被爆破，**任何被分享檔案可被未授權下載**；亦可偽造他人 IP 灌錯誤次數做 lockout poisoning。
- **【實測證實】**（production 同設定 127.0.0.1:3001）：
  ```
  同 XFF 連錯 pin：第 1 次 401 … 第 11 次 429（limiter 有運作）
  換 XFF 再錯 pin：401（繞過成功）→ rate-limit 形同虛設
  ```
- **修復建議**：a) 改用 `CF-Connecting-IP`（CF 保證覆寫不可偽造）；b) nginx 改 `proxy_set_header X-Forwarded-For $remote_addr`（覆寫成單一可信值）；c) 取最右（最後一跳代理附加）值並在 README 標明前提。rate-limit 身份來源必須是客戶端無法控制的一環。

---

## 🟠 Major

### M-1. share_id 僅 26⁴ 且 GET /s/:id 零限速 → 可低成本列舉「正在分享的檔案＋檔名＋大小」
- **檔案**：`tools/file-vault/server/router.ts` 240-249（vault.ts 193-198）
- **問題**：shareId 空間 456,976；GET 對存在的分享回 200（HTML 內嵌 originalName 與大小）、不存在的回 404，且 GET 完全不走 pinLimiter（限速只在 POST）。
- **影響**：不需 PIN 即可掃描全空間確認哪些檔正被分享、取得檔名（如「薪資單.pdf」常自帶敏感性）；配合 C-1 即完整攻破。
- **【實測證實】**：單一 IP 連續 GET 15 個不存在 shareId → `404 ×15`、零 429（GET 路徑無任何限速）。
- **修復建議**：share_id 加長至 8-10 base32/base62（40-60 bits）；GET 同走限速；存在/不存在回應一致化消除 oracle。

### M-2. 72h 自毀只在每小時 sweep 執行 → 過期檔案最長可再多活約 1 小時
- **檔案**：`tools/file-vault/server/router.ts` 58-67、201-210、240-298（vault.ts 130-147）｜共識：3/3
- **問題**：所有讀取路徑（getByShareId、/s/ GET/POST、admin /download、list）都不檢查 `expire_time`，只靠啟動時 + 每 3600s 的 `cleanupExpired()` 刪檔。
- **影響**：到期後 ~1h 內分享頁照常顯示、PIN 照常可下載、admin list 仍列出——直接違反「72 小時自動湮滅」核心承諾；前端卻已顯示 SELF-DESTRUCTED，UI 與實際矛盾。
- **【實測證實】**（隔離 instance，expire_time 手動改到 1 分鐘前）：
  ```
  過期後 PIN 下載：200（檔案完整可取）｜分享頁 GET：200｜admin list 仍列出
  重啟觸發啟動 sweep 後：404（cleanup 本身正常 → 延遲源 = 讀取路徑不檢查）
  ```
- **修復建議**：下載/讀取前檢查 `expireTime <= now` → 即時刪檔回 404；list 過濾過期；cleanup 降級為殘骸兜底。

### M-3. share_id 產生不檢查碰撞且索引非唯一（統計性）
- **檔案**：`tools/file-vault/server/vault.ts` 67-73、170-181（db.ts 39-40）
- **問題**：隨機 4 字母直接寫入、`idx_vault_share` 非 UNIQUE；生日悖論下 ~676 個並存分享就有 ~50% 碰撞率。碰撞時 getByShareId 回先命中列 → 分享互相串檔。
- **影響**：A 檔連結可能打到 B 檔（檔名洩漏、PIN 驗證錯亂、B 分享失靈）。長期營運下非不可能（M-1 修復後 id 加長即可大幅緩解）。
- **修復建議**：UNIQUE 索引 + createShare 碰撞重抽（配長 id 碰撞機率可忽略）。

### M-4. chunked 上傳無整請求總量上限（單 session 可寫 50×2GB）
- **檔案**：`tools/file-vault/server/router.ts` 73-195
- **問題**：MAX_UPLOAD_BYTES=2GB 只擋單檔與帶 Content-Length 的整包；chunked（無 CL）請求直接放行，busboy 可連續落盤 50 個 2GB 檔。
- **影響**：admin session 被竊/誤操作可瞬間塞爆磁碟（DoS/資料損壞）；風險受「需 admin session」制約故列 Major。
- **修復建議**：累計實際寫入位元組超限即中止並清理；或要求 Content-Length 存在；加並行上傳/頻率限制。

### M-5. Ambient 音樂 start/stop 競態 → 幽靈 BGM（第二層音樂無法停止）
- **檔案**：`src/audio/engine.ts` 226-265
- **問題**：stopAmbient 在 fade（700ms）完成前就把 `this.music` 設 null；共用單一 fade timer。快速切換 MUSIC 或開音樂後立刻離頁（unmount→stop）時，舊 HTMLAudioElement 失去參照、loop=true、音量非零 → 殘留一條無法以任何 UI 停止的音樂直到重整頁面。
- **影響**：聽感為重疊第二層 BGM；真實可重現的音訊 bug（需音訊環境實測）。
- **修復建議**：fade 完成回呼與 fade 對象一致；`play().then()` 先檢查 `this.music === music` 再 fade；維護 fading/active 集合。

### M-6. ProgressBar 永久 rAF loop：靜止時仍 60fps 讀 scrollHeight 強制同步 layout
- **檔案**：`src/components/Hud.tsx` 17-40
- **問題**：rAF 無條件自我重排，即使頁面靜止也每 frame 讀 `scrollHeight`（layout 同步）+ 寫 transform。
- **影響**：首頁常駐 60fps layout thrash（與 Scene3D/CustomCursor/code rain 疊加），低階裝置掉幀、電池浪費；首頁是長期停留頁，成本常態化。
- **修復建議**：被動 scroll listener + rAF 節流（僅捲動期間運作）；或 CSS scroll-driven animation。

### M-7. 工具頁 code rain 常駐全速寫 DOM（File Vault 操作畫面搶主執行緒）
- **檔案**：`src/components/HackerCodeRain.tsx` 34-57、`public/code-rain.js` 22-42/54-71/215-229
- **問題**：5ms/字 + 60ms 週期對大型 pre-wrap 節點 `textContent +=`（O(n²)），無 visibilitychange/不可見暫停；File Vault 這種要打字/拖檔的互動畫面背景持續全速寫 DOM。
- **影響**：低階裝置上 vault 操作可能卡頓；背景分頁仍持續。
- **修復建議**：單一 rAF 批次 + 固定字元速率（或 canvas）；visibilitychange 暫停；降 flush 頻率。

### M-8. client 401 處理鏈兩處斷裂（上傳 XHR 無 status、ShareModal revoke 無 catch）
- **檔案**：`tools/file-vault/client/api.ts` 77-92、`VaultUI.tsx` 95-104、358-409
- **問題**：① XHR onload 對 ≥400 只 reject Error 不帶 status → doUpload 的 `e.status===401` 分支是死碼，session 中途過期（大檔上傳最易觸發）只顯示「未授權」不踢回鎖定頁；② ShareModal.revoke 只有 try/finally 沒 catch → 401/網路錯誤 = unhandled rejection，畫面維持「分享仍有效」假象、不回鎖定畫面。
- **影響**：401 行為不一致；使用者對撤銷失敗/過期無感知（錯誤只進 console）。
- **修復建議**：XHR 錯誤統一 reject 帶 status/retryAfterSec 的 ApiError（與 fetch 路徑一致）；revoke 補 catch（401→onUnauthorized，其餘保留 modal + 提示）。

### M-9. 超過 busboy 上限（files/parts 50）的檔案被靜默丟棄，UI 計數不實
- **檔案**：`tools/file-vault/server/router.ts` 83-88、166-175；`VaultUI.tsx` 234-256
- **問題**：無 partsLimit/filesLimit listener；前端 dropzone 不限數量、不比對「選 N 檔 vs server 回 N 結果」。一次拖 60 檔 → 「✓ 50 個已存入」，10 個無聲消失。
- **影響**：資料靜默遺失（使用者以為已上傳）。
- **修復建議**：加 limits listener 產出明確 error item；client 上傳前限制/警告 + 比對數量。

---

## 🟡 Minor（22 項）

### server / 安全
- **m-1** `server/auth.ts` 20、61-78：logout 只清 cookie、無法撤銷已竊 session（7 天 TTL）；改密碼後舊 cookie 續命 → 建議 session 版本/黑名單或縮 TTL 滑動續期
- **m-2** `server/auth.ts` 65：nonce 用 `Math.random()`（非密碼學安全、長度不固定）→ 改 `crypto.randomBytes(8).base64url`
- **m-3** `server/rate-limit.ts` 23-45：rate_limits 表只增不減 → 週期清理舊窗口列
- **m-4** `server/index.ts` 68-73、`router.ts` 253-257：Content-Length 上限檢查可被 chunked 繞過（現 nginx 1MB 兜底、風險有限）→ 解析中計數或要求 CL
- **m-5** `server/config.ts` 48-77：H1 只擋「等於預設值」、未強制最小長度 → fail-fast 要求密碼 ≥12、密鑰 ≥32
- **m-6** `server/index.ts` 102-115：SPA fallback 對 /s/xxx/yyy、/api 等未匹配路徑回 200 HTML 非 404
- **m-7** `tools/file-vault/server/share-page.ts` 54-63、259-265：分享頁無 CSP/nosniff/frame-ancestors（XSS 面目前 escapeHtml 全覆蓋無實證漏洞，缺縱深）；上傳錯誤回傳原始錯誤字串（路徑/DB 細節）
- **m-8** `router.ts` 251-298：成功下載 = fetch 預檢 + 原生 submit 兩次 POST → 每次下載吃 2 個 PIN 額度（15 分鐘只能成功下載 ~5 次）+ 檔案被串流兩次

### client 主站
- **m-9** `src/PortfolioPage.tsx` 29-38：booted 在 instance state → 工具頁返回首頁每次重播 2.5s BootScreen（無 sessionStorage 記憶）
- **m-10** `src/PortfolioPage.tsx` 46-48：WebGL 探測在 effect 才執行 → 無 WebGL 環境先拉 whole 3D chunk 再降級；probe context 未釋放
- **m-11** `src/components/Sections.tsx` 76/94/119：dangerouslySetInnerHTML 無消毒——現為靜態開發者內容安全，但「唯一內容抽象層」日後接外部來源即 stored XSS；建議白名單 renderer 或 DOMPurify
- **m-12** `src/components/BootScreen.tsx` 53-63：setState updater 內做 clearInterval/sfx.line 副作用（React 不允許、dev 雙呼叫重播音效）
- **m-13** `src/components/RouteTransition.tsx` 22-74：onDone 每次 render 新閉包進 effect deps；過場中瀏覽器 back/forward 導航被劫持（pending 未取消會把使用者拉回原頁）
- **m-14** `src/three/Scene3D.tsx` 246-260：無 webglcontextlost 處理——GPU crash 後黑畫面不會降級 FallbackBackdrop
- **m-15** `src/three/Scene3D.tsx` 186-210：CameraRig 每 frame 讀 scrollHeight（layout thrash）→ 快取於 resize
- **m-16** `src/components/CustomCursor.tsx` 47-61：lerp 係數未除 dt → 120Hz/144Hz 手感不一致；指標靜止時 rAF 仍全速跑
- **m-17** `src/components/GlitchText.tsx` 103-107：hover jitter setTimeout 無清理無疊代防護 → 連續 hover 動畫被提前截斷
- **m-18** `src/audio/engine.ts` 49-55、219-265：setMuted 全站無呼叫者（死 API）；ambient 不走 master gain（音量路徑分裂）
- **m-19** `src/index.css` 601/610-615/732/834-847：死 CSS（.cursor-hidden/.reveal/.vault-placeholder）；`.glitch-box .dec .c` RGB 色散規則永不觸發（GlitchText 不產 class="c" span）
- **m-20** `src/index.css` 767/1137：`.tool-fx` z-index 重複宣告值衝突（5→6）
- **m-21** `src/components/Hud.tsx` 81-115：reduced-motion 下 CRT 開關無視覺作用仍顯示 on/aria-pressed；boot 期間鍵盤可 Tab 進透明按鈕

### file-vault client
- **m-22** `LockScreen.tsx` 98/141/151-163、`VaultUI.tsx` 57/394：多處動畫 timer/interval 未在 unmount 清理（unmount 後 setState/播音效）
- **m-23** `LockScreen.tsx` 166-188：非 401 失敗（網路/5xx）被當密碼錯誤 + 誤觸入侵動畫 → 只 401 才顯示密碼錯誤
- **m-24** `util.ts` 32-33：curlCommand 以單引號包檔名未跳脫——檔名含 `'` 時複製指令斷句（極端可注入 shell）
- **m-25** `VaultUI.tsx` 490、`share-page.ts` 52：「72 小時」文案起算點不一致（實際自 upload 起算、文案暗示自分享起算）

### 測試 / CI / 部署
- **m-26** `tests/*`：缺口——expiry 邊界下載、2GB/413、>50 檔、併發、React 元件測試全無（最危險路徑恰好無保護）
- **m-27** `.github/workflows/ci.yml`：只跑 vitest——typecheck/lint/Playwright e2e 全缺，README 卻聲稱 e2e 可在 CI 執行（vitest 不打 React client）
- **m-28** `deploy.sh` 24、30：CI deploy job 雙重 build（build step + deploy.sh 再 build）；遠端 pm2 PATH 硬編碼 v24.20.0 → 目錄漂移即失敗
- **m-29** `deploy.sh` 67-71：冒煙 PIN 用 /files 全庫 grep head -1（依賴排序才正確）→ 應直接從 share 回應解析
- **m-30** `deploy.sh` 50-54：SMOKE_PASSWORD 單引號內插（密碼含 `'` 斷句）；隨機 XFF 可能撞 rate-limit flake

---

## 🔵 Info（10 項）

- **i-1** `server/config.ts` 42-46：intEnv 對非法值靜默 fallback（無警告）；login window 15 分鐘不可調
- **i-2** `router.ts` 58-59：啟動時 cleanupExpired 無 try/catch → 單次 DB 暫時錯誤可讓 server 起不來（pm2 無限重啟）
- **i-3** `request-ip.ts` 14-18：取不到連線位址全回落共用 key "unknown"（多請求共用一桶）
- **i-4** `share-page.ts` 361-368：XSS 面檢查——檔名/錯誤/標題注入點全部正確 escapeHtml（&<>"\' 全轉義）、inline script 無服務端變數拼接 → **正面確認無漏洞**，建議加 XSS 回歸測試
- **i-5** `src/three/Scene3D.tsx` 35-115、246-260：dispose 完全依賴 R3F auto-dispose（現況正確）；自訂 ShaderMaterial/TubeGeometry 建議補顯式 dispose 註解
- **i-6** `src/index.css` 整體：1548 行單檔、6 個分散 reduced-motion 區塊、同選擇器跨章節重宣告 → 建議按 owner 拆分
- **i-7** `src/content.ts` 12/20-24：allowlist HTML（br/strong/span.red）隱性依賴 CSS 對應（.hero-tag 內 strong/red 無樣式）；`\"` 跳脫風格不一致 → 檔頂註解明列 allowlist
- **i-8** API 契約比對：client api.ts 9 個呼叫 vs server 路由 **method+URL+回應欄位全部一致，零 mismatch**（正面確認）
- **i-9** `ecosystem.config.example.cjs`/README：isMain→isDirectRun 舊稱、FileListItem.ttlSec 為死欄位（client 自己重算 expiry）
- **i-10** `src/audio/engine.ts` 16-47：autoplay 政策下首載 boot 音效必然靜音（設計上可接受，註解已明示）

---

## 實測驗證附錄

| # | 驗證項目 | 方法 | 結果 |
|---|---------|------|------|
| V1 | C-1 XFF 繞過 | 同 XFF 錯 pin ×11 → 換 XFF 再錯 | 同 IP 第 11 次 **429**；換 XFF **401**（繞過成功） |
| V2 | M-1 GET 無限速 | 單 IP GET 不存在 shareId ×15 | **404 ×15、零 429** |
| V3 | M-2 過期仍可下載 | expire_time 改到過去 → 下載/GET/list | 下載 **200**、分享頁 **200**、list 仍列出；重啟 sweep 後 **404** |
| V4 | 測試基線 | `npm test`（本地） | 35/35 通過（審查期間 sub-agent 亦實跑確認） |

（前端音訊/動畫類 findings 以程式碼證據為主——sandbox chromium 依賴損壞無法自動化；M-5/M-6/M-7 可在有音訊裝置的瀏覽器手動重現確認。）

---

## 正面確認（做得好的部分）

- session HMAC 簽名/驗證 + timingSafeEqual、cookie httpOnly/SameSite=Lax/secure ✓
- SQLite 全 prepared statement、檔名 sanitize + UUID 儲存、busboy 串流 + M3 殘檔清理 ✓
- 分享頁 HTML 所有注入點 escapeHtml、PIN 驗證 timingSafeEqual ✓
- H1 production 預設值防呆（VPS 實測：漏 .env 直接拒啟）✓
- API 契約層零 mismatch ✓
- 測試品質不差：時鐘注入、real cookie、XFF 模擬、中文檔名、login/pin 鎖定都有測 ✓

---

## 總結

| 嚴重度 | 數量 | 優先修復建議 |
|--------|------|------------|
| 🔴 Critical | 1 | C-1（XFF）——修完 rate-limit 才真正有意義，且影響 PIN 保密根本 |
| 🟠 Major | 9 | M-1/M-2 與 C-1 同屬「分享保密/自毀承諾」核心，建議同批；M-4/M-8/M-9 次之 |
| 🟡 Minor | 22 | 挑安全相關（m-5 密碼強度、m-7 CSP）與穩定性（m-13 back 劫持、m-12 updater 副作用）優先 |
| 🔵 Info | 10 | 文件與測試補強（i-8/i-4 正面項留作回歸基準） |
