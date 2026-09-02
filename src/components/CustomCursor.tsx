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

    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
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
      rx += (x - rx) * 0.22;
      ry += (y - ry) * 0.22;
      cross.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerover", onOver, true);
    raf = requestAnimationFrame(loop);

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
