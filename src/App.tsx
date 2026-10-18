// =====================================================================
//  App：路由根
//    /                → 作品集首頁（PortfolioPage）
//    /tools/:toolId   → 工具殼（ToolShell，依 CLIENT_TOOLS 找 tool）
//    *                → 回首頁
// =====================================================================
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import PortfolioPage from "./PortfolioPage";
import ToolShell from "./components/ToolShell";
import { TransitionProvider } from "./components/RouteTransition";

// dy-monitor 歷史頁（P3）：獨立 lazy chunk，不影響主站與工具首頁 bundle
const DyHistoryPage = lazy(() => import("../tools/dy-monitor/client/DyHistoryPage"));
const DySessionPage = lazy(() => import("../tools/dy-monitor/client/DySessionPage"));
const historyFallback = <div className="tool-loading">LOADING ARCHIVE…</div>;

export default function App() {
  return (
    <TransitionProvider>
      <Routes>
        <Route path="/" element={<PortfolioPage />} />
        <Route
          path="/tools/dy-monitor/history"
          element={
            <Suspense fallback={historyFallback}>
              <DyHistoryPage />
            </Suspense>
          }
        />
        <Route
          path="/tools/dy-monitor/history/:sid"
          element={
            <Suspense fallback={historyFallback}>
              <DySessionPage />
            </Suspense>
          }
        />
        <Route path="/tools/:toolId" element={<ToolShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TransitionProvider>
  );
}
