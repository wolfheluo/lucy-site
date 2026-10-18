// =====================================================================
//  ToolShell：一般工具頁（依 :toolId 找 CLIENT_TOOLS，外框交給 ToolFrame）
// =====================================================================
import { useEffect } from "react";
import { Navigate, useParams } from "react-router";
import { CLIENT_TOOLS } from "../tools";
import ToolFrame from "./ToolFrame";

/** 需要「整頁鎖高、免滾動」的工具（≥981px；窄版自動退回自然滾動） */
const LOCKED_TOOLS = new Set(["binance-api", "dy-monitor"]);

export default function ToolShell() {
  const { toolId } = useParams();
  const tool = CLIENT_TOOLS.find((t) => t.meta.id === toolId);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (tool) document.title = `${tool.meta.title} // ${tool.meta.zhTitle}`;
  }, [toolId, tool]);

  if (!tool) return <Navigate to="/" replace />;
  const Comp = tool.Component;

  return (
    <ToolFrame
      title={tool.meta.title}
      zh={tool.meta.zhTitle}
      lock={LOCKED_TOOLS.has(tool.meta.id)}
      loading="LOADING MODULE…"
    >
      <Comp />
    </ToolFrame>
  );
}
