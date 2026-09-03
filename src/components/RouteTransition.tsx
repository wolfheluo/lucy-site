// =====================================================================
//  RouteTransition：工具卡 → 工具頁的「深潛過場」
//  - 點卡 → 全屏 NETRUNNER 讀取畫面（漸層 bar + 3 位 % + 模組名）
//  - 進度滿 → navigate → overlay 碎裂退場露出工具頁
//
//  ⚠️ 退場鐵律（2026-09 黑屏修復）：碎裂動畫走 CSS animation +
//     animationend 事件 + timeout 兜底，overlay 移除 = React state
//     同步 unmount。**不再依賴 framer-motion AnimatePresence exit**
//     （React 19 concurrent 時序下 exit 動畫曾卡住 → 黑幕 z-500 永久
//     殘留 = 使用者回報的「進 FILE VAULT 黑屏、refresh 才恢復」）。
//     結構保證：碎裂 animation 必播完 → animationend 必 fire →
//     900ms timeout 二次保險 → onGone() setPending(null) → unmount。
// =====================================================================
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
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
            // 進度滿當下先導航（新頁在 overlay 下 mount，碎裂後直接露出）
            onLaunched={() => navigate(pending.path)}
            // 碎裂 animationend / timeout 後才真正移除 overlay
            onGone={() => setPending(null)}
          />
        )}
      </AnimatePresence>
    </NavCtx.Provider>
  );
}

/* ---------------- 過場讀取畫面 ---------------- */
function BootOverlay({
  title,
  onLaunched,
  onGone,
}: {
  title: string;
  onLaunched: () => void;
  onGone: () => void;
}) {
  const rm = useReducedMotion();
  const [pct, setPct] = useState(0);
  const [exiting, setExiting] = useState(false);
  const goneRef = useRef(false);
  const launchedRef = useRef(false);

  const gone = useCallback(() => {
    if (goneRef.current) return;
    goneRef.current = true;
    onGone();
  }, [onGone]);

  // 碎裂 animation 播完（animationend）→ 移除；只認 routeBootRip
  // （防未來子元素 animation bubble 造成提早移除）
  const handleAnimEnd = useCallback(
    (e: ReactAnimationEvent) => {
      if (e.animationName === "routeBootRip") gone();
    },
    [gone]
  );

  // timeout 二次保險：animationend 任何原因沒 fire → 900ms 後強制移除
  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(gone, 900);
    return () => clearTimeout(t);
  }, [exiting, gone]);

  useEffect(() => {
    if (rm === true) {
      // reduced-motion：不播碎裂，直接導航 + 移除（無黑幕）
      onLaunched();
      gone();
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
        raf = requestAnimationFrame(() => {
          // 進度滿：先導航（navigate 同步換 route），再觸發碎裂退場
          if (!launchedRef.current) {
            launchedRef.current = true;
            onLaunched();
          }
          setExiting(true);
        });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // onLaunched/onGone 為 TransitionProvider 每次 render 的新 closure；
    // 本 effect 只需跑一次（動畫自驅），刻意不列為依賴
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rm]);

  return (
    <motion.div
      className={`route-boot${exiting ? " exiting" : ""}`}
      initial={rm === true ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      onAnimationEnd={handleAnimEnd}
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
