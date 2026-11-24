// =====================================================================
//  a_bogus 簽名介面（P1 只留插槽；P2 才實作 abogus.ts）
//  - 失敗時回 { ok:false, reason }，呼叫端據此把「觀眾榜」標成待啟用，
//    不得讓整個引擎失敗（免簽名的房間快照/彈幕照常運作）。
// =====================================================================

export interface SignerResult {
  ok: boolean;
  /** 已 URL-encode 的 a_bogus 參數值 */
  aBogus?: string;
  /** 簽名時使用的 UA（指紋需與簽名一致） */
  userAgent?: string;
  reason?: string;
}

export interface AbogusSigner {
  readonly ready: boolean;
  generate(params: string, body?: string): SignerResult;
}

/** P1 佔位：明確回報未實作，讓 UI 顯示「榜單待啟用」而不是靜默空白 */
export const stubSigner: AbogusSigner = {
  ready: false,
  generate: () => ({ ok: false, reason: "a_bogus 簽名尚未移植（P2）" }),
};
