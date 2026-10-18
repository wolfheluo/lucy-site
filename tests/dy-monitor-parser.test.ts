// =====================================================================
//  dy-monitor protobuf 解析測試
//  ① 合成封包：覆蓋 Chat / Gift / Member / Like、暱稱保底、gzip、cursor
//  ② 真實封包 fixtures（.dy-fixtures/，不入 git）：與 Python decode_im 逐筆對照
// =====================================================================
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { decodeIm, readFields, readVarint } from "../tools/dy-monitor/server/parser.js";

// ---------- 合成 protobuf 工具 ----------
function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 128) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
function vint(fn: number, value: number): Buffer {
  return Buffer.concat([varint(fn * 8), varint(value)]);
}
function ld(fn: number, payload: Buffer | string): Buffer {
  const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return Buffer.concat([varint(fn * 8 + 2), varint(buf.length), buf]);
}

function wrapMessage(method: string, payload: Buffer, msgId: string): Buffer {
  return ld(1, Buffer.concat([ld(1, method), ld(2, payload), ld(4, msgId)]));
}
function imResponse(messages: Buffer[], cursor: string): Buffer {
  return Buffer.concat([...messages, ld(2, cursor)]);
}
const userBlob = (nick: string) => Buffer.concat([vint(1, 12345), ld(3, nick)]);

describe("readVarint / readFields", () => {
  it("解析多 byte varint 與三種 wire type", () => {
    expect(readVarint(Buffer.from([0x96, 0x01]), 0)).toEqual([150, 2]);
    const buf = Buffer.concat([vint(2, 777), ld(3, "hi"), Buffer.from([0x2d, 1, 2, 3, 4])]);
    const fields = readFields(buf);
    expect(fields[0]).toMatchObject({ fn: 2, wt: 0, value: 777 });
    expect(fields[1].fn).toBe(3);
    expect(fields[1].wt).toBe(2);
    expect((fields[1].value as Buffer).toString()).toBe("hi");
    expect(fields[2]).toMatchObject({ fn: 5, wt: 5 });
  });

  it("壞掉的長度不拋錯，只停止解析", () => {
    const broken = Buffer.concat([varint(3 * 8 + 2), varint(999), Buffer.from("ab")]);
    expect(() => readFields(broken)).not.toThrow();
    expect(readFields(broken).length).toBe(1);
  });
});

describe("decodeIm 合成封包", () => {
  const fixedNow = () => 1_700_000_000;

  it("Chat：取 method/內容/暱稱/msg_id/cursor", () => {
    const payload = Buffer.concat([ld(2, userBlob("小明")), ld(3, "主播好")]);
    const body = imResponse([wrapMessage("WebcastChatMessage", payload, "m-1")], "cur-1");
    const { messages, cursor } = decodeIm(body, fixedNow);
    expect(cursor).toBe("cur-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "Chat",
      nickname: "小明",
      content: "主播好",
      msg_id: "m-1",
      gift_id: 0,
      repeat: 0,
      ts: 1_700_000_000,
    });
  });

  it("Gift：gift_id / repeat / GiftStruct 的 name(16)", () => {
    const giftStruct = Buffer.concat([ld(16, "小心心"), ld(2, "送出小心心")]);
    const payload = Buffer.concat([
      vint(2, 999),
      vint(5, 3),
      ld(15, giftStruct),
      ld(7, userBlob("大哥")),
    ]);
    const body = imResponse([wrapMessage("WebcastGiftMessage", payload, "g-1")], "c");
    const msg = decodeIm(body, fixedNow).messages[0]!;
    expect(msg).toMatchObject({
      type: "Gift",
      gift_id: 999,
      repeat: 3,
      gift_name: "小心心",
      nickname: "大哥",
    });
  });

  it("Member / Like：各自的 user 欄位（2 / 5）", () => {
    const member = wrapMessage(
      "WebcastMemberMessage",
      Buffer.concat([ld(2, userBlob("新觀眾")), ld(3, "來了")]),
      "mb-1"
    );
    const like = wrapMessage(
      "WebcastLikeMessage",
      Buffer.concat([ld(5, userBlob("點讚手")), vint(4, 10)]),
      "lk-1"
    );
    const { messages } = decodeIm(imResponse([member, like], "c"), fixedNow);
    expect(messages.map((m) => m.type)).toEqual(["Member", "Like"]);
    expect(messages[0]!.nickname).toBe("新觀眾");
    expect(messages[1]!.nickname).toBe("點讚手");
  });

  it("未知 method 直接略過", () => {
    const other = wrapMessage("WebcastRoomStatsMessage", ld(1, "x"), "x");
    expect(decodeIm(imResponse([other], "c"), fixedNow).messages).toHaveLength(0);
  });

  it("暱稱保底：主欄位沒有、掃其他區塊仍能取到", () => {
    const payload = Buffer.concat([
      ld(8, userBlob("保底暱稱")), // 不是 Chat 的 user 欄位(2)
      ld(3, "hi"),
    ]);
    const body = imResponse([wrapMessage("WebcastChatMessage", payload, "m")], "c");
    expect(decodeIm(body, fixedNow).messages[0]!.nickname).toBe("保底暱稱");
  });

  it("gzip 封包（首 byte 0x1f）會先解壓", () => {
    const payload = Buffer.concat([ld(2, userBlob("壓縮")), ld(3, "gzip")]);
    const raw = imResponse([wrapMessage("WebcastChatMessage", payload, "z")], "cz");
    const gz = gzipSync(raw);
    expect(gz[0]).toBe(0x1f);
    const { messages } = decodeIm(gz, fixedNow);
    expect(messages[0]!.nickname).toBe("壓縮");
    expect(messages[0]!.content).toBe("gzip");
  });

  it("gzip 壞掉回空結果而不是拋錯", () => {
    const bad = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]);
    expect(decodeIm(bad, fixedNow)).toEqual({ messages: [], cursor: null });
  });
});

// ---------- 真實封包對照（fixtures 不進 git）----------
const FIXTURE_DIR = path.resolve(fileURLToPath(new URL("../.dy-fixtures", import.meta.url)));
const hasFixtures = existsSync(path.join(FIXTURE_DIR, "im-1.bin"));

describe.skipIf(!hasFixtures)("decodeIm vs Python 真實封包", () => {
  for (const n of [1, 2]) {
    it(`im-${n}.bin 逐筆等於 Python decode_im 結果`, () => {
      const raw = readFileSync(path.join(FIXTURE_DIR, `im-${n}.bin`));
      const expected = JSON.parse(
        readFileSync(path.join(FIXTURE_DIR, `im-${n}.expected.json`), "utf8")
      ) as Record<string, unknown>[];

      const { messages } = decodeIm(raw, () => 0);
      // 只比對 Python 端會輸出的欄位（ts 由注入時間決定）
      const actual = messages.map((m) => ({
        type: m.type,
        nickname: m.nickname,
        content: m.content,
        gift_id: m.gift_id,
        repeat: m.repeat,
        gift_name: m.gift_name,
        msg_id: m.msg_id,
      }));
      const want = expected.map((m) => ({
        type: m.type,
        nickname: m.nickname,
        content: m.content,
        gift_id: m.gift_id,
        repeat: m.repeat,
        gift_name: m.gift_name,
        msg_id: m.msg_id,
      }));
      expect(actual.length).toBe(want.length);
      expect(actual).toEqual(want);
    });
  }
});
