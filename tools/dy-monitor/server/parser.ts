// =====================================================================
//  抖音 im/fetch protobuf 最小解析（逐行對照 Python 版 dycore.decode_im）
//  - 不用 schema：抖音未公開 .proto，原設計即手刻 varint 走訪
//  - 欄位語意全部由實測歸納，改動前先看 tests/dy-monitor-parser.test.ts
// =====================================================================
import { gunzipSync } from "node:zlib";
import type { DecodedIm, DyMessage } from "../types.js";

export interface PbField {
  fn: number;
  wt: number;
  /** wt=0 → number；wt=1/2/5 → Buffer slice */
  value: number | Buffer;
}

/** protobuf base-128 varint（照 Python 的任意精度整數語意，不用 32-bit 位元運算） */
export function readVarint(buf: Buffer, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    if (i >= buf.length) throw new RangeError("varint out of range");
    const byte = buf[i++]!;
    result += (byte % 128) * 2 ** shift;
    shift += 7;
    if (byte < 128) return [result, i];
  }
}

/** 走訪一層 protobuf 欄位；格式錯誤即停止（與 Python 版一致，不拋錯） */
export function readFields(buf: Buffer): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    let key: number;
    try {
      [key, i] = readVarint(buf, i);
    } catch {
      break;
    }
    const fn = Math.floor(key / 8);
    const wt = key % 8;
    if (wt === 0) {
      try {
        const [v, next] = readVarint(buf, i);
        out.push({ fn, wt, value: v });
        i = next;
      } catch {
        break;
      }
    } else if (wt === 2) {
      try {
        const [len, next] = readVarint(buf, i);
        out.push({ fn, wt, value: buf.subarray(next, next + len) });
        i = next + len;
      } catch {
        break;
      }
    } else if (wt === 5) {
      out.push({ fn, wt, value: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wt === 1) {
      out.push({ fn, wt, value: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

const KEEP_METHODS = new Set([
  "WebcastChatMessage",
  "WebcastMemberMessage",
  "WebcastGiftMessage",
  "WebcastLikeMessage",
]);

/** 各訊息型別的 user 區塊欄位號（Chat/Member=2、Gift=7、Like=5） */
const USER_FIELD: Record<string, number> = {
  WebcastChatMessage: 2,
  WebcastMemberMessage: 2,
  WebcastGiftMessage: 7,
  WebcastLikeMessage: 5,
};

/** 暱稱藏在 user 區塊的 field 3（字串）；空字串或含 NUL 視為無效 */
function nickFrom(userBlob: Buffer): string | null {
  for (const f of readFields(userBlob)) {
    if (f.fn === 3 && f.wt === 2 && Buffer.isBuffer(f.value)) {
      const text = f.value.toString("utf8").trim();
      if (text && !text.includes("\u0000")) return text;
    }
  }
  return null;
}

/** 以「字元數」（而非 UTF-16 code unit）計長，對齊 Python len() */
function charLength(s: string): number {
  return [...s].length;
}

/**
 * 解析 im/fetch 回應。
 * @param body 原始 bytes（可能是 gzip，首 byte 0x1f）
 * @param now  時間來源（epoch 秒），測試可注入
 */
export function decodeIm(
  body: Buffer,
  now: () => number = () => Date.now() / 1000
): DecodedIm {
  let buf = body;
  if (buf.length > 0 && buf[0] === 0x1f) {
    try {
      buf = gunzipSync(buf);
    } catch {
      return { messages: [], cursor: null };
    }
  }

  const messages: DyMessage[] = [];
  let cursor: string | null = null;

  for (const top of readFields(buf)) {
    if (top.fn === 2 && top.wt === 2 && Buffer.isBuffer(top.value)) {
      cursor = top.value.toString("utf8");
      continue;
    }
    if (top.fn !== 1 || top.wt !== 2 || !Buffer.isBuffer(top.value)) continue;

    const wrap = readFields(top.value);
    let method = "";
    let payload: Buffer | null = null;
    let msgId = "";
    for (const f of wrap) {
      if (f.fn === 1 && f.wt === 2 && Buffer.isBuffer(f.value)) {
        method = f.value.toString("utf8");
      } else if (f.fn === 2 && f.wt === 2 && Buffer.isBuffer(f.value)) {
        payload = f.value;
      } else if ((f.fn === 4 || f.fn === 5) && f.wt === 2 && Buffer.isBuffer(f.value)) {
        msgId = f.value.toString("utf8");
      }
    }
    if (!payload || !KEEP_METHODS.has(method)) continue;

    // ── 禮物：gift_id(2) / repeat(5,6) / GiftStruct(15) 內 name(16) 或 desc(2) ──
    let giftId = 0;
    let repeat = 0;
    let giftName = "";
    if (method === "WebcastGiftMessage") {
      for (const f of readFields(payload)) {
        if (f.wt === 0 && typeof f.value === "number") {
          if (f.fn === 2) giftId = f.value;
          else if ((f.fn === 5 || f.fn === 6) && !repeat) repeat = f.value;
        } else if (f.wt === 2 && f.fn === 15 && Buffer.isBuffer(f.value)) {
          for (const g of readFields(f.value)) {
            if (g.wt !== 2 || !Buffer.isBuffer(g.value)) continue;
            const text = g.value.toString("utf8").trim();
            if (!text) continue;
            if (g.fn === 16) giftName = text;
            else if (g.fn === 2 && !giftName) giftName = text;
          }
        }
      }
    }

    // ── 內容(3) 與巢狀區塊（找暱稱用）──
    let content = "";
    const nested: { fn: number; buf: Buffer }[] = [];
    for (const f of readFields(payload)) {
      if (f.fn === 3 && f.wt === 2 && Buffer.isBuffer(f.value)) {
        content = f.value.toString("utf8");
      } else if (f.wt === 2 && Buffer.isBuffer(f.value)) {
        nested.push({ fn: f.fn, buf: f.value });
      }
    }

    let nick = "";
    const wantUser = USER_FIELD[method];
    if (wantUser !== undefined) {
      for (const n of nested) {
        if (n.fn !== wantUser) continue;
        const cand = nickFrom(n.buf);
        if (cand) {
          nick = cand;
          break;
        }
      }
    }
    if (!nick) {
      // 保底：掃所有可能的 user 區塊，取第一個「像暱稱」的字串
      for (const n of nested) {
        if (n.fn !== 1 && n.fn !== 2 && n.fn !== 7 && n.fn !== 5 && n.fn !== 8) continue;
        const cand = nickFrom(n.buf);
        if (!cand || cand === content) continue;
        const len = charLength(cand);
        if (len >= 1 && len <= 30) {
          nick = cand;
          break;
        }
      }
    }

    messages.push({
      type: method.replace("Webcast", "").replace("Message", ""),
      nickname: nick,
      content,
      gift_id: giftId,
      repeat,
      gift_name: giftName,
      msg_id: msgId,
      ts: now(),
    });
  }

  return { messages, cursor };
}
