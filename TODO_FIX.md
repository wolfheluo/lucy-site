# FIXED.md — 動畫卡頓 / 全屏閃爍（flicker）優化紀錄

> 日期：2026-09-06 ｜ 範圍：主站首頁 + 工具頁（src/ 前端動畫）｜ 目標：不改變動畫視覺效果，消除卡段與「一直閃屏幕」。

## TL;DR

卡頓/閃爍不是單一原因，而是「**幾條無條件 60fps rAF 迴圈在每幀強制同步 layout**」+
「**工具頁 code rain 每次 flush 重建整段巨型文字並強制 layout**」+
「**3D WebGL 全螢幕以高 DPR + Bloom 持續滿載、被不透明 Boot 蓋住時仍空轉、GPU context 遺失沒有降級**」三個家族疊加。

## 發現的問題與修復

### 1. ProgressBar（頂端捲動進度條）：永久 rAF + 每幀讀 scrollHeight
- **檔案**：`src/components/Hud.tsx`（ProgressBar）
- **問題**：rAF 無條件自我重排，即使頁面靜止也 60fps 讀 `documentElement.scrollHeight`（強制同步 layout）＋寫 transform。對應先前 code-review **M-6**。
- **修復**：改為「scroll / resize 事件驅動 + rAF 節流」；捲動範圍只在掛載、resize、字型載入後（800ms 校正）量測快取；數值未變不寫 DOM。
- **效果**：靜止時 0 工作；捲動時每幀最多一次 paint，且不再每幀做 layout read。

### 2. Scene3D CameraRig：每幀讀 scrollHeight（layout thrash）
- **檔案**：`src/three/Scene3D.tsx`（CameraRig）
- **問題**：`useFrame` 每幀執行 `scrollHeight - innerHeight`，捲動中每幀強制同步 layout → 掉幀。對應先前 code-review **m-15**。
- **修復**：改用 `maxScroll` ref，僅在掛載 / resize / 字型載入後量測快取；frame loop 只讀 `window.scrollY`（無 layout 的廉價讀取）。
- **效果**：捲動時不再有每幀強制 layout；相機路徑平滑度不變。

### 3. 3D Canvas：GPU 空轉 + 高解析 + context lost 無降級
- **檔案**：`src/three/Scene3D.tsx`、`src/PortfolioPage.tsx`
- **問題**：
  - Boot 不透明層（z-400）蓋住整個畫面時，Canvas 仍在背後全速渲染（frameloop always）。
  - `dpr={[1, 1.75]}` + 全螢幕 `EffectComposer`（Bloom 多 pass + MSAA 4）在 HiDPI 上像素量高 → 過載易觸發 GPU compositor 掉幀/閃爍。
  - 無 `webglcontextlost` 處理（對應先前 code-review **m-14**）：GPU 過載/驅動重設時 context 遺失 → 黑畫面/整屏閃，且永遠不會降級回靜態背景。
- **修復**：
  - `frameloop={active ? "always" : "never"}`，`active` 由 PortfolioPage 的 `bootGone` 控制 → Boot 碎裂退場前 3D **完全不渲染**（畫面被不透明 Boot 蓋住，看不出差異）。
  - `dpr` 上限 1.75 → 1.5（Bloom 輝光風格下肉眼幾乎無差；若偏好更銳利可改回 `[1, 1.75]`）。
  - `onCreated` 掛 `webglcontextlost`：`preventDefault()` 後透過 `onFatal` 上報 → PortfolioPage `setWebglOk(false)` → 自動切 `FallbackBackdrop` 靜態星空，不再黑屏閃爍。

### 4. CustomCursor：指標靜止仍 60fps 空轉
- **檔案**：`src/components/CustomCursor.tsx`
- **問題**：rAF 永久自我重排，指標不動也每幀對 2 個元素寫 `translate3d`。對應先前 code-review **m-16**。
- **修復**：指標「靜止 ≥300ms 且光圈已收斂（<0.6px）」→ 停 loop；`pointermove` 再啟動。速度感知 lerp 公式完全沒動 → 移動手感不變。
- **效果**：靜止時主執行緒零空轉；也避免游標層持續寫 transform 觸發合成。

### 5. code rain：每次 flush 重建 7000 字元巨型文字 + 強制 layout
- **檔案**：`public/code-rain.js`（工具頁 / 分享頁共用單一來源）
- **問題**：`el.textContent += pending` 後又 `slice()` → 每次把整段大文字（最多 ~7000 字元）砍掉重建（O(n²)），且每 60ms `el.scrollTop = el.scrollHeight` 強制同步 layout。對應先前 code-review **M-7**。
- **修復**：
  - 改以 `appendChild(createTextNode(...))` 增量累加，超上限時從前端移除最舊文字節點（容器頂部有 mask 淡出 → 視覺無感）。
  - 移除無意義的 `scrollTop` 寫入（容器是 `overflow: hidden`，非捲動區）。
  - 背景分頁（`document.hidden`）時 `emit()` 直接丟棄輸出 → 不寫 DOM（瀏覽器背景 timer 節流後成本≈0）。
