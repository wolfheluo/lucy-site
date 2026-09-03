// =====================================================================
//  LockScreen：ACCESS DENIED 鎖定畫面（NETRUNNER 三幕儀式 + 破碎重生）
//  幕 1  進場：terminal 逐行「建立安全連線」→ ICE 牆偵測
//  幕 2  標題：ACCESS DENIED 亂碼解碼 + glitch burst
//  錯密碼 →「入侵反應」：亂碼覆寫 + 紅 flash + INTRUDER 警示
//          → 整面 panel 炸碎（clip-path 撕裂 + 碎片噴發）
//          → ~1s 後掃描重生（新 panel clip 展開 + 幕 1 重播）
//  解鎖成功 → 碎裂退場 + granted 上行音
// =====================================================================
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import GlitchText from "../../../src/components/GlitchText";
import { sfx } from "../../../src/audio/engine";
import { vaultApi } from "./api";

const BOOT_LINES = [
  { t: "> ESTABLISHING SECURE LINK", ok: true },
  { t: "> HANDSHAKE OK // ENCRYPTED", ok: true },
  { t: "> ICE WALL DETECTED", ok: false },
];

const TITLE = "ACCESS DENIED";
const HACK_CHARS = "01<>/\\#$%&@!?";

type LockState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string }
  | { kind: "locked"; retryAfterSec: number };

interface Shard {
  x: number; // %
  y: number; // %
  w: number; // px
  h: number;
  dx: number;
  dy: number;
  rot: number;
  delay: number;
  hot: boolean;
}

