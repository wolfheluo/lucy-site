// =====================================================================
//  ToolFrame：工具頁共用外框（星塵/CRT/HUD 四角/ticker）
//  - ToolShell（一般工具頁）與 dy-monitor 的歷史頁共用同一套 chrome
//  - children 由呼叫端提供；lock=true 時套用整頁鎖高（.tool-shell--lock）
// =====================================================================
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { profile } from "../content";
import HackerCodeRain from "./HackerCodeRain";

function hexTicker(): string {
  const bytes = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0")
  );
  return bytes.join(" ").toUpperCase();
}

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

export default function ToolFrame({
  title,
  zh,
  lock = false,
  loading = "LOADING MODULE…",
  children,
}: {
  title: string;
  zh: string;
  lock?: boolean;
  loading?: string;
  children: ReactNode;
}) {
  return (
    <div className={`tool-shell${lock ? " tool-shell--lock" : ""}`}>
      <div className="fx-layer tool-fx" aria-hidden="true">
        <div className="scanlines" />
        <div className="scanbar" />
        <div className="vignette" />
        <div className="noise" />
      </div>

      <HackerCodeRain />

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
          {title}
          <span className="zh">{zh}</span>
        </div>
      </header>

      <main className="tool-body">
        <Suspense fallback={<div className="tool-loading">{loading}</div>}>{children}</Suspense>
      </main>

      <ToolTicker toolTitle={title} />
    </div>
  );
}
