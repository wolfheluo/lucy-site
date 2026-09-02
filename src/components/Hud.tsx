// =====================================================================
//  HUD：左上 logo、右上錨點導覽、頂端捲動進度條、
//  右下 FX / MUSIC 開關。
// =====================================================================
import { motion } from "framer-motion";
import { useEffect, useRef, type MouseEvent } from "react";
import { profile } from "../content";
import { sfx } from "../audio/engine";

const LINKS: [string, string][] = [
  ["about", "ABOUT"],
  ["skills", "SKILLS"],
  ["projects", "PROJECTS"],
  ["contact", "CONTACT"],
];

function ProgressBar() {
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = barRef.current;
      if (el) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
        el.style.transform = `scaleX(${p})`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="hud-progress">
      <i ref={barRef} />
    </div>
  );
}

interface HudProps {
  visible: boolean;
  fxOn: boolean;
  onToggleFx: () => void;
  ambOn: boolean;
  onToggleAmb: () => void;
  reduced: boolean;
}

export default function Hud({ visible, fxOn, onToggleFx, ambOn, onToggleAmb, reduced }: HudProps) {
  const go = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    sfx.click();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  return (
    <motion.header
      className="hud"
      initial={{ opacity: 0 }}
      animate={visible ? { opacity: 1 } : {}}
      transition={{ duration: 0.7 }}
    >
      <ProgressBar />
      <div className="hud-top">
        <div className="logo" data-hover>
          ▲ {profile.handle.toUpperCase()}
          <span className="dot">_</span>
        </div>
        <nav aria-label="主要導覽">
          {LINKS.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={go(id)} onMouseEnter={() => sfx.hover()}>
              {label}
            </a>
          ))}
        </nav>
      </div>

      <div className="toggles" style={{ pointerEvents: visible ? "auto" : "none" }}>
        <button
          type="button"
          className={`tbtn amb${ambOn ? " on" : ""}`}
          data-hover
          onClick={() => {
            sfx.click();
            onToggleAmb();
          }}
          aria-pressed={ambOn}
        >
          {ambOn ? (
            <span className="eq" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <span className="led" />
          )}
          MUSIC
        </button>
        <button
          type="button"
          className={`tbtn${fxOn ? " on" : ""}`}
          data-hover
          onClick={() => {
            sfx.click();
            onToggleFx();
          }}
          aria-pressed={fxOn}
        >
          <span className="led" />
          CRT
        </button>
      </div>
    </motion.header>
  );
}
