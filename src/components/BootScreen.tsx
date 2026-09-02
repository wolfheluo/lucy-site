// =====================================================================
//  BootScreen：「深潛啟動」載入畫面 —— 品牌系統字樣、進度條、
//  逐行終端輸出，完成後 glitch 碎裂退場。可點擊/按鍵跳過。
// =====================================================================
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { profile } from "../content";
import { sfx } from "../audio/engine";

const LINES: { t: string; ok: boolean }[] = [
  { t: "> INITIALIZING NETRUNNER OS", ok: false },
  { t: "> LOADING MOON COORDINATES [L5]", ok: false },
  { t: "> SYNCING ICE WALL...", ok: false },
  { t: "> ACCESS GRANTED", ok: true },
];

export default function BootScreen({ onDone }: { onDone: () => void }) {
  const [pct, setPct] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
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
      className="boot"
      onClick={finish}
      exit={{
        clipPath: [
          "inset(0 0 0 0)",
          "inset(8% 0 42% 0)",
          "inset(0 0 0 0)",
          "inset(46% 0 6% 0)",
          "inset(0 0 100% 0)",
        ],
        opacity: [1, 1, 0.5, 1, 0],
        transition: { duration: 0.55, times: [0, 0.25, 0.45, 0.65, 1] },
      }}
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
