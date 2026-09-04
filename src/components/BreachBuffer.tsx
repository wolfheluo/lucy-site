// =====================================================================
//  BreachBuffer：Breach Protocol 風格「逐格鎖定」數字元件
//  - 每位字元一格（含小數點）：格內字元高速輪播，由左至右逐格鎖死成最終值
//  - start：外部控制破解開始（如 boot 碎裂 overlay 退場後）
//  - hover：滑鼠移上重播破解（主動 breach 感；播放中/rm 忽略）
//  - instant：直接顯示最終文字（reduced-motion）
//  - 與 GlitchText（全行亂碼解碼）視覺語彙不同——協定 buffer 逐 token 鎖定
// =====================================================================
import { useEffect, useRef, useState } from "react";

const CHARS = "01<>/\\#$%&@!?アΞΔΣ#$%&@!?";
/** 每格鎖定間隔：由左到右逐格停 */
const LOCK_STEP_MS = 150;
/** 輪播幀間隔 */
const TICK_MS = 45;

interface BreachBufferProps {
  text: string;
  /** 破解開始（false = 空格占位等待） */
  start?: boolean;
  /** 直接顯示最終文字（reduced-motion / 靜態） */
  instant?: boolean;
  /** hover 重播破解 */
  hover?: boolean;
}

function randomChar(): string {
  return CHARS[(Math.random() * CHARS.length) | 0];
}

export default function BreachBuffer({ text, start = true, instant = false, hover = false }: BreachBufferProps) {
  const chars = text.split("");
  const [disp, setDisp] = useState<string[] | null>(instant ? chars : null);
  const [playNonce, setPlayNonce] = useState(0);
  const playingRef = useRef(false);
  const hoverRef = useRef(false);

  // instant：直接顯示（含 text 變更）
  useEffect(() => {
    if (instant) {
      setDisp(text.split(""));
      return;
    }
  }, [instant, text]);

  // 破解主流程：start 且（首次 or hover 重播 or text 變）
  useEffect(() => {
    if (instant) return;
    if (!start) {
      // 等待破解：空格占位（格框可見）
      setDisp(chars.map((ch) => (ch === "." ? "." : "")));
      playingRef.current = false;
      return;
    }
    if (playingRef.current) return; // 播放中不重啟（hover 節流）
    playingRef.current = true;

    const t0 = performance.now();
    setDisp(chars.map((ch) => (ch === "." ? "." : randomChar()))); // 首幀全亂碼

    const timer = window.setInterval(() => {
      const elapsed = performance.now() - t0;
      setDisp(
        chars.map((ch, i) => {
          if (ch === ".") return ".";
          return elapsed >= i * LOCK_STEP_MS ? ch : randomChar();
        })
      );
      if (elapsed >= (chars.length - 1) * LOCK_STEP_MS + LOCK_STEP_MS) {
        window.clearInterval(timer);
        playingRef.current = false;
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
    // playNonce = hover 重播觸發
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, text, playNonce, instant]);

  const onEnter = () => {
    if (!hover || instant) return;
    if (!hoverRef.current) {
      hoverRef.current = true;
      window.setTimeout(() => {
        hoverRef.current = false;
      }, 900);
      setPlayNonce((n) => n + 1);
    }
  };

  // 視覺格；disp null（尚未決定）時空格
  const cells = (disp ?? chars.map(() => "")).map((ch, i) => {
    const isDot = chars[i] === ".";
    const locked = !isDot && ch !== "" && ch === chars[i];
    return (
      <span key={i} className={`bp-cell${locked ? " locked" : ""}${isDot ? " dot" : ""}`} aria-hidden="true">
        {ch}
      </span>
    );
  });

  return (
    <span className="bp" role="text" aria-label={text} onMouseEnter={onEnter}>
      {cells}
    </span>
  );
}
