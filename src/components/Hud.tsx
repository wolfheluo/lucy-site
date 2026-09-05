// =====================================================================
//  HUD：左上 logo、右上錨點導覽、頂端捲動進度條、
//  右下 FX / MUSIC 開關。
// =====================================================================
import { motion } from "framer-motion";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { profile } from "../content";
import { sfx } from "../audio/engine";
import MatrixDecode from "./MatrixDecode";

const LINKS: [string, string][] = [
  ["about", "ABOUT"],
  ["skills", "SKILLS"],
  ["projects", "PROJECTS"],
  ["contact", "CONTACT"],
];

function ProgressBar() {
  const barRef = useRef<HTMLElement>(null);

  // M-6：改「scroll/resize/font-load 事件驅動 + rAF 節流」，靜止時 0 工作；
  // 捲動範圍只在不動時量測快取，不再每幀讀 scrollHeight（強制同步 layout）。
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;

    let max = 0;
    const measure = () => {
      max = document.documentElement.scrollHeight - window.innerHeight;
    };

    let raf = 0;
    let queued = false;
    let lastP = -1;

    const apply = () => {
      queued = false;
      const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      if (p !== lastP) {
        lastP = p; // 數值未變不寫 DOM
        el.style.transform = `scaleX(${p})`;
      }
    };
    const request = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(apply);
    };

    const onScroll = () => request();
    const onRecalc = () => {
      measure();
      request();
    };

    measure();
    request();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onRecalc, { passive: true });
    window.addEventListener("load", onRecalc, { passive: true });
    const t = window.setTimeout(onRecalc, 800); // 字型/內容載入後校正
    let alive = true;
    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (alive) onRecalc();
        })
        .catch(() => {});
    }

    return () => {
      alive = false;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onRecalc);
      window.removeEventListener("load", onRecalc);
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="hud-progress">
      <i ref={barRef} />
    </div>
  );
}

interface HudProps {
  visible: boolean;
  /** boot 碎裂 overlay 已退場（餘額 decode 登場時機） */
  bootGone: boolean;
  fxOn: boolean;
  onToggleFx: () => void;
  ambOn: boolean;
  onToggleAmb: () => void;
  reduced: boolean;
}

export default function Hud({
  visible,
  bootGone,
  fxOn,
  onToggleFx,
  ambOn,
  onToggleAmb,
  reduced,
}: HudProps) {
  // DeepSeek CNY 餘額（CONTACT 右側；查不到/無 key → null 不顯示）
  // 60s 輪詢（server 端同 60s cache）；值變 → GlitchText 亂碼解碼重播
  const [dsBalance, setDsBalance] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/deepseek/balance")
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => {
          if (!alive || !b || b.ok !== true || typeof b.cny !== "number") return;
          setDsBalance((prev) => {
            const next = b.cny.toFixed(2);
            return prev === next ? prev : next; // 值沒變不觸發 re-decode
          });
        })
        .catch(() => {
          /* 查不到就不顯示 */
        });
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const go = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    sfx.click();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  return (
    <motion.header
      className="hud"
      initial={{ opacity: 0 }}
      animate={visible ? { opacity: 1 } : {}}
      transition={{ duration: 0.7 }}
    >
      <ProgressBar />
      <div className="hud-top">
        <div className="logo" data-hover>
          ▲ {profile.handle.toUpperCase()}
          <span className="dot">_</span>
        </div>
        <nav aria-label="主要導覽">
          {LINKS.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={go(id)} onMouseEnter={() => sfx.hover()}>
              {label}
            </a>
          ))}
          {dsBalance !== null && (
            <span className="hud-balance">
              {/* 矩陣掃描解密（數字藏矩陣、掃描線逐行揭開；boot 碎裂退場後播放） */}
              <MatrixDecode text={dsBalance} instant={reduced} hover start={bootGone} />
            </span>
          )}
        </nav>
      </div>

      <div className="toggles" style={{ pointerEvents: visible ? "auto" : "none" }}>
        <button
          type="button"
          className={`tbtn amb${ambOn ? " on" : ""}`}
          data-hover
          onClick={() => {
            sfx.click();
            onToggleAmb();
          }}
          aria-pressed={ambOn}
        >
          {ambOn ? (
            <span className="eq" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <span className="led" />
          )}
          MUSIC
        </button>
        <button
          type="button"
          className={`tbtn${fxOn ? " on" : ""}`}
          data-hover
          onClick={() => {
            sfx.click();
            onToggleFx();
          }}
          aria-pressed={fxOn}
        >
          <span className="led" />
          CRT
        </button>
      </div>
    </motion.header>
  );
}