function generateShards(n = 16): Shard[] {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const dir = (a: number, b: number) => (Math.random() > 0.5 ? 1 : -1) * rnd(a, b);
  return Array.from({ length: n }, () => ({
    x: rnd(8, 88),
    y: rnd(12, 86),
    w: rnd(10, 26),
    h: rnd(7, 18),
    dx: dir(70, 200),
    dy: dir(60, 220),
    rot: dir(160, 480),
    delay: rnd(0, 0.06),
    hot: Math.random() < 0.25,
  }));
}

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pw, setPw] = useState("");
  const [state, setState] = useState<LockState>({ kind: "idle" });
  const [lineCount, setLineCount] = useState(0);
  const [titleStart, setTitleStart] = useState(false);
  const [burstTick, setBurstTick] = useState(0);
  const [hacking, setHacking] = useState(false);
  const [hackText, setHackText] = useState<string | null>(null);
  const [redFlash, setRedFlash] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [gen, setGen] = useState(0); // panel 世代（重生 +1）
  const [breaking, setBreaking] = useState(false); // 破碎階段
  const [shards, setShards] = useState<Shard[]>([]);
  const rm = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const leavingRef = useRef(false);
  const breakingRef = useRef(false);

  // 幕 1：terminal 逐行（gen 改變 = 初始或重生 → 重播）
  useEffect(() => {
    if (leavingRef.current) return;
    if (rm === true) {
      setLineCount(BOOT_LINES.length);
      setTitleStart(true);
      setBurstTick(1);
      return;
    }
    setTitleStart(false);
    setBurstTick(0);
    sfx.line();
    let n = 1;
    setLineCount(1);
    const t = setInterval(() => {
      n += 1;
      sfx.line();
      setLineCount(n);
      if (n >= BOOT_LINES.length) {
        clearInterval(t);
        window.setTimeout(() => {
          if (leavingRef.current) return;
          setTitleStart(true);
          setBurstTick(1);
          sfx.decode();
        }, 280);
      }
    }, 430);
    return () => clearInterval(t);
  }, [gen, rm]);

  // 鎖定倒數
  useEffect(() => {
    if (state.kind !== "locked") return;
    setCountdown(state.retryAfterSec);
    const t = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(t);
          setState({ kind: "idle" });
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [state]);

  /** 破碎階段：inner exit 動畫播放 + 碎片噴發 */
  const breakPanel = () => {
    if (breakingRef.current || leavingRef.current) return;
    breakingRef.current = true;
    setHacking(false);
    setShards(generateShards());
    setBreaking(true);
  };

  /** 破碎 exit 完成 → 重生（新世代） */
  const onBrokenDone = () => {
    if (leavingRef.current) return;
    breakingRef.current = false;
    setBreaking(false);
    setGen((g) => g + 1);
    window.setTimeout(() => inputRef.current?.focus(), 900);
  };

  /** 錯密碼：入侵（短版）→ 破碎排程 */
  const runIntrusion = () => {
    sfx.denied();
    if (rm === true) return; // reduced-motion：直接顯示錯誤，不破碎
    setHacking(true);
    setRedFlash(true);
    let n = 0;
    const t = window.setInterval(() => {
      n += 1;
      let s = "";
      for (const ch of TITLE) {
        s += ch === " " ? " " : HACK_CHARS[Math.floor(Math.random() * HACK_CHARS.length)];
      }
      setHackText(s);
      if (n >= 5) {
        window.clearInterval(t);
        setHackText(null);
        window.setTimeout(breakPanel, 400);
      }
    }, 65);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (state.kind === "busy" || state.kind === "locked" || leaving || breaking) return;
    setState({ kind: "busy" });
    try {
      await vaultApi.login(pw);
      sfx.granted();
      leavingRef.current = true;
      setLeaving(true);
      window.setTimeout(onUnlocked, rm === true ? 0 : 640);
    } catch (err) {
      const e2 = err as Error & { status?: number; retryAfterSec?: number };
      if (e2.status === 429) {
        // M4：直接用 server 的 retryAfterSec（不再 regex 解析人類可讀訊息）
        const sec = e2.retryAfterSec ?? 60;
        setState({ kind: "locked", retryAfterSec: Math.max(1, sec) });
      } else {
        setState({ kind: "error", message: "ACCESS DENIED // 密碼錯誤" });
      }
      setPw("");
      runIntrusion();
    }
  };

  const locked = state.kind === "locked";
  const denied = state.kind === "error";
  const statusLine =
    state.kind === "error"
      ? state.message
      : locked
        ? `CONNECTION LOCKED // ${countdown}s`
        : "RESTRICTED AREA // 僅限管理員";

  const shattered = breaking && !rm;

  return (
    <div className="vault-lock">
      {redFlash && <div className="vault-intruder-flash" aria-hidden="true" />}

      <div
        className={`vault-lock-panel glass${hacking ? " hacked" : ""}${
          breaking ? " gone" : ""
        }`}
      >
        {/* 碎片噴發層 */}
        {shattered && (
          <div className="vault-shatter" aria-hidden="true">
            {shards.map((s, i) => (
              <span
                key={i}
                className={`sh${s.hot ? " hot" : ""}`}
                style={
                  {
                    left: `${s.x}%`,
                    top: `${s.y}%`,
                    width: `${s.w}px`,
                    height: `${s.h}px`,
                    "--dx": `${s.dx}px`,
                    "--dy": `${s.dy}px`,
                    "--rot": `${s.rot}deg`,
                    animationDelay: `${s.delay}s`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
        )}

        {/* 重生掃描線 */}
        {gen > 0 && !breaking && !leaving && !rm && (
          <div key={`scan-${gen}`} className="vault-respawn-scan" aria-hidden="true" />
        )}

        <AnimatePresence mode="wait" onExitComplete={onBrokenDone}>
          {!leaving && !breaking ? (
            <motion.div
              key={`inner-${gen}`}
              initial={
                rm === true
                  ? false
                  : gen === 0
                    ? { opacity: 0, y: 12 }
                    : { opacity: 0, clipPath: "inset(0 0 100% 0)" } // 重生：由下往上展開
              }
              animate={{ opacity: 1, y: 0, clipPath: "inset(0 0 0% 0)" }}
              exit={
                rm === true
                  ? undefined
                  : {
                      clipPath: [
                        "inset(0 0 0 0)",
                        "inset(10% 0 42% 0)",
                        "inset(55% 4% 8% 0)",
                        "inset(12% 0 60% 2%)",
                        "inset(0 0 100% 0)",
                      ],
                      rotate: [0, -1.6, 1.2, -0.8, 2.2],
                      scale: [1, 1.02, 1.04, 1.06, 1.12],
                      opacity: [1, 1, 0.85, 0.65, 0],
                      transition: {
                        duration: 0.55,
                        times: [0, 0.25, 0.45, 0.68, 1],
                        ease: "easeIn",
                      },
                    }
              }
            >
              <div className="vault-lock-head">
                <span className="vault-lock-led" />
                <span className="vault-lock-os">NETRUNNER OS // SECURE CHANNEL</span>
              </div>

              {hacking && (
                <div className="vault-intruder" role="alert">
                  <span className="warn-tri">▲</span>
                  INTRUDER DETECTED // 入侵者已鎖定
                </div>
              )}

              <div className="vault-lock-term" aria-hidden="true">
                {BOOT_LINES.slice(0, lineCount).map((l) => (
                  <div key={l.t} className={l.ok ? "ok" : "bad"}>
                    {l.t}
                  </div>
                ))}
                {lineCount < BOOT_LINES.length && <span className="vault-term-cursor" />}
              </div>

              <div
                className={`vault-lock-titlewrap${burstTick > 0 ? " burst" : ""}${
                  hacking ? " hacked" : ""
                }`}
                data-text={TITLE}
              >
                <GlitchText
                  className="vault-lock-title"
                  text={TITLE}
                  start={titleStart}
                  delayMs={120}
                  hover
                  instant={rm === true}
                />
                {hackText && (
                  <span className="hack-overlay" aria-hidden="true">
                    {hackText}
                  </span>
                )}
              </div>
              <div className="vault-lock-sub">檔案保險箱 // FILE VAULT</div>

              <form onSubmit={submit} className="vault-lock-form">
                <label htmlFor="vault-pw">&gt; AUTH_PASSWORD:</label>
                <div className={`vault-lock-inputrow${denied ? " deny" : ""}`}>
                  <span className="vault-lock-prompt">▮</span>
                  <input
                    ref={inputRef}
                    id="vault-pw"
                    type="password"
                    value={pw}
                    autoFocus
                    autoComplete="current-password"
                    disabled={locked || leaving}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
                <button
                  type="submit"
                  className="vault-btn vault-btn-primary"
                  disabled={locked || state.kind === "busy" || leaving}
                >
                  {state.kind === "busy" ? "VERIFYING…" : "UNLOCK ▸"}
                </button>
              </form>

              <div
                className={denied || locked ? "vault-lock-status err" : "vault-lock-status"}
              >
                {statusLine}
              </div>

              <div className="vault-lock-hint">[ 此區域僅限竄網使本人進入 ]</div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
