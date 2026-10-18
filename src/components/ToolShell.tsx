// =====================================================================
//  ToolShell：一般工具頁（依 :toolId 找 CLIENT_TOOLS，外框交給 ToolFrame）
// =====================================================================
import { useEffect } from "react";
import { Navigate, useParams } from "react-router";
import { CLIENT_TOOLS } from "../tools";
import ToolFrame from "./ToolFrame";

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
      lock={tool.meta.id === "binance-api"}
      loading="LOADING MODULE…"
    >
      <Comp />
    </ToolFrame>
  );
}
