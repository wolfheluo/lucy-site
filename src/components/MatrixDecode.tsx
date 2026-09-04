// =====================================================================
//  MatrixDecode：矩陣掃描解密元件（Breach 矩陣語彙）
//  - 數字「藏在」3 行字元矩陣中；掃描線由上往下掃，掃到中間目標行時
//    該行由左至右逐位從亂碼固化出最終數字；掃完浮層淡出 → 數字原位顯現
//  - start：外部控制開始（boot 碎裂 overlay 退場後）；text 變更自動重掃
//  - hover：完成後滑鼠移上重播掃描（主動 breach）；播放中/rm 忽略
//  - instant：直接顯示數字（reduced-motion / 靜態）
// =====================================================================
import { useEffect, useRef, useState } from "react";

const CHARS = "01<>/\\#$%&@!?アΞΔΣ#$%&@!?";
const TICK_MS = 45;
/** 目標行逐位固化間隔（由左到右） */
const LOCK_STEP_MS = 130;
/** 全鎖定後停留再淡出 */
const HOLD_MS = 260;
const FADE_MS = 380;

interface MatrixDecodeProps {
  text: string;
  start?: boolean;
  instant?: boolean;
  hover?: boolean;
}

function randomChar(): string {
  return CHARS[(Math.random() * CHARS.length) | 0];
}

function garbleRow(len: number, keepDotAt?: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += i === keepDotAt ? "." : randomChar();
  return s;
}

type Phase = "idle" | "playing" | "fading" | "done";

export default function MatrixDecode({
  text,
  start = true,
  instant = false,
  hover = false,
}: MatrixDecodeProps) {
  const len = text.length;
  // 上下陪襯亂碼行（播放開始時生成一次）
  const [rows, setRows] = useState<[string, string] | null>(null);
  const [target, setTarget] = useState("");
  const [phase, setPhase] = useState<Phase>(instant ? "done" : "idle");
  const playingRef = useRef(false);
  const hoverThrottleRef = useRef(false);
  const timerRef = useRef(0);

  // instant：直接顯示數字（text 變也同步）
  useEffect(() => {
    if (instant) setPhase("done");
  }, [instant, text]);

  const play = () => {
    if (playingRef.current) return;
    if (instant) return;
    playingRef.current = true;
    const dotAt = text.indexOf(".");
    setRows([garbleRow(len, dotAt), garbleRow(len, dotAt)]);
    setPhase("playing");

    const t0 = performance.now();
    timerRef.current = window.setInterval(() => {
      const elapsed = performance.now() - t0;
      // 目標行：由左到右固化
      let disp = "";
      for (let i = 0; i < len; i++) {
        const ch = text[i];
        disp += ch === "." ? "." : elapsed >= i * LOCK_STEP_MS ? ch : randomChar();
      }
      setTarget(disp);
      // 全位鎖定 → 停留 → 淡出 → 完成
      if (elapsed >= (len - 1) * LOCK_STEP_MS + LOCK_STEP_MS + HOLD_MS) {
        setPhase("fading");
        window.setTimeout(() => {
          playingRef.current = false;
          setPhase("done");
        }, FADE_MS);
        window.clearInterval(timerRef.current);
      }
    }, TICK_MS);
  };

  // start / text 變 → 播放
  useEffect(() => {
    if (instant) return;
    if (!start) {
      setPhase("idle");
      return;
    }
    play();
    return () => window.clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, text, instant]);

  useEffect(() => () => window.clearInterval(timerRef.current), []);

  const onEnter = () => {
    if (!hover || instant || phase !== "done") return;
    if (hoverThrottleRef.current) return;
    hoverThrottleRef.current = true;
    window.setTimeout(() => {
      hoverThrottleRef.current = false;
    }, 1000);
    play();
  };

  // 等待/播放/淡出期間的佔位（寬度穩定）：暗色底線
  const placeholder = Array.from({ length: len }, (_, i) =>
    text[i] === "." ? <span className="md-ph md-ph-dot" key={i}>.</span> : <span className="md-ph" key={i}>_</span>
  );

  return (
    <span className="md" role="text" aria-label={text} onMouseEnter={onEnter}>
      {phase === "done" ? (
        <span className="md-value">{text}</span>
      ) : (
        <span className="md-idle" aria-hidden="true">
          {placeholder}
          {(phase === "playing" || phase === "fading") && rows && (
            <span className={`md-matrix${phase === "fading" ? " fading" : ""}`}>
              <span className="md-row md-row-ghost">{rows[0]}</span>
              <span className="md-row md-row-target">{target}</span>
              <span className="md-row md-row-ghost">{rows[1]}</span>
              <span className="md-scan" aria-hidden="true" />
            </span>
          )}
        </span>
      )}
    </span>
  );
}
