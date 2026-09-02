// =====================================================================
//  FILE VAULT client 頁面（auth 狀態機）
//    checking → locked（LockScreen）或 open（VaultUI）
// =====================================================================
import { useEffect, useState } from "react";
import { vaultApi } from "./api";
import LockScreen from "./LockScreen";
import VaultUI from "./VaultUI";

type Phase = "checking" | "locked" | "open";

export default function FileVaultPage() {
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    let alive = true;
    vaultApi
      .me()
      .then((authed) => {
        if (!alive) return;
        setPhase(authed ? "open" : "locked");
      })
      .catch(() => {
        if (alive) setPhase("locked");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (phase === "checking") {
    return <div className="tool-loading">ACCESSING VAULT…</div>;
  }
  if (phase === "locked") {
    return (
      <LockScreen
        onUnlocked={() => {
          setPhase("open");
        }}
      />
    );
  }
  return (
    <VaultUI
      onLogout={() => {
        void vaultApi.logout().finally(() => setPhase("locked"));
      }}
    />
  );
}
