// =====================================================================
//  PortfolioPage：作品集首頁（原 App 內容）
//  boot / 3D 場景 / 內容段落 / HUD / CRT / 游標 —— 全部保留原樣
// =====================================================================
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
// M9：3D 場景（three / drei / postprocessing）獨立 chunk，首載不阻塞
const Scene3D = lazy(() => import("./three/Scene3D"));
import { supportsWebGL, useCoarsePointer, usePrefersReducedMotion } from "./hooks";
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

  const [webglOk, setWebglOk] = useState(true);
  const [booted, setBooted] = useState(reduced);
  // boot 碎裂 overlay 是否已真正退場（decode 登場時機——被 overlay 蓋著播 = 看不到）
  // 兜底：framer exit 若卡（RouteTransition 黑屏同類）onExitComplete 不 fire → 1.5s 強制
  const [bootGone, setBootGone] = useState(reduced);
  useEffect(() => {
    if (!booted || reduced) return;
    const t = setTimeout(() => setBootGone(true), 1500);
    return () => clearTimeout(t);
  }, [booted, reduced]);
  const [fxOn, setFxOn] = useState(true);
  const [ambOn, setAmbOn] = useState(false);

  // 從工具頁返回時回到頂端，並復原主站標題（L5）
  useEffect(() => {
    window.scrollTo(0, 0);
    // 品牌化 title（與 index.html 同步；改名時兩處都改）
    document.title = `${profile.name} // ${profile.roleEn.split(" ")[0]}`;
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && !supportsWebGL()) setWebglOk(false);
  }, []);

  useEffect(() => {
    return () => sfx.stopAmbient();
  }, []);

  // 2026-09 使用者決策：手機直接開完整 3D（貼圖月球）——不再 2D 降級；
  // 低階機若卡頓再考慮 Scene3D 精簡 profile（webgl 失敗/reduced 仍走 fallback）
  const useCanvas = webglOk && !reduced;

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
              {/* boot 碎裂退場前 frameloop="never"（被不透明 Boot 蓋住）；context lost → onFatal 降級 */}
              <Scene3D active={bootGone} onFatal={() => setWebglOk(false)} />
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
        bootGone={bootGone}
        fxOn={fxOn}
        onToggleFx={() => setFxOn((v) => !v)}
        ambOn={ambOn}
        onToggleAmb={toggleAmb}
        reduced={reduced}
      />

      {fxOn && !reduced && !coarse && booted && <CustomCursor />}

      {!bootGone && !reduced && (
        <BootScreen
          key="boot"
          onDone={() => setBooted(true)}
          onGone={() => setBootGone(true)}
        />
      )}
    </>
  );
}
