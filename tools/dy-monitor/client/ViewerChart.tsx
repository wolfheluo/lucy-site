// =====================================================================
//  在線人數曲線（即時監控與歷史回放共用）
//  - SVG 手刻，零依賴；資料 < 3 點時不畫填色（避免空圖一大片）
// =====================================================================
import { useMemo } from "react";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function hhmmss(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function compact(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}萬`;
  return String(v);
}
function num(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

export interface ViewerPoint {
  ts: number;
  viewers: number;
  likes?: number;
}

export default function ViewerChart({
  series,
  replay,
  label = "在線人數",
  hint,
}: {
  series: ViewerPoint[];
  replay?: boolean;
  label?: string;
  hint?: string;
}) {
  const data = useMemo(() => series.slice(-240), [series]);
  const max = Math.max(1, ...data.map((d) => d.viewers));
  const w = 600;
  const h = 150;
  const points = data
    .map((d, i) => {
      const x = data.length <= 1 ? 0 : (i / (data.length - 1)) * w;
      const y = h - (d.viewers / max) * (h - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = points ? `${points} ${w},${h} 0,${h}` : "";
  const last = data[data.length - 1];
  const first = data[0];
  const delta = last && first ? last.viewers - first.viewers : 0;

  return (
    <div className="dym-chart">
      <div className="dym-chart-head">
        <span>{label}</span>
        <span className="dym-dim">{hint ?? (replay ? "上場全程" : "近 5 分鐘")}</span>
        <span className={delta >= 0 ? "dym-up" : "dym-down"}>
          {delta >= 0 ? "▲" : "▼"} {num(Math.abs(delta))}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="dym-svg">
        <defs>
          <linearGradient id="dymFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(168,230,255,0.22)" />
            <stop offset="100%" stopColor="rgba(168,230,255,0)" />
          </linearGradient>
        </defs>
        {data.length > 2 && <polygon points={area} fill="url(#dymFill)" />}
        {points && <polyline points={points} fill="none" stroke="var(--ice)" strokeWidth="1.6" />}
      </svg>
      <div className="dym-chart-foot">
        <span>{data.length ? hhmmss(data[0]!.ts) : "--:--:--"}</span>
        <span>峰值 {compact(max)}</span>
        <span>{last ? hhmmss(last.ts) : "--:--:--"}</span>
      </div>
    </div>
  );
}
