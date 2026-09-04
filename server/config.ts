// =====================================================================
//  伺服器設定（env 驅動）
//  - 支援 .env：module 載入時若存在即自動讀取（Node ≥20.12 內建 API）
//  - H1 防呆：NODE_ENV=production 時禁止使用預設密碼 / 密鑰
//  - H3：預設 listen 127.0.0.1；只有 TRUST_PROXY=1 才信任 X-Forwarded-For
// =====================================================================
import path from "node:path";

export interface ServerConfig {
  /** HTTP listen port */
  port: number;
  /** HTTP listen host（production 建議 127.0.0.1，前方由 nginx 反代） */
  bindHost: string;
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
  /** 是否信任上層代理的 X-Forwarded-For（僅在可信 nginx 反代後設 1） */
  trustProxy: boolean;
  /** 登入失敗鎖定：max 次 / window ms */
  loginRateMax: number;
  loginRateWindowMs: number;
  /** DeepSeek API key（nav 顯示 CNY 餘額用；null = 未設定） */
  apiKey: string | null;
}

export const DEFAULT_ADMIN_PASSWORD = "admin123";
export const DEFAULT_SESSION_SECRET = "dev-secret-change-me";

// .env 支援：檔案不存在或 Node 無此 API 時靜默略過
try {
  process.loadEnvFile?.();
} catch {
  /* .env 不存在 */
}

/** 解析正整數 env；缺值或非法（含 NaN）時回傳 fallback（L7） */
function intEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const cwd = process.cwd();
  const dataDir = env.VAULT_DATA_DIR ? path.resolve(env.VAULT_DATA_DIR) : path.join(cwd, "data");
  const distDir = env.VAULT_DIST_DIR ? path.resolve(env.VAULT_DIST_DIR) : null;
  const isProd = env.NODE_ENV === "production";
  const adminPassword = env.VAULT_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
  const sessionSecret = env.VAULT_SESSION_SECRET ?? DEFAULT_SESSION_SECRET;

  // H1：production 絕不能用開發預設值（一漏設就是公開的管理密碼 / 可偽造的密鑰）
  if (
    isProd &&
    (adminPassword === DEFAULT_ADMIN_PASSWORD || sessionSecret === DEFAULT_SESSION_SECRET)
  ) {
    throw new Error(
      "[config] production 禁止使用預設密碼/密鑰：請設定 VAULT_ADMIN_PASSWORD 與 VAULT_SESSION_SECRET"
    );
  }

  return {
    port: intEnv(env.PORT, 3001),
    bindHost: env.HOST ?? "127.0.0.1",
    dataDir,
    adminPassword,
    sessionSecret,
    distDir: distDir ?? (isProd ? path.join(cwd, "dist") : null),
    cookieSecure: isProd,
    trustProxy: env.TRUST_PROXY === "1",
    loginRateMax: intEnv(env.VAULT_LOGIN_RATE_MAX, 5),
    loginRateWindowMs: 15 * 60 * 1000,
    apiKey: env.API_KEY && env.API_KEY.length > 0 ? env.API_KEY : null,
  };
}

