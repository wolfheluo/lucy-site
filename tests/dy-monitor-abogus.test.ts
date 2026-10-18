// =====================================================================
//  a_bogus 簽名 parity 測試（對照 Python 版 abogus.py 的固定輸入輸出）
//  固定：fp / UA / params / body / 時間序列 / random 序列
//  比對：SM3、自訂 base64、RC4、transform_bytes、array1~3、最終 a_bogus
//  fixtures 含第三方 UA/指紋字串，放在 gitignored 的 .dy-fixtures/
// =====================================================================
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Abogus } from "../tools/dy-monitor/server/abogus.js";

const FIXTURE = path.resolve(
  fileURLToPath(new URL("../.dy-fixtures", import.meta.url)),
  "abogus-expected.json"
);
const has = existsSync(FIXTURE);
const data = has
  ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      fp: string;
      userAgent: string;
      params: string;
      body: string;
      sm3_abc: number[];
      base64_hello_alphabet0: string;
      base64_hello_alphabet1: string;
      rc4_ua_hex: string;
      transform_input: number[];
      transform_out_hex: string;
      ua_b64: string;
      array1: number[];
      array2: number[];
      array3: number[];
      final_abogus: string;
      final_params: string;
    })
  : null;

/** 取用私有方法做中間產物比對（僅測試使用） */
interface Internals {
  sm3ToArray(input: string | number[]): number[];
  base64Encode(input: string, idx?: number): string;
  rc4Encrypt(key: Buffer, text: string): Buffer;
  transformBytes(bytes: number[]): string;
  paramsToArray(param: string | number[], addSalt?: boolean): number[];
}
const internals = (a: Abogus) => a as unknown as Internals;

function fixedSequence(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}

function fixedTime(values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe.skipIf(!has)("a_bogus parity（Python 版固定輸入）", () => {
  it("SM3 / 自訂 base64 / RC4 與 Python 相同", () => {
    const a = new Abogus({ fp: data!.fp, userAgent: data!.userAgent });
    const I = internals(a);
    expect(I.sm3ToArray("abc")).toEqual(data!.sm3_abc);
    expect(I.base64Encode("hello", 0)).toBe(data!.base64_hello_alphabet0);
    expect(I.base64Encode("hello", 1)).toBe(data!.base64_hello_alphabet1);
    expect(I.rc4Encrypt(Buffer.from([0, 1, 14]), data!.userAgent).toString("hex")).toBe(
      data!.rc4_ua_hex
    );
  });

  it("transform_bytes 逐位元組相同（含 big_array 狀態變化）", () => {
    const a = new Abogus({ fp: data!.fp, userAgent: data!.userAgent });
    const out = internals(a).transformBytes(data!.transform_input);
    expect(Buffer.from(out, "latin1").toString("hex")).toBe(data!.transform_out_hex);
  });

  it("array1 / array2 / array3（SM3 二次雜湊 + UA 編碼）相同", () => {
    const a = new Abogus({ fp: data!.fp, userAgent: data!.userAgent });
    const I = internals(a);
    const array1 = I.paramsToArray(I.paramsToArray(data!.params));
    const array2 = I.paramsToArray(I.paramsToArray(data!.body));
    const uaB64 = I.base64Encode(
      I.rc4Encrypt(Buffer.from([0, 1, 14]), data!.userAgent).toString("latin1"),
      1
    );
    const array3 = I.paramsToArray(uaB64, false);
    expect(uaB64).toBe(data!.ua_b64);
    expect(array1).toEqual(data!.array1);
    expect(array2).toEqual(data!.array2);
    expect(array3).toEqual(data!.array3);
  });

  it("最終 a_bogus 與 Python 完全相同（固定時間與隨機序列）", () => {
    const a = new Abogus({
      fp: data!.fp,
      userAgent: data!.userAgent,
      now: fixedTime([1700000000123, 1700000000456]),
      randomFloat: fixedSequence([0.1234, 0.5678, 0.9012]),
    });
    const res = a.generate(data!.params, data!.body);
    expect(res.ok).toBe(true);
    expect(decodeURIComponent(res.aBogus!)).toBe(data!.final_abogus);
  });
});

describe("a_bogus 基本行為", () => {
  it("ready=true、長度合理、可重複產生且每次不同（隨機前綴）", () => {
    const a = new Abogus();
    expect(a.ready).toBe(true);
    const first = a.generate("aid=6383&room_id=1").aBogus!;
    const second = a.generate("aid=6383&room_id=1").aBogus!;
    const raw = decodeURIComponent(first);
    expect(raw.length).toBeGreaterThan(40);
    expect(raw).toMatch(/^[A-Za-z0-9/+=-]+$/);
    expect(first).not.toBe(second);
  });

  it("params 不同 → 簽名不同", () => {
    const a = new Abogus({ fp: "1024|768|1056|843|0|0|0|0|1024|768|1280|800|1024|768|24|24|Win32" });
    const one = decodeURIComponent(a.generate("a=1").aBogus!);
    const two = decodeURIComponent(a.generate("a=2").aBogus!);
    expect(one).not.toBe(two);
  });

  it("輸出可直接放進 query string（只含 URL-safe 或已編碼字元）", () => {
    const a = new Abogus();
    const enc = a.generate("a=1&b=2").aBogus!;
    expect(enc).not.toMatch(/[^A-Za-z0-9%._~-]/);
  });
});
