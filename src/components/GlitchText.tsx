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
  const beganRef = useRef(false);

  useEffect(() => {
    if (instant) {
      setOut(text);
      setDone(true);
      return;
    }
    if (!trigger || beganRef.current) return;
    beganRef.current = true;

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
    setJitterKey((k) => k + 1);
    window.setTimeout(() => setJitterKey(0), 320);
  };

  return (
    <span ref={ref} className={cls} aria-label={text} role="text" onMouseEnter={onEnter}>
      <span className="ghost" aria-hidden="true">
        {text}
      </span>
      {!done && (
        <span className="dec" aria-hidden="true">
          {out}
        </span>
      )}
    </span>
  );
}
