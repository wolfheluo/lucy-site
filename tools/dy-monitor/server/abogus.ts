// =====================================================================
//  a_bogus 簽名（P2）——由 Python 版 abogus.py（f2 移植）逐行改寫
//  結構與原版一致：
//    SM3(params + "cus") 二次雜湊 → transform_bytes（自訂 stateful 置換）
//    → 隨機前綴 → 自訂 base64 編碼
//  所有隨機與時間來源都可注入，供 parity 測試固定輸入後逐位元對照。
// =====================================================================
import smCrypto from "sm-crypto";
import type { AbogusSigner, SignerResult } from "./signer.js";

const BIG_ARRAY: number[] = [121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78, 101, 250, 207, 198, 50, 139, 227, 220, 105, 97, 143, 34, 28, 194, 215, 18, 100, 159, 160, 43, 8, 169, 217, 180, 120, 247, 45, 90, 11, 27, 197, 46, 3, 84, 72, 5, 68, 62, 56, 221, 75, 144, 79, 73, 161, 178, 81, 64, 187, 134, 117, 186, 118, 16, 241, 130, 71, 89, 147, 122, 129, 65, 40, 88, 150, 110, 219, 199, 255, 181, 254, 48, 4, 195, 248, 208, 32, 116, 167, 69, 201, 17, 124, 125, 104, 96, 83, 80, 127, 236, 108, 154, 126, 204, 15, 20, 135, 112, 158, 13, 1, 188, 164, 210, 237, 222, 98, 212, 77, 253, 42, 170, 202, 26, 22, 29, 182, 251, 10, 173, 152, 58, 138, 54, 141, 185, 33, 157, 31, 252, 132, 233, 235, 102, 196, 191, 223, 240, 148, 39, 123, 92, 82, 128, 109, 57, 24, 38, 113, 209, 245, 2, 119, 153, 229, 189, 214, 230, 174, 232, 63, 52, 205, 86, 140, 66, 175, 111, 171, 246, 133, 238, 193, 99, 60, 74, 91, 225, 51, 76, 37, 145, 211, 166, 151, 213, 206, 0, 200, 244, 176, 218, 44, 184, 172, 49, 216, 93, 168, 53, 21, 183, 41, 67, 85, 224, 155, 226, 242, 87, 177, 146, 70, 190, 12, 162, 19, 137, 114, 25, 165, 163, 192, 23, 59, 9, 94, 179, 107, 35, 7, 142, 131, 239, 203, 149, 136, 61, 249, 14, 156];

const UA_KEY = Buffer.from([0x00, 0x01, 0x0e]);

const CHARACTER =
  "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
const CHARACTER2 =
  "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const CHARACTER_LIST = [CHARACTER, CHARACTER2];

const SORT_INDEX = [
  18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22,
  28, 32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71,
];
const SORT_INDEX_2 = [
  18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33,
  37, 44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71,
];

/** Python ord() 語意：逐 code point（非 UTF-16 unit） */
function toCodePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0) ?? 0);
  return out;
}

function codePointsToString(codes: number[]): string {
  let out = "";
  for (const c of codes) out += String.fromCharCode(c);
  return out;
}

/** Python int(time.time()*1000) 的無號位移（JS 位元運算只有 32-bit，不能用 >>） */
function byteAt(value: number, shift: number): number {
  return Math.floor(value / 2 ** shift) % 256;
}

export interface AbogusOptions {
  userAgent?: string;
  /** 瀏覽器指紋（預設隨機產生） */
  fp?: string;
  /** GET=[0,1,8]  POST=[0,1,14] */
  options?: [number, number, number];
  /** epoch 毫秒（測試可注入） */
  now?: () => number;
  /** 0<=x<1（測試可注入固定序列） */
  randomFloat?: () => number;
  /** 取整隨機（測試可注入） */
  randomInt?: (min: number, max: number) => number;
  aid?: number;
  pageId?: number;
  salt?: string;
}

export class Abogus implements AbogusSigner {
  readonly ready = true;
  readonly userAgent: string;
  readonly browserFp: string;

  private readonly options: [number, number, number];
  private readonly now: () => number;
  private readonly randomFloat: () => number;
  private readonly randomInt: (min: number, max: number) => number;
  private readonly aid: number;
  private readonly pageId: number;
  private readonly salt: string;
  private readonly bigArray: number[];

  constructor(opts: AbogusOptions = {}) {
    this.userAgent =
      opts.userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
    this.options = opts.options ?? [0, 1, 14];
    this.now = opts.now ?? (() => Date.now());
    this.randomFloat = opts.randomFloat ?? (() => Math.random());
    this.randomInt =
      opts.randomInt ?? ((min, max) => min + Math.floor(Math.random() * (max - min + 1)));
    this.aid = opts.aid ?? 6383;
    this.pageId = opts.pageId ?? 0;
    this.salt = opts.salt ?? "cus";
    this.bigArray = [...BIG_ARRAY];
    this.browserFp = opts.fp || this.generateFingerprint("Win32");
  }

