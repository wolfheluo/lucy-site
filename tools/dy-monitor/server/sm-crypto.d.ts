// sm-crypto 沒有官方型別，且是 CommonJS（ESM 具名匯入在 Node 會失敗）
// → 一律用 default import 再取屬性
declare module "sm-crypto" {
  interface SmCrypto {
    /** 回傳小寫 hex 字串 */
    sm3(input: string | number[]): string;
  }
  const smCrypto: SmCrypto;
  export default smCrypto;
}
