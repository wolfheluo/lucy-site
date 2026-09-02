// =====================================================================
//  App：路由根
//    /                → 作品集首頁（PortfolioPage）
//    /tools/:toolId   → 工具殼（ToolShell，依 CLIENT_TOOLS 找 tool）
//    *                → 回首頁
// =====================================================================
import { Navigate, Route, Routes } from "react-router";
import PortfolioPage from "./PortfolioPage";
import ToolShell from "./components/ToolShell";
import { TransitionProvider } from "./components/RouteTransition";

export default function App() {
  return (
    <TransitionProvider>
      <Routes>
        <Route path="/" element={<PortfolioPage />} />
        <Route path="/tools/:toolId" element={<ToolShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TransitionProvider>
  );
}