  // ---------- SM3 ----------
  private sm3ToArray(input: string | number[]): number[] {
    const bytes =
      typeof input === "string" ? Array.from(Buffer.from(input, "utf8")) : input;
    const hex = smCrypto.sm3(bytes);
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  private paramsToArray(param: string | number[], addSalt = true): number[] {
    const processed = typeof param === "string" && addSalt ? param + this.salt : param;
    return this.sm3ToArray(processed);
  }

  // ---------- 自訂位元組置換（stateful，與 Python 版同一個 big_array 演算法）----------
  private transformBytes(bytesList: number[]): string {
    const arr = this.bigArray;
    const chars = bytesList.map((c) => String.fromCharCode(c)).join("");
    const result: number[] = [];
    let indexB = arr[1]!;
    let initialValue = 0;
    let valueE = 0;
    let sumInitial = 0;

    for (let index = 0; index < chars.length; index++) {
      if (index === 0) {
        initialValue = arr[indexB]!;
        sumInitial = indexB + initialValue;
        arr[1] = initialValue;
        arr[indexB] = indexB;
      } else {
        sumInitial = initialValue + valueE;
      }
      const charValue = chars.charCodeAt(index);
      sumInitial %= arr.length;
      const valueF = arr[sumInitial]!;
      result.push(charValue ^ valueF);
      valueE = arr[(index + 2) % arr.length]!;
      sumInitial = (indexB + valueE) % arr.length;
      initialValue = arr[sumInitial]!;
      arr[sumInitial] = arr[(index + 2) % arr.length]!;
      arr[(index + 2) % arr.length] = initialValue;
      indexB = sumInitial;
    }
    return codePointsToString(result);
  }

  // ---------- 自訂 base64 ----------
  private base64Encode(input: string, selectedAlphabet = 0): string {
    const alphabet = CHARACTER_LIST[selectedAlphabet]!;
    let binary = "";
    for (const ch of input) {
      binary += (ch.codePointAt(0) ?? 0).toString(2).padStart(8, "0");
    }
    const paddingLength = (6 - (binary.length % 6)) % 6;
    binary += "0".repeat(paddingLength);
    let out = "";
    for (let i = 0; i < binary.length; i += 6) {
      const idx = parseInt(binary.slice(i, i + 6), 2);
      out += alphabet[idx]!;
    }
    out += "=".repeat(Math.floor(paddingLength / 2));
    return out;
  }

  private abogusEncode(input: string, selectedAlphabet: number): string {
    const alphabet = CHARACTER_LIST[selectedAlphabet]!;
    const out: string[] = [];
    const codes = toCodePoints(input);
    for (let i = 0; i < codes.length; i += 3) {
      let n: number;
      if (i + 2 < codes.length) {
        n = (codes[i]! << 16) | (codes[i + 1]! << 8) | codes[i + 2]!;
      } else if (i + 1 < codes.length) {
        n = (codes[i]! << 16) | (codes[i + 1]! << 8);
      } else {
        n = codes[i]! << 16;
      }
      const masks: [number, number][] = [
        [18, 16515072],
        [12, 258048],
        [6, 4032],
        [0, 63],
      ];
      for (const [j, k] of masks) {
        if (j === 6 && i + 1 >= codes.length) break;
        if (j === 0 && i + 2 >= codes.length) break;
        out.push(alphabet[(n & k) >> j]!);
      }
    }
    out.push("=".repeat((4 - (out.length % 4)) % 4));
    return out.join("");
  }

  // ---------- RC4 ----------
  private rc4Encrypt(key: Buffer, plaintext: string): Buffer {
    const S = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i]! + key[i % key.length]!) % 256;
      const tmp = S[i]!;
      S[i] = S[j]!;
      S[j] = tmp;
    }
    let i = 0;
    j = 0;
    const out: number[] = [];
    for (const ch of plaintext) {
      i = (i + 1) % 256;
      j = (j + S[i]!) % 256;
      const tmp = S[i]!;
      S[i] = S[j]!;
      S[j] = tmp;
      const K = S[(S[i]! + S[j]!) % 256]!;
      out.push((ch.codePointAt(0) ?? 0) ^ K);
    }
    return Buffer.from(out);
  }

  /** 3 組偽隨機 4-byte 序列（共 length×4 個字元） */
  private generateRandomBytes(length = 3): string {
    const seq = (): number[] => {
      const rd = Math.floor(this.randomFloat() * 10000);
      return [
        ((rd & 255) & 170) | 1,
        ((rd & 255) & 85) | 2,
        ((rd >>> 8) & 170) | 5,
        ((rd >>> 8) & 85) | 40,
      ];
    };
    const out: number[] = [];
    for (let i = 0; i < length; i++) out.push(...seq());
    return codePointsToString(out);
  }

  private generateFingerprint(platform: string): string {
    const innerWidth = this.randomInt(1024, 1920);
    const innerHeight = this.randomInt(768, 1080);
    const outerWidth = innerWidth + this.randomInt(24, 32);
    const outerHeight = innerHeight + this.randomInt(75, 90);
    const screenY = this.randomInt(0, 1) === 0 ? 0 : 30;
    const sizeWidth = this.randomInt(1024, 1920);
    const sizeHeight = this.randomInt(768, 1080);
    const availWidth = this.randomInt(1280, 1920);
    const availHeight = this.randomInt(800, 1080);
    return [
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      0,
      screenY,
      0,
      0,
      sizeWidth,
      sizeHeight,
      availWidth,
      availHeight,
      innerWidth,
      innerHeight,
      24,
      24,
      platform,
    ].join("|");
  }

  // ---------- 對外 ----------
  /** 產生 a_bogus（回傳已 URL-encode 的值，可直接接在 query string） */
  generate(params: string, body = ""): SignerResult {
    const abDir = new Map<number, number>([
      [8, 3],
      [18, 44],
      [66, 0],
      [69, 0],
      [70, 0],
      [71, 0],
    ]);

    const startEncryption = Math.floor(this.now());
    const array1 = this.paramsToArray(this.paramsToArray(params));
    const array2 = this.paramsToArray(this.paramsToArray(body));
    // Python: to_ord_str(rc4_encrypt(...)) = 每個位元組轉成一個 char
    const uaEncoded = this.base64Encode(
      this.rc4Encrypt(UA_KEY, this.userAgent).toString("latin1"),
      1
    );
    const array3 = this.paramsToArray(uaEncoded, false);
    const endEncryption = Math.floor(this.now());

    abDir.set(20, byteAt(startEncryption, 24));
    abDir.set(21, byteAt(startEncryption, 16));
    abDir.set(22, byteAt(startEncryption, 8));
    abDir.set(23, byteAt(startEncryption, 0));
    abDir.set(24, Math.floor(startEncryption / 2 ** 32));
    abDir.set(25, Math.floor(startEncryption / 2 ** 40));
    abDir.set(26, byteAt(this.options[0], 24));
    abDir.set(27, byteAt(this.options[0], 16));
    abDir.set(28, byteAt(this.options[0], 8));
    abDir.set(29, byteAt(this.options[0], 0));
    abDir.set(30, Math.floor(this.options[1] / 256) % 256);
    abDir.set(31, this.options[1] % 256);
    abDir.set(32, byteAt(this.options[1], 24));
    abDir.set(33, byteAt(this.options[1], 16));
    abDir.set(34, byteAt(this.options[2], 24));
    abDir.set(35, byteAt(this.options[2], 16));
    abDir.set(36, byteAt(this.options[2], 8));
    abDir.set(37, byteAt(this.options[2], 0));
    abDir.set(38, array1[21]!);
    abDir.set(39, array1[22]!);
    abDir.set(40, array2[21]!);
    abDir.set(41, array2[22]!);
    abDir.set(42, array3[23]!);
    abDir.set(43, array3[24]!);
    abDir.set(44, byteAt(endEncryption, 24));
    abDir.set(45, byteAt(endEncryption, 16));
    abDir.set(46, byteAt(endEncryption, 8));
    abDir.set(47, byteAt(endEncryption, 0));
    abDir.set(48, abDir.get(8)!);
    abDir.set(49, Math.floor(endEncryption / 2 ** 32));
    abDir.set(50, Math.floor(endEncryption / 2 ** 40));
    abDir.set(51, byteAt(this.pageId, 24));
    abDir.set(52, byteAt(this.pageId, 16));
    abDir.set(53, byteAt(this.pageId, 8));
    abDir.set(54, byteAt(this.pageId, 0));
    abDir.set(55, this.pageId);
    abDir.set(56, this.aid);
    abDir.set(57, this.aid & 255);
    abDir.set(58, byteAt(this.aid, 8));
    abDir.set(59, byteAt(this.aid, 16));
    abDir.set(60, byteAt(this.aid, 24));
    abDir.set(64, this.browserFp.length);
    abDir.set(65, this.browserFp.length);

    const sortedValues: number[] = SORT_INDEX.map((i) => abDir.get(i) ?? 0);
    const fpArray = toCodePoints(this.browserFp);
    let abXor = ((this.browserFp.length & 255) >> 8) & 255;
    for (let index = 0; index < SORT_INDEX_2.length - 1; index++) {
      if (index === 0) abXor = abDir.get(SORT_INDEX_2[index]!) ?? 0;
      abXor ^= abDir.get(SORT_INDEX_2[index + 1]!) ?? 0;
    }
    sortedValues.push(...fpArray);
    sortedValues.push(abXor);

    const randomPrefix = this.generateRandomBytes();
    const bytesStr = randomPrefix + this.transformBytes(sortedValues);
    const aBogus = this.abogusEncode(bytesStr, 0);
    return { ok: true, aBogus: encodeURIComponent(aBogus), userAgent: this.userAgent };
  }
}

/** 模組層級單例（引擎/路由共用；產生時 random 由 Math.random 提供） */
export const abogusSigner = new Abogus();
