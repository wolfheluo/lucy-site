// =====================================================================
//  LockScreen：ACCESS DENIED 鎖定畫面（NETRUNNER 語彙）
//  - 錯密碼：紅光 shake + 剩餘次數
//  - 鎖定：429 倒數
// =====================================================================
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import GlitchText from "../../../src/components/GlitchText";
import { vaultApi } from "./api";

type LockState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string; remaining?: number }
  | { kind: "locked"; retryAfterSec: number };

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pw, setPw] = useState("");
  const [state, setState] = useState<LockState>({ kind: "idle" });
  const [shakeKey, setShakeKey] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const rm = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);

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

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (state.kind === "busy" || state.kind === "locked") return;
    setState({ kind: "busy" });
    try {
      await vaultApi.login(pw);
      onUnlocked();
    } catch (err) {
      const e2 = err as Error & { status?: number };
      setShakeKey((k) => k + 1);
      if (e2.status === 429) {
        const sec = Number(
          /(\d+)/.exec(e2.message)?.[1] ?? 60
        );
        setState({ kind: "locked", retryAfterSec: Math.max(1, sec) });
      } else {
        setState({ kind: "error", message: "ACCESS DENIED // 密碼錯誤" });
      }
      setPw("");
      inputRef.current?.focus();
    }
  };

  const locked = state.kind === "locked";
  const statusLine =
    state.kind === "error"
      ? state.message
      : locked
        ? `CONNECTION LOCKED // ${countdown}s`
        : "RESTRICTED AREA // 僅限管理員";

  return (
    <div className="vault-lock">
      <motion.div
        key={shakeKey}
        animate={shakeKey > 0 && !rm ? { x: [0, -10, 10, -6, 6, 0] } : undefined}
        transition={{ duration: 0.4 }}
        className="vault-lock-panel glass"
      >
        <div className="vault-lock-head">
          <span className="vault-lock-led" />
          <span className="vault-lock-os">NETRUNNER OS // SECURE CHANNEL</span>
        </div>

        <GlitchText
          className="vault-lock-title"
          text="ACCESS DENIED"
          start
          delayMs={150}
          hover
          instant={rm === true}
        />
        <div className="vault-lock-sub">檔案保險箱 // FILE VAULT</div>

        <form onSubmit={submit} className="vault-lock-form">
          <label htmlFor="vault-pw">&gt; AUTH_PASSWORD:</label>
          <div className="vault-lock-inputrow">
            <span className="vault-lock-prompt">▮</span>
            <input
              ref={inputRef}
              id="vault-pw"
              type="password"
              value={pw}
              autoFocus
              autoComplete="current-password"
              disabled={locked}
              onChange={(e) => setPw(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <button type="submit" className="vault-btn vault-btn-primary" disabled={locked || state.kind === "busy"}>
            {state.kind === "busy" ? "VERIFYING…" : "UNLOCK ▸"}
          </button>
        </form>

        <AnimatePresence mode="wait">
          <motion.div
            key={statusLine + shakeKey}
            initial={rm ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={
              state.kind === "error" || locked
                ? "vault-lock-status err"
                : "vault-lock-status"
            }
          >
            {statusLine}
          </motion.div>
        </AnimatePresence>

        <div className="vault-lock-hint">[ 此區域僅限竄網使本人進入 ]</div>
      </motion.div>
    </div>
  );
}
