# 🌕 WOLFHELUO // lucy-site

以《電馭叛客：邊緣行者》露西為靈感的 3D 個人網站，外加一組跑在同一個 Node 進程上的
全棧小工具（Hono + SQLite + React）。

線上：<https://wolfheluo.com>（前台與 API 同一個服務；工具區需管理員登入）

```
瀏覽器 ─┬─ /               作品集（R3F 月球、Boot 序列、HUD）
        ├─ /tools/<id>     工具頁（lazy chunk，各自登入狀態）
        └─ /s/<shareId>    檔案分享公開頁
                 │
        Hono（單一進程，production 同時 serve dist/）
        ├─ /api/auth/*           管理員 session（HMAC cookie）
        ├─ /api/tools/<id>/*     各 tool 自行掛載
        ├─ /api/deepseek/balance nav 顯示餘額（無 key 則隱藏）
        └─ 引擎 ×3               binance / dy-monitor / dy-enter（自排程計時器）
```

## 快速開始

```bash
npm install
npm run dev        # vite :5173 + Hono API :3001（/api、/s/ 由 vite proxy 轉發）
npm run build      # tsc -b + vite build → dist/，tsc -p tsconfig.server.json → dist-server/
npm start          # node dist-server/server/index.js
npm test           # vitest（node 環境，直接 app.request() 打 Hono app）
npm run lint       # oxlint
npm run typecheck:app / typecheck:server
```

- Node ≥ 22（CI 用 22；`.env` 由 `process.loadEnvFile()` 讀取，需 ≥ 20.12）。
- 複製 `.env.example` 為 `.env` 再填值；本機開發可全部留空（預設密碼 `admin123` 只在非 production 生效）。
- `BQ_DEMO=1` 會把幣安引擎換成假行情來源（僅供 e2e 版面驗證，UI 不會標示 demo）。

## 技術棧

- **前端**：Vite + React 19 + TypeScript、React Three Fiber v9（drei、postprocessing：Bloom／Vignette／ACES）、Framer Motion
- **後端**：Hono 4（`@hono/node-server`）+ better-sqlite3（同步寫入，毫秒級結算）
- **工具鏈**：oxlint、vitest（node 環境）、Playwright（e2e）、tsx（dev server）
- **字型／素材**：Rajdhani + Noto Sans TC（Google Fonts）；月球貼圖 `public/textures/moon.jpg`（NASA 公有領域，1024×512 equirectangular）

## 專案結構

```
src/            前台作品集（content.ts 是唯一內容來源）
  three/        月球、單分子線、相機捲動路徑、Bloom（React.lazy 獨立 chunk）
  components/   BootScreen / Hud / GlitchText / Sections / CustomCursor / ToolShell / ToolFrame
  audio/        Web Audio 合成音效 + public/bgm.mp3 氛圍樂
server/         Hono app：config / auth / rate-limit / request-ip / db / tool registry
  registry.ts   ★ 新增 tool 的後端註冊點
tools/          全棧工具，一資料夾一包（meta + server + client），契約見 tools/README.md
scripts/        運維與驗證腳本（見下表）
tests/          vitest（20 檔）；tests/e2e/ 為 Playwright（3 個 spec）
data/           SQLite + 上傳檔（gitignored）
```

## 工具一覽

| id | 名稱 | 做什麼 | 資料 |
|---|---|---|---|
| `file-vault` | FILE VAULT 檔案保險箱 | 上傳後 72 小時自動湮滅；分享連結以 4 位 PIN 保護，錯 3 次鎖 60 秒；公開下載走 `/s/:shareId` | `vault.db` |
| `binance-api` | BINANCE QUANT 幣安即時量化監控 | BTCUSDT 永續：成交、1 分 CVD、未平倉量、深度失衡、大額爆倉（預設 ≥50k USDT）；兩套紙上策略（`cvd_breakout`、`liquidation_reversal`），SSE 推送面板 | `vault.db` |
| `dy-monitor` | DOUYIN MONITOR 抖音直播監控台 | 直播間數據觀測：在線人數曲線、彈幕、禮物貢獻榜、粉絲親密度、開播／下播通知（LINE），場次永久保存可複盤 | `dy-monitor.db` |
| `dy-enter` | ENTER LOG 抖音進場名單 | 只記錄進場：uid／抖音號／進場次數，標註「神秘人」與「疑似隱身」，場次可切回 | `dy-enter.db` |

