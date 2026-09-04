// =====================================================================
//  BootScreen：「深潛啟動」載入畫面 —— 品牌系統字樣、進度條、
//  逐行終端輸出，完成後 glitch 碎裂退場。可點擊/按鍵跳過。
// =====================================================================
import { motion } from "framer-motion";
import { useEffect, useRef, useState, type AnimationEvent as ReactAnimationEvent } from "react";
import { profile } from "../content";
import { sfx } from "../audio/engine";

const LINES: { t: string; ok: boolean }[] = [
  { t: "> INITIALIZING NETRUNNER OS", ok: false },
  { t: "> LOADING MOON COORDINATES [L5]", ok: false },
  { t: "> SYNCING ICE WALL...", ok: false },
  { t: "> ACCESS GRANTED", ok: true },
];

export default function BootScreen({
  onDone,
  onGone,
}: {
  onDone: () => void;
  /** 碎裂退場播完才呼叫（移除自身；framer exit 不參與，CSS animation 保證播完） */
  onGone: () => void;
}) {
  const [pct, setPct] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);
  const goneRef = useRef(false);

  /** 內容顯示（onDone → booted）：進度滿 / 點擊 / 按鍵跳過都走這 → 觸發碎裂退場 */
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
    setExiting(true);
  };

  /** 碎裂 animation 播完（animationend / timeout 兜底）→ 移除自身 */
  const gone = () => {
    if (goneRef.current) return;
    goneRef.current = true;
    onGone();
  };

  // 碎裂 timeout 兜底：animationend 沒 fire（reduced-motion 全域關 animation）→ 900ms 強制
  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(gone, 900);
    return () => clearTimeout(t);
  }, [exiting]);

  // 碎裂動畫完成（只認 bootRip；防子元素 animation bubble）
  const handleAnimEnd = (e: ReactAnimationEvent) => {
    if (e.animationName === "bootRip") gone();
  };

  useEffect(() => {
    sfx.boot();

    // progress bar: ~2s ease-out, then brief hold before exit
    let raf = 0;
    let holdTimer = 0;
    const t0 = performance.now();
    const DUR = 2000;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      const eased = 1 - Math.pow(1 - p, 2.2);
      setPct(Math.round(eased * 100));
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        holdTimer = window.setTimeout(finish, 480);
      }
    };
    raf = requestAnimationFrame(tick);

    // terminal lines reveal
    let lineTimer = 0;
    const first = window.setTimeout(() => {
      sfx.line();
      setLineCount(1);
      lineTimer = window.setInterval(() => {
        setLineCount((c) => {
          if (c >= LINES.length) {
            window.clearInterval(lineTimer);
            return c;
          }
          sfx.line();
          return c + 1;
        });
      }, 430);
    }, 320);

    const onKey = () => finish();
    window.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(holdTimer);
      window.clearTimeout(first);
      window.clearInterval(lineTimer);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      className={`boot${exiting ? " exiting" : ""}`}
      onClick={finish}
      onAnimationEnd={handleAnimEnd}
      initial={false}
    >
      <div className="boot-os">
        {pct >= 12 ? profile.bootOs : "▚▚▚▚▚▚▚▚▚▚"}
        <small>{profile.bootVer}</small>
      </div>

      <div style={{ textAlign: "center" }}>
        <div className="boot-pct">{String(pct).padStart(3, "0")}%</div>
        <div className="boot-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="boot-lines">
        {LINES.slice(0, lineCount).map((l) => (
          <div key={l.t} className={l.ok ? "ok" : ""}>
            {l.ok ? `${l.t} ✓` : l.t}
          </div>
        ))}
        {lineCount >= LINES.length && <div className="ok">&gt; 登入完成。歡迎回來，竄網使。</div>}
      </div>

      <div className="skip-hint">[ CLICK TO SKIP ]</div>
    </motion.div>
  );
}
