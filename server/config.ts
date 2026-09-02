// =====================================================================
//  伺服器設定（env 驅動）
// =====================================================================
import path from "node:path";

export interface ServerConfig {
  /** HTTP listen port */
  port: number;
  /** 資料目錄（SQLite、上傳檔案都放這裡） */
  dataDir: string;
  /** 管理密碼（單一管理員） */
  adminPassword: string;
  /** session cookie HMAC 簽名密鑰 */
  sessionSecret: string;
  /** production 時要 serve 的前端 dist 目錄（null = 不 serve 靜態，純 API 模式） */
  distDir: string | null;
  /** cookie Secure 旗標（HTTPS 下才開） */
  cookieSecure: boolean;
  /** 登入失敗鎖定：max 次 / window ms */
  loginRateMax: number;
  loginRateWindowMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const cwd = process.cwd();
  const dataDir = env.VAULT_DATA_DIR ? path.resolve(env.VAULT_DATA_DIR) : path.join(cwd, "data");
  const distDir = env.VAULT_DIST_DIR ? path.resolve(env.VAULT_DIST_DIR) : null;

  return {
    port: Number(env.PORT ?? 3001),
    dataDir,
    adminPassword: env.VAULT_ADMIN_PASSWORD ?? "admin123", // ⚠️ 僅開發預設，production 必設
    sessionSecret: env.VAULT_SESSION_SECRET ?? "dev-secret-change-me",
    distDir: distDir ?? (env.NODE_ENV === "production" ? path.join(cwd, "dist") : null),
    cookieSecure: env.NODE_ENV === "production",
    loginRateMax: 5,
    loginRateWindowMs: 15 * 60 * 1000,
  };
}
