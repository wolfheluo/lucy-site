// =====================================================================
//  ToolShell：工具頁精簡 chrome（NETRUNNER 沉浸層）
//  - 保留 NETRUNNER 語彙：星塵背景、動態 CRT（scanbar/noise）、
//    四角 HUD frame、底部 ticker、logo 字樣
//  - 去掉主站 HUD（導覽/捲動進度/開關）——工具頁專注工具本身
//  - ticker 自更新（子元件），ToolShell 本體零 interval → 不干擾工具
// =====================================================================
import { Suspense, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { CLIENT_TOOLS } from "../tools";
import { profile } from "../content";
import HackerCodeRain from "./HackerCodeRain";

function hexTicker(): string {
  const bytes = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
  );
  return bytes.join(" ").toUpperCase();
}

/** 底部 ticker（自管時鐘與 hex，1s/2.6s 更新） */
function ToolTicker({ toolTitle }: { toolTitle: string }) {
  const [hex, setHex] = useState(hexTicker);
  const [timeStr, setTimeStr] = useState(() =>
    new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19)
  );
  useEffect(() => {
    const t = setInterval(
      () => setTimeStr(new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19)),
      1000
    );
    const h = setInterval(() => setHex(hexTicker()), 2600);
    return () => {
      clearInterval(t);
      clearInterval(h);
    };
  }, []);
  return (
    <footer className="tool-ticker" aria-hidden="true">
      <span>
        NETRUNNER OS <span className="tk-red">//</span> {toolTitle}
      </span>
      <span className="tk-dim">{hex}</span>
      <span>
        {timeStr} <span className="tk-red">UTC+8</span>
      </span>
    </footer>
  );
}

export default function ToolShell() {
  const { toolId } = useParams();
  const tool = CLIENT_TOOLS.find((t) => t.meta.id === toolId);

  useEffect(() => {
    window.scrollTo(0, 0);
    // L5：工具頁顯示自己的分頁標題
    if (tool) document.title = `${tool.meta.title} // ${tool.meta.zhTitle}`;
  }, [toolId, tool]);

  if (!tool) return <Navigate to="/" replace />;
  const Comp = tool.Component;

  return (
    // tool-shell--lock：binance-api 全貌鎖高（寬版整頁零滾動；CSS 見 index.css .tool-shell--lock）
    <div className={`tool-shell${tool.meta.id === "binance-api" ? " tool-shell--lock" : ""}`}>
      <div className="fx-layer tool-fx" aria-hidden="true">
        <div className="scanlines" />
        <div className="scanbar" />
        <div className="vignette" />
        <div className="noise" />
      </div>

      {/* 偽駭客代碼流背景 */}
      <HackerCodeRain />

      {/* 四角 HUD frame */}
      <span className="tool-hud-corner tl" aria-hidden="true" />
      <span className="tool-hud-corner tr" aria-hidden="true" />
      <span className="tool-hud-corner bl" aria-hidden="true" />
      <span className="tool-hud-corner br" aria-hidden="true" />

      <header className="tool-top">
        <Link to="/" className="tool-back" data-hover>
          <span className="tool-back-arrow">◂</span>
          <span className="tool-back-text">{profile.handle || "RETURN"}</span>
        </Link>
        <div className="tool-title">
          {tool.meta.title}
          <span className="zh">{tool.meta.zhTitle}</span>
        </div>
      </header>

      <main className="tool-body">
        <Suspense fallback={<div className="tool-loading">LOADING MODULE…</div>}>
          <Comp />
        </Suspense>
      </main>

      <ToolTicker toolTitle={tool.meta.title} />
    </div>
  );
}
