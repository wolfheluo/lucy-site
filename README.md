# 🌕 Lucy // Netrunner 個人網站

以《電馭叛客：邊緣行者》露西為靈感的 3D 個人作品集網站。
真實月球貼圖 + 捲動驅動的相機路徑（鏡頭隨捲動向月球推進）+ 冰藍/粉紫霓虹氛圍 +
紅色單分子線（Bloom）+ 亂碼解碼 glitch 動畫 + CRT 濾鏡 + Web Audio 合成音效。

## 快速開始

```bash
npm install
npm run dev      # 本機開發 → http://localhost:5173（同時啟動 vite + Hono API:3001）
npm run build    # production build → dist/ + dist-server/
npm run preview  # 預覽 production build
npm test         # vitest（單元 + API 整合）
```

> env 設定：server 端支援根目錄 `.env`（複製 `.env.example` 並填值）；本機開發可不設，
> production **必須**設定 `VAULT_ADMIN_PASSWORD` 與 `VAULT_SESSION_SECRET`（見下）。

## 技術棧

- **Vite + React 19 + TypeScript**
- **React Three Fiber v9** + drei + @react-three/postprocessing（Bloom / Vignette / ACES）
- **Framer Motion**（進場動畫、whileInView、Boot 退場）
- 月球貼圖：`public/textures/moon.jpg`（NASA 公有領域來源，1024×512）
- 字型：Rajdhani（英文大標）+ Noto Sans TC（中文），Google Fonts

## 檔案結構

```
src/
├── content.ts            ★ 唯一要改的內容檔（名字、技能、作品、聯絡…全在這裡）
├── App.tsx               組合與降級邏輯（行動/無 WebGL/reduced-motion）
├── index.css             主題：色盤變數、CRT、glitch、玻璃卡片、游標…
├── hooks.ts              media query / WebGL 偵測
├── audio/engine.ts       Web Audio 合成：互動音效 + 氛圍 pad（無外部音檔）
├── three/Scene3D.tsx     月球、大氣光暈、單分子線、星塵、相機捲動路徑、Bloom（lazy 分包）
└── components/
    ├── BootScreen.tsx    「深潛啟動」載入畫面（可跳過）
    ├── GlitchText.tsx    亂碼解碼元件（inView / 外部觸發 / hover 抖動）
    ├── CustomCursor.tsx  十字準星 + hover 掃描光圈（僅 pointer:fine）
    ├── Hud.tsx           導覽、捲動進度條、CRT / MUSIC 開關
    ├── Sections.tsx      Hero / About / Skills / Projects / Contact
    └── FallbackBackdrop.tsx  行動版 / 無 WebGL 靜態背景

server/                  Hono API（auth / session / rate-limit / config）；production 亦 serve dist/
tools/                   可註冊的全棧工具（FILE VAULT：meta / server / client），見 tools/README.md
tests/                   vitest 單元與 API 整合測試（直接打 Hono app）
tests/e2e/               Playwright E2E（需要 POSIX shell，建議在 CI / WSL 執行）
```

## 上線前要做的

1. 打開 `src/content.ts`，替換所有範例內容（名字、自我介紹、技能、3 個作品、信箱與社群連結）。
2. （可選）把月球貼圖換成更高解析度的 NASA/LROC 版本，例如
   `lroc_color_poles_2k.jpg`（NASA 公有領域，貼圖須為 equirectangular 2:1）。
3. 純靜態站：`npm run build` 後把 `dist/` 丟上 Vercel / Cloudflare Pages 即可（不含 file-vault）。
4. 若要啟用 FILE VAULT（管理上傳＋公開分享），需要跑 Hono server：`npm run build && npm start`，
   並設定下列 env（production 漏設密碼/密鑰會**直接拒絕啟動**）：

   | env | 必設 | 說明 |
   |---|---|---|
   | `VAULT_ADMIN_PASSWORD` | ✅（production） | 管理員密碼，建議 16+ 字元隨機 |
   | `VAULT_SESSION_SECRET` | ✅（production） | session cookie HMAC 密鑰，`openssl rand -hex 32` |
   | `NODE_ENV` | production | `=production` 自動 serve `dist/`、開啟 Secure cookie |
   | `HOST` | 建議 | 預設 `127.0.0.1`（由 nginx 反代）；需直連才改 `0.0.0.0` |
   | `TRUST_PROXY` | 依架構 | **僅**在可信 nginx/CDN 後方設 `1`（才信任 X-Forwarded-For） |
   | `PORT` | 否 | 預設 3001 |
   | `VAULT_DATA_DIR` | 否 | 資料目錄（SQLite＋上傳檔），預設 `./data` |

   ```bash
   cp .env.example .env   # 填入真實密碼/密鑰，再
   npm run build && npm start
   ```

   nginx 反代建議：`proxy_pass http://127.0.0.1:3001;` 並設定
   `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`（同時 `.env` 設 `TRUST_PROXY=1`）。

## 設計細節

- **色盤**：太空黑 `#07070b`、冰藍 `#a8e6ff`、冷白、粉紫 `#ff9fe5`、螢光紅 `#ff2e4d`（僅單分子線/警示用）。
- **3D 相機路徑**：Hero 全景 → About/Skills 推進繞行 → Projects 換側 → Contact 拉遠，路徑關鍵影格在
  `src/three/Scene3D.tsx` 的 `CAM_PTS / LOOK_PTS`，平滑阻尼 + 滑鼠視差。
- **解碼動畫**：Hero 名字在 Boot 完成後開始；段落標題首次進入 viewport 解碼一次；hover 會抖動。
- **音效**：點擊/解碼/Boot 音效為合成音；右下 MUSIC 開關播放合成氛圍 pad（預設關閉，瀏覽器
  autoplay 政策下本來就需要使用者先互動）。
- **降級**：行動裝置與 `prefers-reduced-motion` 使用者看到靜態星空背景；WebGL 失效自動切換；
  CRT 濾鏡與自訂游標可一鍵關閉。

## 已知事項

- 3D 場景（three.js 全家桶）已用 `React.lazy` 分包為獨立 chunk：首載只下載核心 UI，
  進入首頁啟用 WebGL 時才補載 3D chunk（gzip 約數百 KB）。
- drei 內部使用 `THREE.Clock`，three 0.185 會印一條 deprecation warning，無害，等 drei 升級即可。
- e2e（`tests/e2e`）目前以 POSIX shell 為前提，Windows 本機請在 WSL / CI 執行。
