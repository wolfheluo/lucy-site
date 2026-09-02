// =====================================================================
//  LockScreen：ACCESS DENIED 鎖定畫面（NETRUNNER 三幕儀式）
//  幕 1  進場：terminal 逐行「建立安全連線」→ ICE 牆偵測
//  幕 2  標題：ACCESS DENIED 亂碼解碼 + glitch burst
//  幕 3  錯密碼 →「入侵反應」：標題被亂碼覆寫、RGB 破碎 ghost、
//          panel 碎裂抖動、碎屑掉落、紅 flash、INTRUDER DETECTED 警示
//         解鎖成功 → 碎裂退場（exit 動畫）+ granted 上行音
// =====================================================================
import { useEffect, useRef, useState } from "react";
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

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pw, setPw] = useState("");
  const [state, setState] = useState<LockState>({ kind: "idle" });
  const [lineCount, setLineCount] = useState(0);
  const [titleStart, setTitleStart] = useState(false);
  const [burstTick, setBurstTick] = useState(0); // 標題 RGB burst 觸發
  const [hacking, setHacking] = useState(false); // 入侵碎裂中
  const [hackText, setHackText] = useState<string | null>(null); // 亂碼覆寫
  const [redFlash, setRedFlash] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const rm = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);

  // 幕 1：terminal 逐行（每 430ms 一行，完成後開始幕 2）
  useEffect(() => {
    if (rm === true) {
      setLineCount(BOOT_LINES.length);
      setTitleStart(true);
      setBurstTick(1);
      return;
    }
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
          setTitleStart(true);
          setBurstTick(1);
          sfx.decode();
        }, 280);
      }
    }, 430);
    return () => clearInterval(t);
  }, [rm]);

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

  /**
   * 入侵反應：標題被亂碼覆寫 → RGB 破碎 ghost → panel 碎裂 + 碎屑 + 紅 flash
   * （reduced-motion 下直接顯示錯誤，不動畫）
   */
  const runIntrusion = () => {
    sfx.denied();
    if (rm === true) return;
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
      if (n >= 7) {
        window.clearInterval(t);
        setHackText(null);
        window.setTimeout(() => {
          setHacking(false);
          setRedFlash(false);
        }, 950);
      }
    }, 65);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (state.kind === "busy" || state.kind === "locked" || leaving) return;
    setState({ kind: "busy" });
    try {
      await vaultApi.login(pw);
      sfx.granted();
      setLeaving(true);
      // 碎裂退場完成後才揭露 vault
      window.setTimeout(onUnlocked, rm === true ? 0 : 640);
    } catch (err) {
      const e2 = err as Error & { status?: number };
      if (e2.status === 429) {
        const sec = Number(/(\d+)/.exec(e2.message)?.[1] ?? 60);
        setState({ kind: "locked", retryAfterSec: Math.max(1, sec) });
        runIntrusion();
      } else {
        setState({ kind: "error", message: "ACCESS DENIED // 密碼錯誤" });
        runIntrusion();
      }
      setPw("");
      inputRef.current?.focus();
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

  return (
    <div className="vault-lock">
      {/* 入侵紅 flash（整頁） */}
      {redFlash && <div className="vault-intruder-flash" aria-hidden="true" />}

      <div
        className={`vault-lock-panel glass${hacking ? " hacked" : ""}${
          locked ? " locked" : ""
        }`}
      >
        {/* 入侵碎屑 */}
        <span className="vault-shard s1" style={{ left: "38%" }} aria-hidden="true" />
        <span className="vault-shard s2" aria-hidden="true" />
        <span className="vault-shard s3" aria-hidden="true" />

        <AnimatePresence mode="wait">
          {!leaving ? (
            <motion.div
              key="inner"
              exit={
                rm === true
                  ? { opacity: 0 }
                  : {
                      clipPath: [
                        "inset(0 0 0 0)",
                        "inset(6% 0 44% 0)",
                        "inset(0 0 0 0)",
                        "inset(48% 0 5% 0)",
                        "inset(0 0 100% 0)",
                      ],
                      opacity: [1, 1, 0.6, 1, 0],
                      transition: { duration: 0.55, times: [0, 0.25, 0.45, 0.65, 1] },
                    }
              }
            >
              <div className="vault-lock-head">
                <span className="vault-lock-led" />
                <span className="vault-lock-os">NETRUNNER OS // SECURE CHANNEL</span>
              </div>

              {/* 入侵警示 */}
              {hacking && (
                <div className="vault-intruder" role="alert">
                  <span className="warn-tri">▲</span>
                  INTRUDER DETECTED // 入侵者已鎖定
                </div>
              )}

              {/* 幕 1：terminal 逐行 */}
              <div className="vault-lock-term" aria-hidden="true">
                {BOOT_LINES.slice(0, lineCount).map((l) => (
                  <div key={l.t} className={l.ok ? "ok" : "bad"}>
                    {l.t}
                  </div>
                ))}
                {lineCount < BOOT_LINES.length && <span className="vault-term-cursor" />}
              </div>

              {/* 幕 2：ACCESS DENIED 標題（hacked 時亂碼覆寫 + RGB ghost 破碎） */}
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
