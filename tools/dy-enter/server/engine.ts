// =====================================================================
//  dy-enter 抓取引擎（只做進場）
//  · room/enter 每 60 秒：拿 room_id／狀態／主播名（判斷要不要收）
//  · im/fetch 每 3 秒：只留 Member 事件 → entrants/entries
//  · 房間離線 → 場次 ended_at；重新開播 → 新場次（room_id 會變）
// =====================================================================
import { DyClient } from "../../dy-monitor/server/dycore.js";
import type { SessionRow, DyEnterStore, SnapshotLike } from "./store.js";

const ROOM_CHECK_MS = 60_000;
const CHAT_POLL_MS = 3_000;

export interface EnterEngineOptions {
  store: DyEnterStore;
  client: DyClient;
  log?: (m: string) => void;
}

export class EnterEngine {
  private store: DyEnterStore;
  private client: DyClient;
  private log: (m: string) => void;

  /** 目前正在記錄的場次 */
  currentSessionId: number | null = null;
  /** 目前場次是否直播中 */
  live = false;
  /** 最後一次 room/enter 的快照 */
  snapshot: SnapshotLike | null = null;
  lastError = "";
  lastRoomCheck = 0;
  chatOk = false;
  /** 因 uid 被遮蔽（111111/空）而無法識別的訊息數（送禮常見） */
  maskedDropped = 0;
  /** 使用者手動停止：true 時不輪詢、不寫入（場次已結案） */
  paused = false;
  private cursor = "";
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(opts: EnterEngineOptions) {
    this.store = opts.store;
    this.client = opts.client;
    this.log = opts.log ?? (() => {});

    // 重啟後沿用「已暫停」狀態（使用者按過停止 → 不要自己恢復記錄）
    if (this.store.getSetting("paused", "0") === "1") this.paused = true;

    // 重啟後接回最後一場（若還沒結束）
    const saved = Number(this.store.getSetting("current_session_id", "0")) || 0;
    if (saved) {
      const row = this.store.session(saved);
      if (row && row.ended_at === null) {
        this.currentSessionId = row.id;
        this.log(`[dy-enter] 續接場次 #${row.id}（${row.web_rid}）`);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHAT_POLL_MS);
    this.log("[dy-enter] 引擎啟動");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 使用者按「停止記錄」：只停止輪詢（場次保持開啟，資料不中斷） */
  stopRecording(): { ok: boolean; session_id?: number } {
    const sid = this.currentSessionId;
    if (!sid) return { ok: false };
    this.paused = true;
    this.store.setSetting("paused", "1");
    this.log(`[dy-enter] 場次 #${sid} 暫停記錄（場次保持開啟）`);
    return { ok: true, session_id: sid };
  }

  /** 使用者按「繼續記錄」：同一場次續錄；若場次已結案則在同一間房開新場 */
  async resumeRecording(sid: number): Promise<{ ok: boolean; session?: SessionRow; error?: string }> {
    const row = this.store.session(sid);
    if (!row) return { ok: false, error: "場次不存在" };
    if (row.ended_at !== null) return this.selectRoom(row.web_rid); // 已結案 → 新場次
    this.currentSessionId = row.id;
    this.paused = false;
    this.store.setSetting("paused", "0");
    this.lastRoomCheck = 0; // 立刻校正狀態（不重設 cursor，避免重複計次）
    this.log(`[dy-enter] 場次 #${row.id} 繼續記錄`);
    return { ok: true, session: row };
  }

  /** 貼 URL → 驗證房間、建立/續接場次、切換為當前場次 */
  async selectRoom(webRid: string): Promise<{ ok: boolean; session?: SessionRow; error?: string }> {
    let snap: SnapshotLike | null = null;
    try {
      snap = (await this.client.roomSnapshot(webRid)) as SnapshotLike | null;
    } catch (e) {
      return { ok: false, error: `房間查詢失敗：${(e as Error).message}` };
    }
    if (!snap) return { ok: false, error: "抓不到這個直播間（號碼錯或房間不存在）" };

    const { session } = this.store.ensureSession(snap);
    // 貼上時房間就已下播 → 場次立即結案（避免下拉選單顯示「進行中」卻永遠沒有資料）
    if (snap.status !== 2) this.store.endSession(session.id);
    const row = this.store.session(session.id) ?? session;
    this.currentSessionId = row.id;
    this.snapshot = snap;
    this.live = snap.status === 2;
    this.paused = false;
    this.store.setSetting("paused", "0");
    this.cursor = ""; // 新場次從頭收
    this.lastRoomCheck = Date.now();
    this.store.setSetting("current_session_id", String(row.id));
    this.store.setSetting("selected_web_rid", webRid);
    this.log(`[dy-enter] 場次 #${row.id}（${webRid}／${row.anchor_name ?? "?"}／${this.live ? "直播中" : "已下播"}）`);
    return { ok: true, session: row };
  }

  /** 切到既有場次（下拉選單） */
  selectSession(id: number): boolean {
    const row = this.store.session(id);
    if (!row) return false;
    this.currentSessionId = row.id;
    this.snapshot = {
      web_rid: row.web_rid,
      room_id: row.room_id ?? undefined,
      anchor_name: row.anchor_name ?? undefined,
      title: row.title ?? undefined,
      status: row.ended_at === null ? 2 : 4,
    };
    this.live = row.ended_at === null;
    this.cursor = "";
    this.lastRoomCheck = 0; // 下一輪立刻校正狀態
    this.store.setSetting("current_session_id", String(row.id));
    this.store.setSetting("selected_web_rid", row.web_rid);
    return true;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sid = this.currentSessionId;
      if (!sid || this.paused) return;
      const session = this.store.session(sid);
      if (!session) return;

      // 1) 定期校正房間狀態（60 秒）
      if (Date.now() - this.lastRoomCheck > ROOM_CHECK_MS) {
        this.lastRoomCheck = Date.now();
        try {
          const snap = (await this.client.roomSnapshot(session.web_rid)) as SnapshotLike | null;
          if (snap) {
            this.snapshot = snap;
            this.store.touchSession(sid, {
              room_id: snap.room_id,
              anchor_name: snap.anchor_name,
              title: snap.title,
            });
            const wasLive = this.live;
            this.live = snap.status === 2;

            if (this.live && snap.room_id && snap.room_id !== session.room_id) {
              // 重新開播（room_id 變了）→ 開新場次
              const { session: fresh, created } = this.store.ensureSession(snap);
              if (created) {
                this.currentSessionId = fresh.id;
                this.store.setSetting("current_session_id", String(fresh.id));
                this.cursor = "";
                this.log(`[dy-enter] 重新開播 → 新場次 #${fresh.id}`);
              }
            } else if (!this.live && wasLive) {
              this.store.endSession(sid);
              this.log(`[dy-enter] 場次 #${sid} 結束（已下播）`);
            }
          }
        } catch (e) {
          this.lastError = `房間查詢失敗：${(e as Error).message}`;
        }
      }

      // 2) 只在直播中抓進場
      const cur = this.currentSessionId;
      if (!this.live || !cur) return;
      const row = this.store.session(cur);
      if (!row?.room_id) return;

      try {
        const { messages, cursor } = await this.client.fetchChat(row.room_id, this.cursor);
        this.chatOk = true;
        this.lastError = "";
        if (cursor) this.cursor = cursor;
        let enters = 0;
        let chats = 0;
        for (const m of messages) {
          if (m.type === "Member") {
            if (this.store.addEntry(cur, m)) enters += 1;
            else this.maskedDropped += 1;
          } else if (m.type === "Chat") {
            if (this.store.addChat(cur, m)) chats += 1;
            else this.maskedDropped += 1;
          }
        }
        if (enters || chats) {
          this.log(
            `[dy-enter] #${cur} 進場 +${enters}｜發言 +${chats}` +
              (this.maskedDropped ? `｜遮蔽丟棄 ${this.maskedDropped}` : "")
          );
        }
      } catch (e) {
        this.chatOk = false;
        this.lastError = `事件流失敗：${(e as Error).message}`;
      }
    } finally {
      this.busy = false;
    }
  }

  /** 給 API 的即時摘要 */
  state(recentLimit = 20) {
    const sid = this.currentSessionId;
    if (!sid) {
      return {
        session: null,
        live: false,
        paused: this.paused,
        stats: null,
        recent: [],
        last_error: this.lastError,
      };
    }
    const session = this.store.session(sid) ?? null;
    return {
      session,
      live: this.live,
      stats: this.store.stats(sid),
      recent: this.store.recent(sid, recentLimit),
      paused: this.paused,
      last_error: this.lastError,
      chat_ok: this.chatOk,
      masked_dropped: this.maskedDropped,
    };
  }
}