- **效果**：DOM 寫入由「全量重建」降為「增量」，layout 每幀不再被打斷；文字流速與樣式不變。

### 6. 常駐/JS 驅動動畫層沒有固定合成層
- **檔案**：`src/index.css`
- **問題**：scanbar / noise / 進度條 / 自訂游標等持續或 JS 驅動變換的元素，若瀏覽器每幀做「升層/降層」決策，會在部分 GPU/driver 上造成整屏閃爍。
- **修復**：新增「合成層效能」區塊，對 `.fx-layer .scanbar`、`.fx-layer .noise`、`.hud-progress i`、`.cursor-cross`、`.cursor-ring` 設 `will-change: transform`，固定為獨立合成層。
- **效果**：一次建層、只動 transform（純合成，不 repaint）；避免層升降震盪造成的 flicker。

### 7.（順手）GlitchText hover 抖動 timer 疊代
- **檔案**：`src/components/GlitchText.tsx`
- **問題**：hover jitter 的 `setTimeout` 無清理（對應先前 code-review **m-17**），連續 hover 會提前截斷動畫，unmount 後也可能殘留。
- **修復**：改用 ref 保存 timer；重啟前 `clearTimeout`；unmount 清理。
- **效果**：抖動表現更一致，無殘留副作用。

## 變更檔案一覽

| 檔案 | 變更 |
|---|---|
| `src/components/Hud.tsx` | ProgressBar 事件驅動 + rAF 節流（M-6） |
| `src/three/Scene3D.tsx` | CameraRig 快取 maxScroll（m-15）；frameloop 由 active 控制；dpr ≤1.5；contextlost 處理（m-14） |
| `src/PortfolioPage.tsx` | 傳 `active={bootGone}`、`onFatal` → 切 fallback |
| `src/components/CustomCursor.tsx` | 靜止收斂即停 loop（m-16） |
| `src/components/GlitchText.tsx` | hover timer 清理（m-17） |
| `public/code-rain.js` | 增量 TextNode + 前端裁剪 + 背景分頁丟棄輸出 + 移除 scrollTop（M-7） |
| `src/index.css` | 常駐動畫層 `will-change: transform` 固定合成層 |

## 影響 / 效益

- 首頁「靜止停留」時，原先 **3 條無條件 rAF（ProgressBar + CustomCursor + 3D）** 只剩 3D 一條在跑；3D 又被 DPR 上限 + boot 期間停機節流。
- 捲動時不再有每幀 `scrollHeight` 強制 layout；3D 相機路徑與頂端進度條仍即時更新。
- 工具頁 code rain 由「每 60ms 重建 7000 字元文字 + 強制 layout」變為「增量小節點」，File Vault 操作畫面主執行緒壓力大幅下降。

## 建議驗證（需要你在有 GPU 的瀏覽器實測）

```bash
npm run dev   # http://localhost:5173
```

1. DevTools → Rendering → 勾選 **Paint flashing / Layer borders / Frame Rendering Stats**：
   - 頁面靜止時不應再有全螢幕綠色 repaint flash；
   - 游標不動時 Frame Rendering Stats 的 rAF 應該接近 0（除 WebGL 外）。
2. 首頁進 Boot → 碎裂退場全程：開頭 2~3 秒 3D 不渲染（省 GPU），退場後月球正常動。
3. 上下捲動：進度條平滑、月球推進平滑、無閃爍。
4. 進入任一工具頁：背景 code rain 流速不變，操作（上傳/鎖定畫面）不卡。
5. DevTools → Performance 錄一段「捲動 + 游標移動 + 進入工具頁」，確認 Long Tasks 明顯減少、沒有大面積 forced reflow。
6. 如果還想更省 GPU：可把 `Scene3D.tsx` 的 `dpr={[1, 1.5]}` 再降到 `[1, 1.25]`（更糊一點）。

## 其他發現（未更動，需你決定）

- **CRT 圖層疑似尺寸缺失**：`.fx-layer` 內 `.scanlines / .vignette / .noise` 在 `index.css` 沒有 `position: absolute; inset: 0`（只有 `.scanbar` 有 `height: 34%`），目前實際上看得到的是移動掃描光條；掃描線/雜訊/暗角很可能根本沒作用。刻意**沒有**幫它們補尺寸，因為一補會：(a) 改變目前視覺；(b) 在 WebGL 上方新增全螢幕 blend/repaint 層，可能再度觸發閃爍。若 CRT 開關本來就該顯示這些效果，建議另開一個 task 確認後再復原。
- `.tool-shell::before` 的 `dustDrift`（60s background-position 動畫）仍會每幀 repaint 全螢幕星塵（工具頁）；已不動它以維持原視覺。若工具頁仍卡，下一步可把它改成「oversized + transform」或拆多層。
