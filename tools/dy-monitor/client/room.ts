// 從網址或純數字取出抖音直播間號（與 server/engine.ts 的 parseRid 同規則）
export function parseRid(text: string | null | undefined): string | null {
  const m = /(\d{6,})/.exec(text ?? "");
  return m ? m[1]! : null;
}
