// =====================================================================
//  CustomCursor：科技十字準星 + 動態掃描光圈
//  預設細十字；hover 到可互動元素（a / button / [data-hover]）時，
//  光圈放大並亮起紅點。僅在 (pointer: fine) 且未開啟 reduced-motion
//  時由 App 掛載。
// =====================================================================
import { useEffect, useRef } from "react";

const INTERACTIVE = "a, button, [data-hover], [role='button'], input, textarea, select, summary";

export default function CustomCursor() {
  const layerRef = useRef<HTMLDivElement>(null);
  const crossRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const cross = crossRef.current;
    const ring = ringRef.current;
    if (!layer || !cross || !ring) return;

    document.documentElement.classList.add("cursor-none");

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let rx = x;
    let ry = y;
    let hot = false;
    let raf = 0;
    let running = false;
    let lastMove = performance.now();
    const IDLE_MS = 300;
    let prevX = x;
    let prevY = y;

    const startLoop = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      lastMove = performance.now();
      if (!running) startLoop(); // 靜止停 loop 後，pointermove 重新啟動
    };

    const onOver = (e: Event) => {
      const t = e.target as HTMLElement | null;
      const h = !!(t && t.closest && t.closest(INTERACTIVE));
      if (h !== hot) {
        hot = h;
        layer.classList.toggle("cursor-hot", h);
      }
    };

    const loop = () => {
      const dx = x - prevX;
      const dy = y - prevY;
      prevX = x;
      prevY = y;
      // 速度感知 lerp：慢速 ~0.26（保留平滑拖尾質感），
      // 快速移動時逼近 1（光圈即時咬住鼠標，不再落後）
      const spd = Math.sqrt(dx * dx + dy * dy);
      const k = Math.min(0.92, 0.26 + spd * 0.03);
      rx += (x - rx) * k;
      ry += (y - ry) * k;
      cross.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
      // m-16：指標靜止 ≥300ms 且光圈已收斂（<0.6px）→ 停 loop，不再每幀空轉
      const settled = Math.abs(x - rx) < 0.6 && Math.abs(y - ry) < 0.6;
      if (performance.now() - lastMove >= IDLE_MS && settled) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerover", onOver, true);
    startLoop();

    return () => {
      document.documentElement.classList.remove("cursor-none");
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerover", onOver, true);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="cursor-layer" ref={layerRef}>
      <div className="cursor-cross" ref={crossRef} />
      <div className="cursor-ring" ref={ringRef}>
        <span className="pulse" />
      </div>
    </div>
  );
}
