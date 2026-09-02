// =====================================================================
//  FILE VAULT 公開分享頁（伺服器端精簡 HTML，零 React）
//  - 訪客不需要下載 1.3MB SPA bundle，秒開
//  - 內嵌 NETRUNNER 風格（深空背景 / Rajdhani / 冰藍 / scanlines）
// =====================================================================

export interface SharePageState {
  /** null = 分享不存在 */
  shareId: string | null;
  fileName?: string;
  sizeFmt?: string;
  error?: string;
  /** rate-limit 鎖定（秒） */
  lockedSec?: number;
}

const FONT =
  'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Noto+Sans+TC:wght@300;400;500&display=swap';

export function fmtSize(n: number): string {
  let v = n;
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (v < 1024 || unit === "TB") {
      return unit === "B" ? `${v} B` : `${v.toFixed(1)} ${unit}`;
    }
    v /= 1024;
  }
  return `${n} B`;
}

export function sharePageHtml(s: SharePageState): string {
  const title = s.shareId ? "FILE VAULT // 檔案保險箱" : "404 // 連結失效";
  const errLine = s.lockedSec
    ? `嘗試次數過多，已鎖定 ${s.lockedSec} 秒`
    : s.error ?? "";

  const body = !s.shareId
    ? `<div class="dead">LINK EXPIRED // 連結不存在或已自毀</div>`
    : `
    <div class="file">
      <div class="file-name">${escapeHtml(s.fileName ?? "FILE")}</div>
      <div class="file-size">${s.sizeFmt ?? ""}</div>
    </div>
    <form method="post" autocomplete="off">
      <label for="pin">ENTER PIN</label>
      <input id="pin" name="pin" inputmode="numeric" maxlength="4"
             placeholder="••••" required autofocus />
      <button type="submit">DECRYPT ▸</button>
    </form>
    ${errLine ? `<div class="err">✕ ${escapeHtml(errLine)}</div>` : ""}
    <div class="note">此檔案將於分享後 72 小時自動湮滅</div>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#07070b" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="${FONT}" rel="stylesheet" />
<style>
  :root { --bg:#07070b; --ice:#a8e6ff; --ice-deep:#5fb8e6; --cold:#eef7ff;
          --pink:#ff9fe5; --red:#ff2e4d; --text:#d9e7f2; --dim:#8ba2b8; --faint:#56697c; }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; background:
      radial-gradient(900px 600px at 80% 10%, rgba(140,205,255,.07), transparent 60%),
      radial-gradient(700px 500px at 10% 90%, rgba(255,159,229,.05), transparent 55%),
      var(--bg);
    color: var(--text); font-family: "Noto Sans TC", sans-serif; font-weight: 300;
    display: flex; align-items: center; justify-content: center; padding: 6vh 5vw;
  }
  .panel {
    width: min(480px, 100%); position: relative;
    background: rgba(12,16,24,.6); border: 1px solid rgba(160,215,255,.14);
    border-radius: 14px; padding: 3rem 2.6rem 2.4rem;
    box-shadow: 0 18px 50px rgba(0,0,0,.5);
    overflow: hidden;
  }
  .panel::before {
    content:""; position:absolute; inset:0; pointer-events:none;
    background: repeating-linear-gradient(0deg, rgba(0,0,0,.14) 0 1px, transparent 1px 3px);
    opacity:.5;
  }
  .os {
    font-family: Rajdhani, sans-serif; font-weight:600; letter-spacing:.5em;
    font-size:.85rem; color: var(--faint); text-align:center; margin-bottom:2rem;
  }
  .os b { color: var(--ice-deep); font-weight:600; }
  .file { text-align:center; margin-bottom:2rem; }
  .file-name {
    font-family: Rajdhani, "Noto Sans TC", sans-serif; font-weight:600;
    font-size: clamp(1.3rem, 4.5vw, 1.9rem); letter-spacing:.08em; color: var(--cold);
    text-shadow: 0 0 18px rgba(168,230,255,.35); word-break: break-all;
  }
  .file-size { margin-top:.5rem; font-family: Rajdhani; letter-spacing:.4em;
    font-size:.8rem; color: var(--dim); }
  form { display:flex; flex-direction:column; gap:.6rem; }
  label { font-family: Rajdhani; font-size:.72rem; letter-spacing:.45em; color: var(--ice); }
  input {
    background: rgba(160,215,255,.05); border:1px solid rgba(160,215,255,.25);
    border-radius:8px; color: var(--cold); font-family: Rajdhani; font-weight:600;
    font-size:2rem; letter-spacing:1em; text-align:center; padding:.55rem .2rem .55rem 1em;
    caret-color: var(--ice); outline: none;
  }
  input:focus { border-color: var(--ice); box-shadow: 0 0 18px rgba(168,230,255,.15); }
  button {
    margin-top:.4rem; font-family: Rajdhani; font-weight:700; letter-spacing:.35em;
    font-size:.95rem; color:#07070b; background: linear-gradient(90deg, var(--ice-deep), var(--ice));
    border:0; border-radius:8px; padding:.85rem; cursor:pointer; transition: filter .2s;
  }
  button:hover { filter: brightness(1.15); }
  .err { margin-top:1.1rem; text-align:center; font-family: Rajdhani; letter-spacing:.25em;
    font-size:.85rem; color: var(--red); text-shadow: 0 0 12px rgba(255,46,77,.5); }
  .note { margin-top:1.6rem; text-align:center; font-size:.68rem; letter-spacing:.3em;
    color: var(--faint); }
  .dead { text-align:center; font-family: Rajdhani, sans-serif; font-weight:600; letter-spacing:.35em;
    color: var(--red); text-shadow: 0 0 20px rgba(255,46,77,.4); padding:2rem 0;
    font-size: clamp(1rem,3vw,1.3rem); }
  /* 背景偽駭客代碼流（與 /code-rain.js 搭配） */
  #rain {
    position: fixed; inset: 0; z-index: 0; overflow: hidden;
    padding: 10vh 8vw 14vh 5vw;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: clamp(8px, .72vw, 11px); line-height: 1.6;
    color: rgba(168,230,255,.13); text-shadow: 0 0 8px rgba(168,230,255,.14);
    white-space: pre-wrap; word-break: break-all;
    pointer-events: none; user-select: none;
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 10%, #000 78%, transparent 100%);
    mask-image: linear-gradient(180deg, transparent 0, #000 10%, #000 78%, transparent 100%);
  }
  .panel { position: relative; z-index: 1; }
  /* 上下往返光條（CRT 掃描光束） */
  .scanbeam {
    position: fixed; left: 0; right: 0; height: 130px; z-index: 2;
    pointer-events: none;
    background: linear-gradient(180deg,
      transparent,
      rgba(168,230,255,.05) 38%,
      rgba(168,230,255,.14) 50%,
      rgba(168,230,255,.05) 62%,
      transparent);
    animation: beamPingPong 7s ease-in-out infinite alternate;
  }
  @keyframes beamPingPong {
    from { top: -22%; }
    to { top: calc(100% - 90px); }
  }
  @media (prefers-reduced-motion: reduce) {
    #rain { display: none; }
    .scanbeam { animation: none; display: none; }
  }
</style>
</head>
<body>
  <div id="rain" aria-hidden="true"></div>
  <div class="scanbeam" aria-hidden="true"></div>
  <main class="panel">
    <div class="os">NETRUNNER // <b>FILE VAULT</b></div>
    ${body}
  </main>
  <script src="/code-rain.js"></script>
  <script>
    (function () {
      var el = document.getElementById("rain");
      if (el && window.startCodeRain) window.startCodeRain(el);
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
