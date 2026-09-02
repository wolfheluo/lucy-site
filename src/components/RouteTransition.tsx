// =====================================================================
//  RouteTransition：工具卡 → 工具頁的「深潛過場」
//  - 點卡 → 全屏 NETRUNNER 讀取畫面（漸層 bar + 3 位 % + 模組名）
//  - 進度滿 → navigate → overlay 碎裂退場露出工具頁
// =====================================================================
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router";

const NavCtx = createContext<(path: string, title: string) => void>(() => {});

/** 觸發帶過場的導航（卡片點擊用） */
export const useNavTransition = () => useContext(NavCtx);

export function TransitionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<{ path: string; title: string } | null>(null);

  const start = useCallback((path: string, title: string) => {
    setPending({ path, title });
  }, []);

  return (
    <NavCtx.Provider value={start}>
      {children}
      <AnimatePresence>
        {pending && (
          <BootOverlay
            key={pending.path}
            title={pending.title}
            onDone={() => {
              navigate(pending.path);
              setPending(null);
            }}
          />
        )}
      </AnimatePresence>
    </NavCtx.Provider>
  );
}

/* ---------------- 過場讀取畫面 ---------------- */
function BootOverlay({ title, onDone }: { title: string; onDone: () => void }) {
  const rm = useReducedMotion();
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (rm === true) {
      onDone();
      return;
    }
    const t0 = performance.now();
    const DUR = 980;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      const eased = 1 - Math.pow(1 - p, 2.2);
      setPct(Math.round(eased * 100));
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = requestAnimationFrame(() => onDone());
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rm, onDone]);

  return (
    <motion.div
      className="route-boot"
      initial={rm === true ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={
        rm === true
          ? { opacity: 0 }
          : {
              clipPath: [
                "inset(0 0 0 0)",
                "inset(0 0 46% 0)",
                "inset(0 0 0 0)",
                "inset(52% 0 0 0)",
                "inset(0 0 100% 0)",
              ],
              opacity: [1, 1, 0.7, 1, 0],
              transition: { duration: 0.42, times: [0, 0.25, 0.45, 0.7, 1] },
            }
      }
      aria-hidden="true"
    >
      <div className="route-boot-inner">
        <div className="route-boot-os">NETRUNNER OS // DEEP-DIVE MODULE</div>
        <div className="route-boot-title">{title}</div>
        <div className="route-boot-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="route-boot-pct">{String(pct).padStart(3, "0")}%</div>
        <div className="route-boot-line">&gt; 潛入模組…</div>
      </div>
    </motion.div>
  );
}
