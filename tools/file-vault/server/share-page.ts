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
  /** 鎖定剩餘秒（429 回應） */
  lockedSec?: number;
  /** 鎖定到期絕對時間戳（epoch ms，前端精確倒數用） */
  lockUntil?: number;
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
  // 錯 PIN → denied（入侵反應動畫）；鎖定 → locked（能量封鎖 + 倒數）
  const bodyCls = s.shareId
    ? s.lockedSec
      ? `locked" data-lock-until="${s.lockUntil ?? 0}`
      : s.error
        ? "denied"
        : ""
    : "";
  const bodyAttr = bodyCls ? ` class="${bodyCls}"` : "";
  const title = s.shareId ? "FILE VAULT // 檔案保險箱" : "404 // 連結失效";
  // locked：倒數 HTML 原樣（數字安全）；error：純文字需 escape
  const errHtml = s.lockedSec
    ? `嘗試次數過多，已鎖定 <b id="lockcd">${s.lockedSec}</b> 秒`
    : s.error
      ? escapeHtml(s.error)
      : "";

  const body = !s.shareId
    ? `<div class="dead">LINK EXPIRED // 連結不存在或已自毀</div>`
    : `
    <div class="file">
      <div class="file-name">${escapeHtml(s.fileName ?? "FILE")}</div>
      <div class="file-size">${s.sizeFmt ?? ""}</div>
    </div>
    <form method="post" autocomplete="off">
      <label for="pin">
        ENTER PIN
        ${s.lockedSec ? '<span class="lock-badge">⛓ LOCKED</span>' : ""}
      </label>
      <input id="pin" name="pin" inputmode="numeric" maxlength="4"
             placeholder="••••" required autofocus${s.lockedSec ? " disabled" : ""} />
      <button type="submit"${s.lockedSec ? " disabled" : ""}>DECRYPT ▸</button>
    </form>
    ${errHtml ? `<div class="err">✕ ${errHtml}</div>` : ""}
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
  .err {
    margin-top:1.1rem; text-align:center; font-family: Rajdhani; letter-spacing:.25em;
    font-size:.85rem; color: var(--red); text-shadow: 0 0 12px rgba(255,46,77,.5);
    animation: errIn .4s steps(2) 1;
  }
  @keyframes errIn {
    0% { opacity:0; transform: translateX(-10px) skewX(-10deg); filter: blur(2px); }
    30% { opacity:1; text-shadow: 4px 0 var(--ice), -4px 0 var(--pink), 0 0 18px rgba(255,46,77,.9); }
    60% { transform: translateX(4px) skewX(4deg); }
    80% { text-shadow: -3px 0 var(--ice), 3px 0 var(--pink); }
    100% { transform: none; }
  }
  /* 錯 PIN「入侵反應」（body.denied，載入播放一次） */
  body.denied::after {
    content: ""; position: fixed; inset: 0; z-index: 5; pointer-events: none;
    background: radial-gradient(ellipse at center, transparent 42%, rgba(255,46,77,.26) 100%);
    animation: denyFlash .9s ease-out 1;
  }
  @keyframes denyFlash {
    0% { opacity: 0; } 12% { opacity: 1; }
    38% { opacity: .2; } 62% { opacity: .6; } 100% { opacity: 0; }
  }
  body.denied .panel {
    animation: panelRip .55s steps(3) 1;
    border-color: rgba(255,46,77,.65);
    box-shadow: 0 0 46px rgba(255,46,77,.28), 0 18px 50px rgba(0,0,0,.5);
  }
  @keyframes panelRip {
    0% { clip-path: inset(0 0 0 0); transform: translate(0) skewX(0); }
    15% { clip-path: inset(6% 0 48% 0); transform: translate(-9px, 2px) skewX(-2.5deg); }
    30% { clip-path: inset(42% 0 10% 0); transform: translate(9px, -2px) skewX(2deg); }
    45% { clip-path: inset(66% 0 3% 0); transform: translate(-7px, 2px); }
    60% { clip-path: inset(18% 0 56% 0); transform: translate(6px, -1px) skewX(-1.5deg); }
    75% { clip-path: inset(50% 0 22% 0); transform: translate(-4px, 1px) skewX(1.5deg); }
    90% { clip-path: inset(3% 0 70% 0); transform: translate(3px, 0); }
    100% { clip-path: inset(0 0 0 0); transform: translate(0); }
  }
  body.denied .file-name {
    animation: textRip .5s steps(2) 2;
  }
  @keyframes textRip {
    0%, 100% { text-shadow: 0 0 18px rgba(168,230,255,.35); transform: none; }
    25% { text-shadow: 4px 0 var(--ice), -4px 0 var(--pink), 0 0 30px rgba(255,46,77,.8); transform: translate(-2px, 1px); }
    50% { text-shadow: -4px 0 var(--ice), 4px 0 var(--red); transform: translate(2px, -1px); }
    75% { text-shadow: 3px 0 var(--pink), -3px 0 var(--ice); transform: translate(-1px, 0); }
  }
  body.denied input {
    border-color: rgba(255,46,77,.7);
    box-shadow: 0 0 22px rgba(255,46,77,.35);
    animation: denyPulse .7s steps(2) 2;
  }
  @keyframes denyPulse {
    0%, 100% { border-color: rgba(255,46,77,.7); box-shadow: 0 0 22px rgba(255,46,77,.35); }
    50% { border-color: rgba(255,46,77,1); box-shadow: 0 0 40px rgba(255,46,77,.6); }
  }
  body.denied .err { color: #ff8094; }
  /* ── 鎖定：能量封鎖（body.locked，429 頁面）── */
  body.locked form { position: relative; }
  body.locked form::before {
    content: ""; position: absolute; top: -8px; bottom: -8px; left: -45%;
    width: 40%; pointer-events: none; z-index: 2;
    background: linear-gradient(90deg, transparent,
      rgba(168,230,255,.28), rgba(255,46,77,.45), transparent);
    animation: lockSweep .7s cubic-bezier(.4,0,.2,1) .15s 1 forwards;
  }
  @keyframes lockSweep {
    0% { left: -45%; filter: blur(6px); }
    60% { filter: blur(0); }
    100% { left: 115%; filter: blur(6px); }
  }
  body.locked label { color: var(--pink, #ff8094); }
  .lock-badge {
    display: inline-block; margin-left: .6rem; font-size: .6rem;
    letter-spacing: .28em; color: #ff8094;
    text-shadow: 0 0 12px rgba(255,46,77,.8);
    animation: lockBlink 1.15s ease-in-out infinite;
  }
  @keyframes lockBlink {
    0%, 100% { opacity: 1; text-shadow: 0 0 12px rgba(255,46,77,.8); }
    50% { opacity: .45; text-shadow: 0 0 4px rgba(255,46,77,.35); }
  }
  body.locked input {
    border-color: rgba(255,46,77,.6);
    background: rgba(255,46,77,.07);
    color: #ff8fa3; cursor: not-allowed;
    animation: lockPulse 1.3s ease-in-out infinite;
  }
  body.locked input::placeholder { color: rgba(255,128,148,.35); }
  @keyframes lockPulse {
    0%, 100% { box-shadow: 0 0 6px rgba(255,46,77,.25); border-color: rgba(255,46,77,.5); }
    50% { box-shadow: 0 0 22px rgba(255,46,77,.5); border-color: rgba(255,46,77,.95); }
  }
  body.locked .err { color: #ff8094; }
  body.locked .err b { font-weight: 700; color: #ff5c74;
    font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) {
    body.denied::after, body.denied .panel, body.denied .file-name,
    body.denied input, .err { animation: none !important; }
    body.locked form::before, body.locked input, .lock-badge { animation: none !important; }
  }
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
  /* 掃描光條（與 file-vault 工具頁 .scanbar 相同效果） */
  .scanbar {
    position: fixed; left: 0; right: 0; top: -34%; height: 34%;
    z-index: 0; pointer-events: none; /* 在 panel(z1) 之後：被玻璃面板蓋住 */
    background: linear-gradient(180deg, transparent,
      rgba(190,235,255,.05) 48%, rgba(190,235,255,.12) 50%,
      rgba(190,235,255,.05) 52%, transparent);
    animation: scanMove 7s linear infinite;
  }
  @keyframes scanMove {
    from { transform: translateY(0); }
    to { transform: translateY(400%); }
  }
  @media (prefers-reduced-motion: reduce) {
    #rain { display: none; }
    .scanbar { animation: none; display: none; }
  }
  /* 成功：ACCESS GRANTED 解碼 + 讀條 overlay */
  .grant {
    position: fixed; inset: 0; z-index: 20;
    display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(700px 460px at 50% 42%, rgba(140,205,255,.09), transparent 65%),
      rgba(4,5,8,.95);
    font-family: Rajdhani, "Noto Sans TC", sans-serif;
  }
  .grant.done { opacity: 0; transition: opacity .25s ease; }
  .grant-box { text-align: center; width: min(540px, 82vw); }
  .grant-os {
    font-size: .72rem; font-weight: 600; letter-spacing: .55em;
    color: var(--faint); margin-bottom: 1.6rem;
  }
  .grant-file {
    font-weight: 700; font-size: clamp(1.5rem, 4.6vw, 2.4rem);
    letter-spacing: .22em; color: var(--ice);
    text-shadow: 0 0 24px rgba(120, 230, 255, .55), 0 0 60px rgba(120,230,255,.2);
    min-height: 1.4em; white-space: nowrap;
  }
  .grant-sub {
    margin-top: .7rem; font-size: .8rem; letter-spacing: .2em;
    color: var(--dim); word-break: break-all;
  }
  .grant-bar {
    margin: 2rem auto 0; height: 3px; width: 100%;
    background: rgba(160,215,255,.12); border-radius: 2px; overflow: hidden;
  }
  .grant-bar i {
    display: block; height: 100%; width: 0;
    background: linear-gradient(90deg, var(--red), var(--pink), var(--ice));
    box-shadow: 0 0 16px rgba(255,159,229,.6);
  }
  .grant-pct {
    margin-top: .9rem; font-weight: 600; font-size: .95rem;
    letter-spacing: .4em; color: var(--ice);
    text-shadow: 0 0 12px rgba(168,230,255,.5);
  }
</style>
</head>
<body${bodyAttr}>
  <div id="rain" aria-hidden="true"></div>
  <div class="scanbar" aria-hidden="true"></div>
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
  <script>
    /* 成功下載儀式：fetch 驗證 → ACCESS GRANTED 矩陣解碼 + 讀條 → 原生 submit */
    (function () {
      var form = document.querySelector("form");
      if (!form) return;
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      var animating = false;
      var CHARS = "01<>/\\#$%&@!?";

      form.addEventListener("submit", function (e) {
        if (animating) return;
        e.preventDefault();
        var pin = (document.getElementById("pin") ? document.getElementById("pin").value : "") || "";
        var url = form.getAttribute("action") || location.pathname;

        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "pin=" + encodeURIComponent(pin),
          credentials: "same-origin"
        }).then(function (res) {
          if (res.status !== 200) {
            // 錯 pin / 鎖定 → 載入 server 錯誤頁（含入侵動畫）
            res.text().then(function (html) {
              document.open();
              document.write(html);
              document.close();
            });
            return;
          }
          if (res.body && res.body.cancel) res.body.cancel(); // 預載中斷（真正下載由原生 submit 進行）
          startGrantFx(function () {
            animating = true;
            form.submit();
          });
        }).catch(function () {
          form.submit(); // fetch 失敗 → 原生（原始行為）
        });
      });

      function startGrantFx(cb) {
        var ov = document.createElement("div");
        ov.className = "grant";
        ov.innerHTML =
          '<div class="grant-box">' +
          '<div class="grant-os">FILE VAULT // 驗證通過</div>' +
          '<div class="grant-file" id="gfile"></div>' +
          '<div class="grant-sub">' + escapeHtml((document.querySelector(".file-name") || {}).textContent || "") + '</div>' +
          '<div class="grant-bar"><i id="gbar"></i></div>' +
          '<div class="grant-pct" id="gpct">000%</div>' +
          "</div>";
        document.body.appendChild(ov);

        var TARGET = "ACCESS GRANTED";
        var gfile = document.getElementById("gfile");
        var tickN = 0;
        var TOTAL = 26;
        var dec = setInterval(function () {
          tickN++;
          var fixedN = Math.floor((tickN / TOTAL) * TARGET.length);
          var s = "";
          for (var i = 0; i < TARGET.length; i++) {
            s += i < fixedN ? TARGET[i] : CHARS[Math.floor(Math.random() * CHARS.length)];
          }
          gfile.textContent = s;
          if (tickN >= TOTAL) { clearInterval(dec); gfile.textContent = TARGET; }
        }, 42);

        var t0 = performance.now();
        var DUR = 1150;
        (function tick(now) {
          var p = Math.min(1, (now - t0) / DUR);
          var eased = 1 - Math.pow(1 - p, 2.2);
          document.getElementById("gbar").style.width = (eased * 100) + "%";
          document.getElementById("gpct").textContent =
            String(Math.round(eased * 100)).padStart(3, "0") + "%";
          if (p < 1) { requestAnimationFrame(tick); }
          else {
            ov.classList.add("done");
            setTimeout(cb, 260);
          }
        })(t0);
      }

      function escapeHtml(x) {
        return String(x).replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }

      // 鎖定倒數：以 server 絕對 lockUntil 每秒更新；歸零自動解除（reload 回正常頁）
      (function lockCountdown() {
        var b = document.body;
        if (!b.classList.contains("locked")) return;
        var until = parseInt(b.getAttribute("data-lock-until") || "0", 10);
        var el = document.getElementById("lockcd");
        if (!until || !el) return;
        function tick() {
          var rem = Math.max(0, Math.ceil((until - Date.now()) / 1000));
          if (el.textContent !== String(rem)) el.textContent = rem;
          if (rem <= 0) { setTimeout(function () { location.reload(); }, 400); return; }
          setTimeout(tick, 250);
        }
        tick();
      })();

      // 紅光掃過後：輸入框自動灌入 4 字亂碼 → 之後每秒整組重寫（glitch 動畫）
      (function corruptPin() {
        var b = document.body;
        if (!b.classList.contains("locked")) return;
        var pin = document.getElementById("pin");
        if (!pin) return;
        var CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*?!+<=>[]{}";
        var rand = function () {
          return CH.charAt(Math.floor(Math.random() * CH.length));
        };
        // sweep 完成（delay .15s + dur .7s）後開始灌入
        setTimeout(function () {
          var i = 0;
          var iv = setInterval(function () {
            pin.value += rand();
            i += 1;
            if (i >= 4) {
              clearInterval(iv);
              pin.blur();
              // 每秒整組純換（無震動動畫）
              setInterval(function () {
                pin.value = rand() + rand() + rand() + rand();
              }, 1000);
            }
          }, 140);
        }, 1050);
      })();
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
