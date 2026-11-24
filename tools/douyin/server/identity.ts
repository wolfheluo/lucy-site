// =====================================================================
//  身份判定（純函式，server / client 皆可 import）
//  - canonical uid：uid 被遮成 ""／111111 時改用 anon:<抖音號|暱稱>
//  - mark：'mystery'（神秘人開頭）／'suspect_hidden'（空白或全遮蔽符號）
// =====================================================================
import type { DyMessage, EnterMark, RoomSnapshot } from "../types.js";

/** 抖音在送禮訊息中把 uid 換成的哨兵值 */
export const MASKED_UID = "111111";

/** 暱稱空白或只剩遮蔽符號 → 疑似隱身（推測，UI 一律寫「疑似」） */
export function markOf(nickname: string | null | undefined): EnterMark {
  const n = (nickname ?? "").trim();
  if (!n) return "suspect_hidden";
  if (n.startsWith("神秘人")) return "mystery";
  if (/^[*＊·•\s._-]+$/.test(n)) return "suspect_hidden";
  return "";
}

export interface CanonicalIdentity {
  /** 寫入 events.user_id / entrants.uid 的鍵 */
  uid: string;
  /** 原始 uid（""／111111／真實） */
  rawUid: string;
  anonymous: number;
  /** 匿名者要清掉 douXXXXXXXX 佔位號 */
  displayId: string;
  secUid: string;
  mark: EnterMark;
}

type IdentitySource = Pick<DyMessage, "user_id" | "display_id" | "sec_uid" | "nickname">;

/** 事件 → canonical 身份；無法識別（匿名又沒有別名）回 null（呼叫端應丟棄） */
export function canonicalIdentity(msg: IdentitySource): CanonicalIdentity | null {
  const rawUid = (msg.user_id ?? "").trim();
  const nickname = msg.nickname ?? "";
  const mark = markOf(nickname);
  if (rawUid === "" || rawUid === MASKED_UID) {
    const alias = ((msg.display_id ?? "").trim() || nickname.trim()).trim();
    if (!alias) return null;
    return {
      uid: `anon:${alias}`,
      rawUid,
      anonymous: 1,
      displayId: "",
      secUid: (msg.sec_uid ?? "").trim(),
      // 匿名者不再重複標神秘人／疑似隱身（uid 已不可得，標記沒有行動價值）
      mark: "",
    };
  }
  return {
    uid: rawUid,
    rawUid,
    anonymous: 0,
    displayId: (msg.display_id ?? "").trim(),
    secUid: (msg.sec_uid ?? "").trim(),
    mark,
  };
}

/** 房間快照也能算 canonical 身份（給「只有送禮」以外的來源用） */
export function snapshotIdentity(snap: RoomSnapshot): CanonicalIdentity | null {
  return canonicalIdentity({
    user_id: snap.user_id,
    display_id: snap.display_id,
    nickname: "",
  });
}
