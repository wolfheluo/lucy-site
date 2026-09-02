// =====================================================================
//  ToolShell：工具頁精簡 chrome
//  - 保留 NETRUNNER 語彙（深空背景、CRT 掃描線、logo 字樣）
//  - 去掉主站 HUD（導覽/捲動進度/開關）——工具頁專注工具本身
// =====================================================================
import { Suspense, useEffect } from "react";
import { Link, Navigate, useParams } from "react-router";
import { CLIENT_TOOLS } from "../tools";
import { profile } from "../content";

export default function ToolShell() {
  const { toolId } = useParams();
  const tool = CLIENT_TOOLS.find((t) => t.meta.id === toolId);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [toolId]);

  if (!tool) return <Navigate to="/" replace />;
  const Comp = tool.Component;

  return (
    <div className="tool-shell">
      <div className="fx-layer tool-fx" aria-hidden="true">
        <div className="scanlines" />
        <div className="vignette" />
      </div>

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
    </div>
  );
}
