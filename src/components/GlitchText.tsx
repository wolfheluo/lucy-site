// =====================================================================
//  GlitchText：亂碼解碼動畫元件
//  - 預設在進入 viewport 時解碼一次（once）
//  - start 明確控制（如 Hero 等 boot 完成後才開始）
//  - instant：直接顯示最終文字（reduced-motion）
//  - hover：滑鼠懸停時觸發短暫 glitch 抖動
// =====================================================================
import { useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { sfx } from "../audio/engine";

const CHARS = "01<>/\\#$%&@!?ア01<>ΞΔΣ#$%&@!?";

const PUNCT_RE = /[.,!?;:'"()\[\]{}<>/\\|·—…，。！？、：；「」『』（）]/u;
const LETTER_RE = /[\p{L}\p{N}]/u;

interface GlitchTextProps {
  text: string;
  className?: string;
  /** 由外部控制開始（hero 等 boot 完成後再解碼） */
  start?: boolean;
  delayMs?: number;
  /** 直接顯示最終文字（reduced-motion / 靜態） */
  instant?: boolean;
  /** hover 時觸發短暫 glitch 抖動 */
  hover?: boolean;
}

export default function GlitchText({
  text,
  className = "",
  start,
  delayMs = 0,
  instant = false,
  hover = false,
}: GlitchTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const trigger = start !== undefined ? start : inView;

  const [out, setOut] = useState(instant ? text : "");
  const [decoding, setDecoding] = useState(false);
  const [done, setDone] = useState(instant);
  const [jitterKey, setJitterKey] = useState(0);
  const jitterTimer = useRef(0);
  const beganRef = useRef(false);
  const prevTextRef = useRef<string | null>(null);

  // m-17：hover jitter timer 清理（unmount 後不留殘留 setTimeout）
  useEffect(() => () => window.clearTimeout(jitterTimer.current), []);

  useEffect(() => {
    if (instant) {
      setOut(text);
      setDone(true);
      prevTextRef.current = text;
      return;
    }
    const prev = prevTextRef.current;
    prevTextRef.current = text;
    const textChanged = prev !== null && prev !== text;
    // 已解碼過且文字沒變 → 不重播；未觸發（inView/start）且非文字變更 → 等觸發
    if (beganRef.current && !textChanged) return;
    if (!trigger && !textChanged) return;
    beganRef.current = true;
    // 文字變更重播：done 重設 → dec 層回到亂碼解碼過程
    if (textChanged) {
      setDone(false);
      setOut("");
    }

    let raf = 0;
    const t0 = performance.now() + delayMs;
    const DUR = 950;
    setDecoding(true);

    const tick = (now: number) => {
      const t = now - t0;
      if (t < 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const p = Math.min(1, t / DUR);
      const n = text.length;
      const fixedN = Math.floor(p * n);
      let s = "";
      for (let i = 0; i < n; i++) {
        const ch = text[i];
        if (ch === " " || ch === "\n") {
          s += ch;
          continue;
        }
        const finalized = i < fixedN || (PUNCT_RE.test(ch) && !LETTER_RE.test(ch) && p > 0.3);
        s += finalized ? ch : CHARS[(Math.random() * CHARS.length) | 0];
      }
      setOut(s);
      if (p >= 1) {
        setOut(text);
        setDecoding(false);
        setDone(true);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    sfx.decode();
    return () => cancelAnimationFrame(raf);
  }, [trigger, text, delayMs, instant]);

  const cls = [
    "glitch-box",
    className,
    decoding ? "glitching" : "",
    jitterKey > 0 ? "hover-glitch" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const onEnter = () => {
    if (!hover || done === false) return;
    window.clearTimeout(jitterTimer.current); // 重啟前清舊 timer → 連續 hover 不提前截斷
    setJitterKey((k) => k + 1);
    jitterTimer.current = window.setTimeout(() => setJitterKey(0), 320);
  };

  return (
    <span ref={ref} className={cls} aria-label={text} role="text" onMouseEnter={onEnter}>
      <span className="ghost" aria-hidden="true">
        {text}
      </span>
      {/* dec 恆在：done 後顯示最終文字（修 bug：原寫法 done 即 unmount → 解碼完文字消失） */}
      <span className="dec" aria-hidden="true">
        {done ? text : out}
      </span>
    </span>
  );
}
