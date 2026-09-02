// =====================================================================
//  HackerCodeRain：工具頁背景「偽駭客代碼流」
//  - 產生器核心在 public/code-rain.js（與公開分享頁共用，單一來源）
//  - 此元件負責動態載入 script 並呼叫 window.startCodeRain(el)
// =====================================================================
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    startCodeRain?: (el: HTMLElement) => () => void;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadCodeRainScript(): Promise<void> {
  if (typeof window !== "undefined" && window.startCodeRain) {
    return Promise.resolve();
  }
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/code-rain.js";
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("code-rain.js 載入失敗"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export default function HackerCodeRain() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    let stop: (() => void) | null = null;

    loadCodeRainScript()
      .then(() => {
        if (!alive || !window.startCodeRain) return;
        stop = window.startCodeRain(el);
      })
      .catch(() => {
        /* 載入失敗 → 背景留空即可 */
      });

    return () => {
      alive = false;
      stop?.();
      el.textContent = "";
    };
  }, []);

  return <div ref={ref} className="hack-rain" aria-hidden="true" />;
}
