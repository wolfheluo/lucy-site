// =====================================================================
//  a_bogus 簽名回歸：同一個 signer 連續簽名必須與「全新 signer」一致
//  （置換表若被就地污染，第二次之後的簽名會失效——舊版觀眾榜的 bug）
// =====================================================================
import { describe, it, expect } from "vitest";
import { Abogus } from "../tools/douyin/server/abogus.js";

const opts = {
  fp: "verify_fp_test",
  now: () => 1_700_000_000_000,
  randomFloat: () => 0.42,
  randomInt: (min: number) => min,
  aid: 6383,
};

describe("a_bogus 可重複簽名", () => {
  it("同一實例連簽兩次 = 全新實例簽一次", () => {
    const params = "aid=6383&web_rid=51237083464&enter_from=web_live";
    const repeated = new Abogus(opts);
    const first = repeated.generate(params);
    const second = repeated.generate(params);
    const fresh = new Abogus(opts).generate(params);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.aBogus).toBe(fresh.aBogus);
    expect(first.aBogus).toBe(fresh.aBogus);
  });

  it("連簽 5 次都成功且每次都與新實例一致", () => {
    const params = "aid=6383&room_id=1";
    const signer = new Abogus(opts);
    for (let i = 0; i < 5; i++) {
      const s = signer.generate(params);
      expect(s.ok).toBe(true);
      expect(s.aBogus).toBe(new Abogus(opts).generate(params).aBogus);
    }
  });
});