- 工具頁面與作品集卡片由 `tools/<id>/meta.ts` 產生，不需手動加路由或卡片。
- 抖音相關工具使用未公開的 webcast 端點，實作細節與已知限制分別見 `tools/dy-monitor/README.md`、`tools/dy-enter/README.md`。

## 架構要點

- **單一進程**：Hono 同時提供 API、production 的靜態檔與 SPA fallback；未匹配路由一律 JSON 404。
- **tool 契約**：`tools/<id>/meta.ts`（純資料）+ `tools/<id>/server/router.ts`（`register(app, ctx)`）+ `tools/<id>/client/`（預設匯出的頁面元件），註冊只改 `server/registry.ts` 與 `src/tools.ts` 各一行。完整五步見 `tools/README.md`。
- **lazy 分包**：3D 場景、每個工具頁、dy-monitor 歷史頁各自獨立 chunk；首載只有核心 UI。
- **引擎生命週期**：dy-monitor 只在 `NODE_APP_INSTANCE` 不存在或 `0` 時啟動（避免多 worker 重複輪詢、重複通知）；SIGINT/SIGTERM 前呼叫 `handle.settle()` 結算（幣安紙上部位）。
- **資料庫分離**：`vault.db`（站台帳號、檔案、幣安表）、`dy-monitor.db`（事件級資料，約 104 MB／房／日，故獨立）、`dy-enter.db`（場次與進場）。
- **安全基線**：管理端一律 `requireAuth`；登入失敗以 IP 計數（預設 5 次／15 分鐘），分享 PIN 錯 3 次鎖 60 秒（4 小寫字母分享碼 + 4 位數 PIN，constant-time 比對）；production 若沿用預設密碼／密鑰會直接拒絕啟動；`X-Forwarded-For` 只在 `TRUST_PROXY=1` 時才信任。

## 環境變數

### server 核心

| 變數 | 必設 | 說明 |
|---|---|---|
| `NODE_ENV` | production | `=production` 才會 serve `dist/`、開 Secure cookie，並啟用預設值防呆 |
| `VAULT_ADMIN_PASSWORD` | ✅ production | 管理員密碼（單一管理員），16+ 字元隨機 |
| `VAULT_SESSION_SECRET` | ✅ production | session cookie 的 HMAC 密鑰，`openssl rand -hex 32` |
| `PORT` | 否 | 預設 `3001` |
| `HOST` | 建議 | 預設 `127.0.0.1`（由 nginx 反代）；需直連才改 `0.0.0.0` |
| `VAULT_DATA_DIR` | 否 | SQLite 與上傳檔目錄，預設 `<cwd>/data` |
| `VAULT_DIST_DIR` | 否 | 前端靜態目錄，production 預設 `<cwd>/dist` |
| `VAULT_LOGIN_RATE_MAX` | 否 | 登入失敗上限（次／15 分鐘），預設 5 |
| `TRUST_PROXY` | 依架構 | **僅**在可信 nginx／CDN 之後設 `1`，否則一律 `0` |
| `START_SERVER` | pm2 | `1` 時無條件 listen；pm2 fork 模式包裝 argv[1] 的必需品（放 ecosystem，不放 `.env`） |

### tools

