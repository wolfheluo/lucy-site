// =====================================================================
//  PortfolioPage：作品集首頁（原 App 內容）
//  boot / 3D 場景 / 內容段落 / HUD / CRT / 游標 —— 全部保留原樣
// =====================================================================
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
// M9：3D 場景（three / drei / postprocessing）獨立 chunk，首載不阻塞
const Scene3D = lazy(() => import("./three/Scene3D"));
import { supportsWebGL, useCoarsePointer, useMediaQuery, usePrefersReducedMotion } from "./hooks";
import { profile } from "./content";
import { sfx } from "./audio/engine";
import BootScreen from "./components/BootScreen";
import CustomCursor from "./components/CustomCursor";
import FallbackBackdrop from "./components/FallbackBackdrop";
import Hud from "./components/Hud";
import Sections from "./components/Sections";

/** Canvas 執行期錯誤（如 WebGL context 失敗）→ 切到靜態背景 */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function PortfolioPage() {
  const reduced = usePrefersReducedMotion();
  const coarse = useCoarsePointer();
  const narrow = useMediaQuery("(max-width: 900px)");
  const mobile = coarse || narrow;

  const [webglOk, setWebglOk] = useState(true);
  const [booted, setBooted] = useState(reduced);
  const [fxOn, setFxOn] = useState(true);
  const [ambOn, setAmbOn] = useState(false);

  // 從工具頁返回時回到頂端，並復原主站標題（L5）
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `${profile.name} // ${profile.roleEn.split(" ")[0]}`;
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && !supportsWebGL()) setWebglOk(false);
  }, []);

  useEffect(() => {
    return () => sfx.stopAmbient();
  }, []);

  const useCanvas = webglOk && !mobile && !reduced;

  const toggleAmb = () => {
    if (ambOn) {
      sfx.stopAmbient();
      setAmbOn(false);
    } else {
      sfx.startAmbient();
      setAmbOn(true);
    }
  };

  return (
    <>
      {useCanvas ? (
        <div className="scene">
          <SceneBoundary fallback={<FallbackBackdrop />}>
            <Suspense fallback={<FallbackBackdrop />}>
              <Scene3D />
            </Suspense>
          </SceneBoundary>
        </div>
      ) : (
        <FallbackBackdrop />
      )}

      {fxOn && !reduced && booted && (
        <div className="fx-layer" aria-hidden="true">
          <div className="scanlines" />
          <div className="scanbar" />
          <div className="vignette" />
          <div className="noise" />
        </div>
      )}

      <main className="content">
        <Sections booted={booted} instant={reduced} />
      </main>

      <Hud
        visible={booted}
        fxOn={fxOn}
        onToggleFx={() => setFxOn((v) => !v)}
        ambOn={ambOn}
        onToggleAmb={toggleAmb}
        reduced={reduced}
      />

      {fxOn && !reduced && !coarse && booted && <CustomCursor />}

      <AnimatePresence>
        {!booted && !reduced && <BootScreen key="boot" onDone={() => setBooted(true)} />}
      </AnimatePresence>
    </>
  );
}