| 變數 | 工具 | 說明 |
|---|---|---|
| `API_KEY` | DeepSeek | nav 的 CNY 餘額查詢；未設 → 該區塊隱藏 |
| `DY_COOKIE_FILE` | dy-monitor / dy-enter | 抖音 cookie 檔路徑（JSON 陣列或原始 header），預設 `~/dy_cookies.json` |
| `DY_DASHBOARD_URL` | dy-monitor | 通知訊息附帶的連結 |
| `DY_MONITOR_DISABLE` / `DY_ENTER_DISABLE` | 各自 | `1` 停用該引擎（維運或測試時） |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO` | dy-monitor | LINE Messaging API；未設時通知仍會落庫（`ok=0` 附原因） |
| `BQ_DEMO` | binance-api | `1` 使用假行情來源（測試／e2e 版面驗證用） |

## 路由

| 類型 | 路徑 |
|---|---|
| 前端 | `/`、`/tools/:toolId`、`/tools/dy-monitor/history`、`/tools/dy-monitor/history/:sid`、`/s/:shareId` |
| 平台 API | `/api/health`、`/api/auth/{login,logout,me}`、`/api/deepseek/balance` |
| 工具 API | `/api/tools/<id>/*`（各自掛載；管理端需 session） |

## 上線前要做的

1. `src/content.ts`：替換所有範例內容（名字、自我介紹、技能、作品、信箱與社群連結）；`index.html` 的 title／description／JSON-LD 與它同源，改名時兩處都要改。
2. （可選）換更高解析度的月球貼圖（NASA/LROC，equirectangular 2:1）。
3. 依下方「部署」設好 `.env` 並以 pm2 常駐；production 漏設密碼／密鑰會直接拒絕啟動。

## 部署

**CI/CD**（`.github/workflows/ci.yml`）：push／PR → `npm test`；`main` push 且測試通過 → build → `deploy.sh`。
需要 repo secrets：`DEPLOY_SSH_KEY`、`DEPLOY_SERVER`、`SMOKE_PASSWORD`（fork 的 PR 讀不到 secrets，因此只有 maintainer push 會部署）。

**部署形狀**：伺服器只收到 `dist/`、`dist-server/`、`package.json`、`package-lock.json`；`node_modules` 由伺服器自己產生；每次部署是一個 `releases/<sha>/`，由 `current` symlink 指過去，health 沒過就自動切回上一版。app 目錄因此只該有 `releases/`、`current`、`.env`（`data/` 用 `VAULT_DATA_DIR` 放別處）。

```bash
SERVER=user@host SMOKE_PASSWORD=xxx ./deploy.sh     # KEEP_RELEASES=3 可改保留份數（預設 5）
# 1) 本地 production build（server 不含 sourcemap）
# 2) scp 產物到 /tmp/lucy-deploy-<sha>
# 3) 建 releases/<sha>：lock 未變 → 硬連結上一版 node_modules；變更 → npm ci --omit=dev
#    切 current + startOrReload，15 秒內 health 沒過就回滾並以非 0 結束
# 4) auth 冒煙：登入 → 上傳 → 分享 → 錯 PIN 401 → 正確 PIN 下載比對 → 清理
# 5) 列出 app 目錄的非執行期殘留（只報告，不動手）
```

- **pm2（一次性、需手動）**：`cwd` 必須是 `/www/wwwroot/lucy-site`（不能是 `current/`，否則 `cwd/.env` 讀不到），`script` 必須是 `./current/dist-server/server/index.js`。`deploy.sh` 會先檢查 ecosystem 檔（預設 `/www/ecosystem-lucy.config.cjs`，可用 `ECOSYSTEM=` 覆寫）不符就停手。
- **依賴**：`package-lock.json` 沒變就不碰 `node_modules`（`cp -al` 硬連結）；變了才該版 `npm ci --omit=dev --ignore-scripts`。`--ignore-scripts` 是刻意的：better-sqlite3 13.x 的 npm tarball 內含 Node-API prebuild（`prebuilds/linux-x64.node`），但 npm 仍會因為 `binding.gyp` 去跑 `node-gyp rebuild` —— 略過它，伺服器就不需要 python3／make／g++，安裝失敗也不影響線上那版。
- **回滾**：`sudo ln -sfn releases/<舊sha> current && pm2 startOrReload`；`deploy.sh` 在 health 失敗時會自動做。
- **殘留清理**：`scripts/server-prune.sh`（預設 dry-run，`--apply` 才刪），把 `src/`、`tests/`、舊 `dist/` 等非執行期檔案清掉；`data/` 需明示 `--delete-data`。
- **nginx**：`proxy_pass http://127.0.0.1:3001;` 並轉發 `X-Forwarded-For`（同時 `.env` 設 `TRUST_PROXY=1`）。
- **備份**：`scripts/backup-dbs.mjs` 以 better-sqlite3 線上 backup API 每日 04:10 備份 `vault.db`、`dy-monitor.db`、`dy-enter.db`，各保留 7 份（`BACKUP_KEEP` 可調）。
- **靜態託管不可行**：`dist/` 丟上 Vercel／Cloudflare Pages 只會得到首頁空殼，四個工具都依賴 `/api`。

## 腳本

| 腳本 | 用途 |
|---|---|
| `scripts/backup-dbs.mjs` | `vault.db` + `dy-monitor.db` + `dy-enter.db` 每日輪替備份 |
| `scripts/server-prune.sh` | 清 app 目錄的非執行期殘留（預設 dry-run，`--apply` 才刪） |
| `scripts/dy-cli.mjs` | dy-monitor CLI：`list` / `show <sid>` / `events <sid> --type --limit`（`DY_CLI_PASSWORD`） |
| `scripts/import-dy-monitor.mjs` | 一次性把舊 Python 版 `monitor.db` 匯入 `dy-monitor.db` |
| `scripts/dy-ui-check.mjs` | 登入牆 → 儀表板 → 抽屜 → 手機版面，console 錯誤即失敗 |
| `scripts/dy-layout-check.mjs` | 1440×900 / 1180×800 / 390×844 版面量測 |
| `scripts/dy-history-ui-check.mjs` | 歷史列表 → 單場詳情 → 事件篩選／搜尋 |
| `scripts/dy-drawer-check.mjs` | 抽屜不遮頂欄、輸入列單行 |
| `scripts/dy-fans50-check.mjs` | 親密度榜 50 列渲染（注入 60 名成員） |

## 測試

- `tests/*.test.ts(x)`：20 個 vitest 檔，node 環境，直接對 Hono app 發請求（auth、rate limit、file-vault、vault、binance 引擎／策略／資本、dy-monitor parser／store／engine／abogus／API、DeepSeek 餘額、元件測試）。`better-sqlite3` 在部分沙箱會 segfault，必要時改在 VPS 以部署後的 `dist-server` 驗證。
- `tests/e2e/*.spec.ts`：3 個 Playwright spec（版面、file-vault、路由轉場），以 `reducedMotion` 跳過 Boot，`BQ_DEMO=1` + 獨立 `VAULT_DATA_DIR` 避免污染資料。`webServer` 指令使用 `rm -rf`，**需 POSIX shell**（WSL／Linux／CI）。

## 設計細節

- **色盤**：太空黑 `#07070b`、冰藍 `#a8e6ff`、冷白、粉紫 `#ff9fe5`、螢光紅 `#ff2e4d`（僅單分子線／警示）。
- **3D 相機路徑**：Hero 全景 → About/Skills 推進繞行 → Projects 換側 → Contact 拉遠；關鍵影格在 `src/three/Scene3D.tsx`（`CAM_PTS` / `LOOK_PTS`），阻尼平滑 + 滑鼠視差。
- **解碼動畫**：Hero 名字於 Boot 結束後啟動；段落標題首次進入 viewport 解碼一次；hover 觸發短促抖動。
- **音效**：互動音為 Web Audio 即時合成；右下 MUSIC 開關才載入 `public/bgm.mp3`（預設關閉，符合瀏覽器 autoplay 政策）。
- **降級與效能**：行動裝置／`prefers-reduced-motion`／WebGL 失效 → 靜態星空 `FallbackBackdrop`；3D 在 Boot 覆蓋期間 `frameloop="never"`、DPR ≤1.5、`webglcontextlost` 自動降級；CRT 濾鏡與自訂游標可一鍵關閉。

## 文件索引

| 文件 | 內容 |
|---|---|
| `tools/README.md` | tool 契約與「新增一個 tool」的五步 |
| `tools/dy-monitor/README.md` | 抖音監控：輪詢節奏、資料模型、HTTP API、session 續接規則、已知限制 |
| `tools/dy-enter/README.md` | 抖音進場名單：抓什麼、標記規則、API |
| `code-review.md` | 2026-09 安全審計與修補決策紀錄（含刻意不修的項目與理由） |
| `TODO_FIX.md` | 前端卡頓／閃爍的診斷與修復紀錄（rAF、layout thrash、code rain） |

## 已知事項

- 3D 場景（three.js 全家桶）已 `React.lazy` 分包為獨立 chunk：首載只下載核心 UI，啟用 WebGL 時才補載（gzip 約數百 KB）。
- drei 內部使用 `THREE.Clock`，three 0.185 會印一條 deprecation warning，無害，等 drei 升級即可。
- dy-monitor 的事件級資料無限成長，清理是手動操作；硬碟用量在儀表板與 `/health` 可見。
- 抖音端點未公開且可能隨時變更；`im/fetch` protobuf 或 `a_bogus` 演算法改動時需同步更新 `tools/dy-monitor/server/`，簽名失效只降級「觀眾榜」單一區塊。
- e2e（`tests/e2e`）以 POSIX shell 為前提，Windows 本機請在 WSL／CI 執行。
