# DOUYIN — 合併設計（dy-monitor × dy-enter）

> 狀態：設計定案 v3（2026-11），尚未實作
> 範圍：把 `tools/dy-monitor` 與 `tools/dy-enter` 合併成單一 tool `tools/douyin`
> 前端入口：`/tools/douyin`（三分頁）
>
> v2 增補：`profiles` 跨場快取、名單納入送禮者（`entrants.diamonds`）、名單 CSV、
> 起步 3 房＋失敗退避、`Like` 不落庫、先去重再累計、禮物目錄 lazy 補抓、
> 神祕人優先反查佇列。
>
> v3 增補：反查只做神祕人；cookie 熱更新（前端狀態＋貼上 JSON）；所有 live webcast 端點
> 一律先簽 `a_bogus`（實測未簽名的 `room/web/enter` 回空）。

---

## 1. 目的

兩個工具本來就是同一個抖音事件流的兩個視圖，卻各自輪詢、各自開 DB、各自定義場次與身份。合併目標：

1. **一次輪詢同時餵監控與名單**（同房 `im/fetch` 由 35 次/分降到 15 次/分）。
2. **一件事實一份資料**：`events` 為唯一真相，名單是引擎維護的物化表。
3. **一份登入牆、一份 api client、一套 CSS**。
4. 把 `dy-enter` 獨有的能力（反查真名、匿名歸戶、隱身判定）升級成監控台的一等公民。

不在範圍：舊資料搬遷、抖音端點或 `a_bogus` 演算法變更、行動原生 App。

---

## 2. 合併前現況與問題

| 問題 | 證據 | 影響 |
|---|---|---|
| 同一事件兩份真相 | `Member` 同時寫 `dy-monitor.events` 與 `dy-enter.entrants`＋`entries`；`Chat` 同時寫 `events` 與 `messages` | 寫入量、磁碟、對帳成本都加倍 |
| 重複輪詢 | monitor 選中房 4s、enter 3s；同房合計 35 次/分 | 風控風險；enter 不受 monitor `Semaphore(3)` 限制 |
| 場次規則分歧 | monitor：離開 300s 內復播續接、結束 900s 內重開標 `partial=1`；enter：容忍 180s、`room_id` 變即新場 | 同一場直播在兩邊變不同場次 |
| 身份語意混用 | monitor 用 `nickname.startsWith("神秘人")`；enter 另有 `mark`、`anon:`、`hidden_flag` | 同一人被標成不同東西 |
| cluster 守門不對稱 | `NODE_APP_INSTANCE` 只在 `tools/dy-monitor/server/engine.ts:209` | `dy-enter` 在 pm2 cluster 下重複收錄 |
| 測試不對稱 | dy-monitor 8 檔 1,898 行；dy-enter 0 檔 | 重構沒有安全網 |
| 進場次數會重複 | `entries`／`messages` 無 `msg_id` 去重；monitor 的 `events` 有 | 重疊 cursor 時 `visits`／`chat_count` 偏高 |
| 禮物面板虛高 | `pushChat` 在 `seenSet` 去重**之前**累加 `giftTotal`／`gifters`（`engine.ts:540-555`） | 重複投遞時面板與 DB 不一致 |
| 禮物以暱稱聚合 | `gifters` key 是 nickname（`engine.ts:162`） | 同名合併、改名分裂 |
| 簽名器狀態污染 | `abogus.ts` 的 `transformBytes` 就地改寫 `this.bigArray`；同一個 signer 第二次之後的 `a_bogus` 無效 | 觀眾榜只有第一次成功（合併時已修正） |
| 文件與程式漂移 | `tools/dy-enter/README.md:16` 說 Chat 丟棄，`engine.ts:295-297` 實際落庫 | 維運誤判 |
| health 恆真 | `tools/dy-enter/server/router.ts:181` `Boolean(env || true)` | cookie 失效時仍顯示正常 |

另：`dy-enter` 已直接 import `dy-monitor` 的 `dycore.ts` 與 `parseRid`（`tools/dy-enter/server/router.ts:16-17`、`engine.ts:7`、`profile.ts:8`），「獨立一套」只是名義上的。

---

## 3. 已定案決策

| 項目 | 決定 |
|---|---|
| 對外入口 | 單一 `/tools/douyin`，三分頁：直播監控／進場名單／歷史 |
| 舊歷史資料 | **不搬**。新 `data/dy.db` 從空開始；舊 `dy-monitor.db`／`dy-enter.db` 留在磁碟當冷備份，程式不再讀 |
| 事件真相 | `events` 唯一真相；`entrants` 是引擎增量維護的**物化表** |
| DB | 單一 `data/dy.db` |
| 擷取 | 一律全收（Member／Chat／Gift），移除 `capture` 與五個 `cap_*` flags |
| `Like` | **不落庫**；只留記憶體 `inter.like_events`／`likes_per_min` |
| 名單範圍 | 進場、發言、**只有送禮**的人都進名單（`entrants.diamonds`） |
| 真名 | 新增 `profiles` 跨場快取；神祕人首次出現即進優先反查佇列 |
| 反查範圍 | **只查 `mark='mystery'`**；「未見進場」不再反查 |
| Cookie | 前端顯示登入狀態；可貼 Playwright JSON 熱更新，寫入 `DY_COOKIE_FILE` 並立即重載 |
| 簽名 | `room/web/enter`／`gift/list`／`im/fetch`／`ranklist/audience` 一律先簽 `a_bogus`，失敗才退回未簽名；每次簽名使用乾淨置換表 |
| 匯出 | 名單 CSV（Phase 2）；事件 CSV 暫不做 |
| 房間數 | 起步 3 房（`DOUYIN_MAX_TARGETS`，上限 5）；連續失敗自動退避 |
| 開關 | `targets.enabled`（單一房級開關，不是被移除的五個 `cap_*`） |
| 備份 | 每日全庫＋小表 `ATTACH` 匯出；清理可表級 |

---

## 4. 身份模型

原本兩邊各混了一部分，合併後拆成**兩個獨立維度**，並引入 canonical key。

| 維度 | 欄位 | 意義 |
|---|---|---|
| 匿名 | `anonymous` | uid 不可得：原始 uid 為 `""` 或 `111111` |
| 遮蔽 | `mark` | 暱稱不可信：`mystery`（以「神秘人」開頭）／`suspect_hidden`（空白或全遮蔽符號） |

**canonical key 規則**（`events.user_id` 與 `entrants.uid` 共用）：

```
raw_uid = 訊息中的 uid（可能是 ""、"111111" 或真實 uid）
if raw_uid 是 "" 或 "111111":
    alias = display_id || nickname
    if alias 為空: 丟棄（無法識別）
    user_id = "anon:" + alias
    anonymous = 1
    清空 display_id（douXXXXXXXX 是系統佔位號，避免冒充）
else:
    user_id = raw_uid
    anonymous = 0
```

| 情境 | raw_uid | user_id | anonymous | mark |
|---|---|---|---|---|
| 一般用戶 | `123…` | `123…` | 0 | `""` |
| 神祕人（進場／發言） | `123…` | `123…` | 0 | `mystery` |
| 送禮訊息被遮 | `111111` | `anon:dou8…` | 1 | `""`（匿名不重複標隱身） |
| 暱稱全遮蔽 | `123…` | `123…` | 0 | `suspect_hidden` |

保留 `raw_uid` 欄位讓原始長相可追溯，但所有關聯、刪除、去重都以 `user_id` 為準。

**名單建列的時機**：`Member`／`Chat`／`Gift` 三種事件都會建／更新 `entrants` 列。只有送禮的人因此不會消失；他的 `visits` 為 0、`diamonds` 有值，名單上以「禮物」類型呈現。

**已知限制**

- 送禮訊息被遮成 `111111` 時，即使同一人在進場／發言有真實 uid，也**無法把送禮歸戶到真實身份**（上游就是這樣，不是合併造成的）。
- `alias` 若同時缺少抖音號與暱稱，匿名者會撞 key 或無法記錄；沿用現行取捨。
- 「疑似隱身」是啟發式：僅在在線人數 ≤ 300 且開場 ≥ 2 分鐘時判定（`tools/dy-enter/server/engine.ts:20-22`），一般用戶清空暱稱也會被標到，UI 一律寫「疑似」。

---

## 5. 資料模型

單一 `data/dy.db`，WAL、`synchronous=NORMAL`、`busy_timeout=5000`。

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  web_rid           TEXT NOT NULL,
  room_id           TEXT,
  source            TEXT NOT NULL DEFAULT 'app',
  anchor_id         TEXT,
  anchor_name       TEXT,
  title             TEXT,
  started_at        REAL NOT NULL,
  ended_at          REAL,
  last_seen_live_at REAL,
  partial           INTEGER NOT NULL DEFAULT 0,   -- 900s 內復播重開
  likes_start       INTEGER NOT NULL DEFAULT 0,
  likes_end         INTEGER NOT NULL DEFAULT 0,
  peak_viewers      INTEGER NOT NULL DEFAULT 0,
  avg_viewers       REAL    NOT NULL DEFAULT 0,
  total_user        TEXT,
  gift_diamonds     INTEGER NOT NULL DEFAULT 0,
  gift_events       INTEGER NOT NULL DEFAULT 0,
  chat_count        INTEGER NOT NULL DEFAULT 0,
  chat_users        INTEGER NOT NULL DEFAULT 0,
  member_count      INTEGER NOT NULL DEFAULT 0,
  snapshot_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_sessions_rid ON sessions(web_rid, started_at DESC);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  ts         REAL    NOT NULL,
  type       TEXT    NOT NULL,             -- Member | Chat | Gift
  user_id    TEXT    NOT NULL,             -- canonical（可能是 anon:…）
  raw_uid    TEXT,                         -- 原始 uid（""／111111／真實）
  anonymous  INTEGER NOT NULL DEFAULT 0,
  nickname   TEXT,
  display_id TEXT,
  sec_uid    TEXT,
  content    TEXT,
  gift_id    INTEGER,
  gift_name  TEXT,
  repeat     INTEGER,
  diamonds   INTEGER,
  msg_id     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX        ix_events_session_ts   ON events(session_id, ts);
CREATE INDEX        ix_events_session_type ON events(session_id, type);
CREATE INDEX        ix_events_session_user ON events(session_id, user_id, ts);
CREATE UNIQUE INDEX ux_events_msgid        ON events(session_id, msg_id) WHERE msg_id <> '';

CREATE TABLE entrants (
  session_id     INTEGER NOT NULL,
  uid            TEXT    NOT NULL,            -- = events.user_id
  nickname       TEXT,
  display_id     TEXT,
  sec_uid        TEXT,
  mark           TEXT    NOT NULL DEFAULT '', -- '' | mystery | suspect_hidden
  anonymous      INTEGER NOT NULL DEFAULT 0,
  hidden_flag    INTEGER NOT NULL DEFAULT 0,  -- 有發言、無進場（小房間才判）
  first_ts       REAL    NOT NULL,
  last_ts        REAL    NOT NULL,
  visits         INTEGER NOT NULL DEFAULT 0,  -- Member 事件數
  chat_count     INTEGER NOT NULL DEFAULT 0,  -- Chat 事件數
  diamonds       INTEGER NOT NULL DEFAULT 0,  -- Gift 事件累計鑽石
  last_gift_ts   REAL,
  real_nickname  TEXT,
  real_unique_id TEXT,
  real_short_id  TEXT,
  resolved_at    REAL,
  resolve_tries  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, uid)
);
CREATE INDEX ix_entrants_session_last ON entrants(session_id, last_ts DESC);
CREATE INDEX ix_entrants_session_mark ON entrants(session_id, mark);

-- 跨場真名快取：同一個 uid 只查一次（30 天內）
CREATE TABLE profiles (
  uid         TEXT PRIMARY KEY,
  nickname    TEXT,
  unique_id   TEXT,
  short_id    TEXT,
  sec_uid     TEXT,
  followers   INTEGER,
  awemes      INTEGER,
  signature   TEXT,
  resolved_at REAL NOT NULL
);

CREATE TABLE targets (
  web_rid         TEXT PRIMARY KEY,
  label           TEXT,
  anchor_name     TEXT,
  notify_live     INTEGER NOT NULL DEFAULT 1,
  notify_end      INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1,   -- 單一房級開關
  added_at        REAL,
  last_status     INTEGER,
  last_notify_at  REAL,
  last_checked_at REAL
);

CREATE TABLE snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  ts         REAL    NOT NULL,
  status     INTEGER,
  viewers    INTEGER,
  like_count INTEGER,
  total_user TEXT
);
CREATE INDEX ix_snapshots_session_ts ON snapshots(session_id, ts);

CREATE TABLE rank_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  ts         REAL    NOT NULL,
  kind       TEXT    NOT NULL,            -- audience | contribution | fans
  rank       INTEGER,
  nickname   TEXT,
  score      INTEGER,
  level      INTEGER,
  payload    TEXT
);
CREATE INDEX ix_rank_session_kind ON rank_snapshots(session_id, kind, ts);

CREATE TABLE fans_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  ts         REAL    NOT NULL,
  club_name  TEXT,
  fans_name  TEXT,
  active     INTEGER,
  total      INTEGER,
  today_new  INTEGER,
  guard      INTEGER,
  members    TEXT
);
CREATE INDEX ix_fans_session_ts ON fans_snapshots(session_id, ts);

CREATE TABLE gift_catalog (
  gift_id    INTEGER PRIMARY KEY,
  name       TEXT,
  diamond    INTEGER,
  updated_at REAL
);

CREATE TABLE notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      REAL NOT NULL,
  web_rid TEXT,
  kind    TEXT,            -- live | end | test
  ok      INTEGER,
  error   TEXT,
  text    TEXT
);
CREATE INDEX ix_notifications_ts ON notifications(ts DESC);
```

### 5.1 不再存在的東西

| 舊 | 取代 |
|---|---|
| `dy-enter.entries` | `events WHERE type='Member'` |
| `dy-enter.messages` | `events WHERE type='Chat'` |
| `events.extra`（JSON） | `display_id`／`sec_uid` 拉成真欄位 |
| `targets.capture`＋`cap_chat/gift/member/snap/rank` | 一律全收；只留 `targets.enabled` |
| `sessions.flags` | 同上 |

### 5.2 彙總語意

- `sessions.chat_users` 改用 `COUNT(DISTINCT user_id)`（原本用 nickname，同名不同人會少算）。
- `sessions.member_count` = Member 事件數；`entrants.visits` 只計實際入庫的 Member 事件（去重後）。
- `sessions.gift_diamonds` = `SUM(events.diamonds)`；`entrants.diamonds` 同步累計，名單直接讀這個欄位，不從 `rank_snapshots` 反推。
- `rank_snapshots(kind='contribution')` 仍由引擎每 30 秒快照，供即時面板使用；**名單與面板的禮物數字同源**（同一批去重後的 Gift 事件）。
- `sessions` 的彙總在 live 期間每 30 秒、場次結束時重算；事件被刪除後要跟著重算。

### 5.3 禮物價值計算

**現況（dy-monitor）**

1. **目錄**：選中房每次快照時，若記憶體目錄為空或超過 1 小時（`catalogTtl: 3600`），打
   `GET /webcast/gift/list/`（帶 `room_id`＋`anchor_id`）→ `gift_id → {name, diamond_count}`，
   存記憶體與 `gift_catalog` 表。
2. **單則**：`diamonds = diamond_count × repeat`（`repeat` 為連擊數，預設 1）；查不到目錄 → 0 鑽，
   名稱退回訊息自帶的 `gift_name` 或「禮物」。
3. **累計**：`giftTotal += diamonds`、`giftEvents += 1`（訊息數）、
   `gifters[nickname].diamonds += diamonds`、`.count += repeat`。
4. **落庫**：每則 Gift 事件的 `events.diamonds` 記該則總鑽；場次
   `gift_diamonds = SUM(diamonds)`、`gift_events = COUNT(*)`。
5. **貢獻榜**：選中房每 30 秒把 `gifters` top 20 寫 `rank_snapshots(kind='contribution')`。
6. **單位只有鑽石**：全專案沒有任何匯率換算（無 `rate`／`cny`／`rmb` 邏輯）。
   實測 `gift/list` 回 1153 項：嘉年華 30000 鑽、跑車 1200 鑽、抖音1號 10001 鑽。

**現況偏差**

| 偏差 | 原因 |
|---|---|
| 面板總值可能偏高 | 累計在去重前（`engine.ts:540-555`），重複投遞會多算；DB 因唯一索引是準的 |
| 同一人改名／同名合併 | `gifters` key 是 nickname，不是 uid |
| 背景房禮物可能是 0 鑽 | 目錄只對選中房刷新 |
| 粉絲團燈牌計入總值 | `isMutedGift` 只在聊天流隱藏，未從總值扣除 |
| 未知禮物 = 0 鑽 | 目錄缺該 `gift_id`，但仍算 1 次事件 |

**新設計**

- 目錄改成 **lazy 補抓**：任一房（含背景房）遇到未知 `gift_id` → 觸發該房目錄抓取；TTL 1 小時；
  仍寫 `gift_catalog`。
- 累計 key 改 `user_id`；**先去重再累計**，記憶體與 DB 同源。
- `entrants.diamonds` 直接累加；名單、貢獻榜、場次彙總三者一致。
- 只記鑽石，不換算現金。若之後要顯示 TWD／CNY，需明確標示「估算」並提供乘數設定。

---

## 6. 寫入一致性（關鍵）

**單一寫入者**：只有引擎寫 `events` 與 `entrants`；路由只讀（刪除例外）。名單不做查詢投影，避免對上百萬列做 `GROUP BY`。

```ts
// store.ingest(sessionId, messages, opts) —— 每批訊息一次
1. 逐筆計算 canonical user_id（§4），無法識別者丟棄
2. 以 msg_id 先做記憶體去重（環形 800 筆），**去重後才累計禮物與 inter 計數**
3. 推入寫入佇列（event op 與對應的 entrant delta 成對）
4. flush（每 2 秒一次 transaction）：
     for each event:
       r = INSERT OR IGNORE INTO events(...)         // 第二層去重（DB 唯一索引）
       if r.changes === 1:
         Member → entrants.visits+1、first/last、mark、hidden_flag
         Chat   → entrants.chat_count+1、last、mark
         Gift   → entrants.diamonds += diamonds、last_gift_ts、last；沒有列就建列
         （nickname／display_id／sec_uid 只以非空值覆蓋）
5. 同一 transaction 內完成，events 與 entrants 不會漂移
```

要點：

- **雙層去重**：記憶體環形負責「同一批內」與重送回包；DB 唯一索引負責跨重啟。
  累計一律在去重之後，修正舊實作面板虛高的問題。
- 佇列上限 200,000 筆，滿了記 log 並丟棄（沿用）。
- `flushNow()` 用於場次結案、刪除前、SIGINT。
- 記憶體 `seen` 集合仍保留給面板顯示去重（`SEEN_MAX=800`）。

---

## 7. 引擎

一個 `DyEngine`、一個 `DyClient`、一個 `Semaphore(3)`。

### 7.1 生命週期

- 建構時讀 `targets` 與 `meta.selected_web_rid`，接回選中房。
- `NODE_APP_INSTANCE` 不為 `null`／`""`／`"0"` → 不啟動引擎（沿用 monitor 規則）。
- `NODE_ENV=test` 或 `DOUYIN_DISABLE=1` → 不啟動。
- SIGINT／SIGTERM：`engine.stop()` → `store.flushNow()` → `wal_checkpoint(TRUNCATE)`。
- 引擎錯誤只進記憶體環形緩衝（最近 8 筆），不中斷其他房間。

### 7.2 節奏

| 工作 | 對象 | 間隔 |
|---|---|---|
| 房間快照 | 選中房 | 3s（直播）／60s（離線） |
| 彈幕 `im/fetch` | 選中房 | 4s |
| 彈幕 `im/fetch` | 背景房 | 10s（每房，共用 semaphore） |
| 房間狀態 | 背景房 | 60s |
| 資料庫快照 | 選中房／背景房 | 30s／60s |
| 觀眾榜＋親密度 | 選中房／背景房 | 30s／60s |
| 親密度 meta | 選中房 | 60s |
| 禮物目錄 | 任一房（lazy） | TTL 1h；未知 gift_id 觸發 |
| 通知冷卻 | per room | 300s |
| 維運（size／checkpoint／heartbeat） | — | 600s |
| 真名反查 | 優先佇列＋背景 | 佇列即時、全域 1.1s／次、每次最多 4 人 |

### 7.3 場次續接（採用 monitor 規則）

- 同房、同 `room_id`、`last_seen_live_at` 在 300 秒內 → 續接同一場。
- 已結束但 900 秒內同房同 `room_id` 再開 → 重開該場並標 `partial=1`。
- `room_id` 改變 → 舊場結案、開新場。
- 背景房與選中房共用同一場（不再有 `source` 區分）。

### 7.4 房間數與退避

- `DOUYIN_MAX_TARGETS` 預設 **3**（上限 5）；上線觀察一週再考慮放寬。
- 每房連續失敗（快照或 `im/fetch`）→ 間隔倍增（上限 5 分鐘）；成功一次即重置。
  純記憶體狀態，不進 DB。
- 全部房間共用一個 `Semaphore(3)` 限制 `im/fetch` 併發。

### 7.5 通知

- `live`／`end` 只在 `last_status` 變更且超過冷卻時送；`end` 附該房最近一場彙總。
- 未設定 LINE → 仍寫 `notifications(ok=0, error=原因)`。
- 測試推播沿用 `/notify/test`。

### 7.6 神祕人真名的即時性

- **觸發**：`Member`／`Chat` 事件寫入且 `mark='mystery'` → 該 uid 立即進
  「優先反查佇列」，不等背景 tick。「未見進場」不再反查（省 API、避風控）。
- **節流**：全域 1.1 秒一次（`ProfileResolver.waitGap`），每批最多 4 人；佇列長時先做神祕人。
- **快取**：先查 `profiles`（30 天）；命中 → 0 延遲，直接回填 `entrants.real_*`。
- **延遲估算**：事件入庫（≤4 秒）→ 佇列（≤1.1 秒）→ API（1–2 秒）→ 名單輪詢（≤5 秒）
  ＝ 典型 5–10 秒、最壞約 20 秒。
- **做不到**：送禮被遮成 `111111` 且沒有其他事件的神祕人（沒有真實 uid）；cookie 失效或風控；
  對方帳號查無（`status_code≠0`，重試 3 次後放棄）。

### 7.7 真名反查

- `ProfileResolver` 共用同一個 `DyClient` 的 cookie／UA。
- 支援數字 uid、`MS4wLjAB…` sec_uid、自訂抖音號（先走 iesdouyin 換 sec_uid）。
- 30 天 `profiles` 快取、1.1 秒最小間隔、失敗最多 3 次（`resolve_tries`）。
- 成功：寫 `profiles` ＋ 當前場次 `entrants.real_*`、`resolved_at`。
- **只處理 `mark='mystery'`**（`store.unresolvedMystery()`）；`hidden_flag=1` 不在佇列裡。

### 7.8 Cookie 管理（前端可貼上更新）

**檔案**：`DY_COOKIE_FILE`（預設 `~/dy_cookies.json`），格式為 Playwright 匯出的 JSON 陣列
（`[{name, value, domain, expirationDate, ...}]`），也接受 `name=value; ...` 原始 header。

- 啟動時讀檔；`DyClient` 只保存 header 字串，`ProfileResolver` 共用同一個 client。
- **熱更新**：`PUT /cookie` → 驗證 → 原子寫檔（tmp + rename、0600）→ `client.setCookieHeader()`；
  不需要重啟。
- **登入檢查**：`GET https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383`
  （`status_code === 0` 且 `user.uid` 存在才算有效）。啟動時、每 30 分鐘、貼上後各檢查一次。
- **狀態**：`configured`（檔案存在）／`valid`（檢查通過）／`checked_at`／`expires_at`
  （取 `sessionid`／`sid_guard` 的 `expirationDate` 最早者）／`account`（`nickname`、`unique_id`、
  `uid` 只回末四碼）／`last_error`。**任何端點都不回傳 cookie 值或完整 header。**
- **寫入驗證**：JSON 陣列或 header 字串；≤ 256 KB；名稱 `[A-Za-z0-9_-]{1,64}`；
  至少要有 `sessionid` 或 `sessionid_ss`；拒絕控制字元與 `\r\n`。
- **權限**：`PUT /cookie` 走 `requireAuth`，套登入 limiter（5 次／15 分鐘）；不把內容寫進 log。

**簽名器注意**：`Abogus.transformBytes` 會就地改寫置換表，同一個實例連續簽名第二次就會失效（舊版觀眾榜只有第一次成功）。
已改為每次簽名使用 `[...this.bigArray]` 的乾淨副本，並以 `tests/douyin-abogus.test.ts` 鎖住。

**實測（2026-11，台灣 IP）**

| 端點 | 未簽名 | 簽名 | 備註 |
|---|---|---|---|
| `profile/self` | 200 `status_code=0` | — | cookie 有效 |
| `profile/other` | 200 `status_code=0` | — | 神祕人反查可用 |
| `room/web/enter` | **200 空 body** | 200 正常 | **必須簽名** |
| `gift/list` | 200 正常（1153 項） | 200 正常 | 兩種都可 |
| `fansclub/club_user_list` | 200 正常 | 200 正常 | 兩種都可 |
| `ranklist/audience` | 200 空 body | 200 正常 | 必須簽名 |
| `im/fetch` | 200 空 body | 200 空 body | 本機全變體皆空，待 production 驗證 |

因此 `DyClient` 的 live webcast 請求一律「先簽名，失敗再退回未簽名」；`im/fetch` 的
`chat_ok` 要能在 `/health` 看見，不能用「登入有效」推論聊天可用。

---

## 8. HTTP API

全部掛 `/api/tools/douyin`，一律 `requireAuth`；回應格式 `{ ok: true, ... }`／`{ ok: false, error }`。

| Method | Path | 說明 |
|---|---|---|
| GET | `/state?since=` | 選中房即時狀態（快照、曲線、彈幕、榜單、送禮、inter） |
| GET | `/targets` | 監控清單＋狀態 |
| POST | `/targets` | `{url, label?}`；先驗證房間存在；超過上限回 429 |
| PATCH | `/targets/:rid` | `label`／`notify_live`／`notify_end`／`enabled` |
| DELETE | `/targets/:rid` | 移除（選中房不可刪） |
| POST | `/targets/:rid/select` | 切換主畫面 |
| GET | `/entrants?session_id&mark&q&limit&offset` | 名單＋stats；`mark=hidden` 為「未見進場」聯集 |
| GET | `/entrants/export.csv?session_id=` | 名單 CSV（uid／暱稱／抖音號／真名／標記／進場／發言／鑽石／首次／最後） |
| GET | `/entrants/:uid/events?session_id&type&limit&offset` | 某人明細（取代舊 entries／messages 兩支） |
| DELETE | `/entrants/:uid?session_id=` | 刪某人：`events`＋`entrants` 同交易 |
| GET | `/profile/:idOrHandle?session_id=` | 反查真名，成功即回填當前場次與 `profiles` |
| GET | `/cookie` | Cookie 狀態（configured／valid／checked_at／expires_at／account／last_error；**不回傳值**） |
| PUT | `/cookie` | 貼上 Playwright JSON 或 raw header；驗證→原子寫入→熱重載→回狀態 |
| POST | `/cookie/verify` | 只重新檢查，不改檔案 |
| DELETE | `/cookie` | 清除檔案並停用抓取 |
| GET | `/sessions?limit&offset&web_rid` | 場次清單 |
| POST | `/sessions/:sid/stop` | 停止記錄（`targets.enabled=0`，場次保持） |
| POST | `/sessions/:sid/resume` | 繼續記錄 |
| DELETE | `/sessions/:sid` | 刪整場（各表同交易＋checkpoint） |
| GET | `/replay/:rid` | 最近一場有資料的場次回放 |
| GET | `/history/session/:sid` | 歷史詳情（ranks／fans／gift／event_counts／series） |
| GET | `/history/session/:sid/events?type&q&limit&offset` | 歷史事件搜尋 |
| GET | `/notifications?limit=` | 通知紀錄 |
| POST | `/notify/test` | 測試推播 |
| GET | `/health` | running／selected／cookie（**真實判斷**）／abogus／line／db_size_mb／targets／events_age |

舊 `/api/tools/dy-monitor/*`、`/api/tools/dy-enter/*` 直接 404，不做 alias。

CSV 以 `text/csv; charset=utf-8` 回傳，附 UTF-8 BOM（Excel 中文不亂碼）。

---

## 9. 前端

### 9.1 路由

```
/tools/douyin                 直播監控（預設）
/tools/douyin/entrants        進場名單
/tools/douyin/history         歷史列表
/tools/douyin/history/:sid    單場詳情
```

Redirect（`src/App.tsx`）：

```
/tools/dy-monitor            → /tools/douyin
/tools/dy-monitor/history*   → /tools/douyin/history*
/tools/dy-enter              → /tools/douyin/entrants
```

### 9.2 元件

```
client/
  api.ts            一份 req／UnauthorizedError／ApiError／login／me
  DouyinPage.tsx    ToolFrame + 分頁列（Link），依 route 掛 tab
  MonitorTab.tsx    由 DyMonitorPage 拆出（曲線／卡片／彈幕／榜單／抽屜）
  EnterTab.tsx      由 DyEnterPage 拆出（名單／篩選／明細／反查／刪除／CSV）
  HistoryTab.tsx    由 DyHistoryPage + DySessionPage 合併
  douyin.css        `.dy-` 前綴單檔，共用 design token
```

- 輪詢：`/state` 2s、`/entrants` 5s、`/targets` 15s（沿用現值）。
- 登入牆只實作一份（`LockPanel`），置於 `DouyinPage` 外層。
- **Cookie pill**（頂欄）：未設定／有效／已過期／驗證失敗；滑過顯示帳號與到期時間。
- 點 pill 開 modal：textarea 貼上 JSON →「驗證並更新」→ 顯示帳號、到期、錯誤；
  不回顯已存的 cookie。缺 `sessionid`、JSON 壞、>256KB 都在 modal 內擋下，不寫檔。
- 名單欄位含「鑽石」與「真實ID」；反查未完成顯示「反查中…」，完成後原地替換。
- 名單工具列含「匯出 CSV」按鈕（直接開 `/api/tools/douyin/entrants/export.csv?...`）。
- `ToolShell` 的 `LOCKED_TOOLS` 加入 `douyin`（整頁鎖高，分頁內部滾動）。

---

## 10. 刪除、保留、備份

### 10.1 刪除

| 操作 | 交易內容 |
|---|---|
| 刪某人 | `DELETE FROM events WHERE session_id=? AND user_id=?` → `DELETE FROM entrants` → 重算該場彙總 |
| 刪整場 | `events`／`entrants`／`snapshots`／`rank_snapshots`／`fans_snapshots` → `DELETE sessions` → `wal_checkpoint(TRUNCATE)` |

記錄中的場次不可刪（回 409，先 stop）。刪除後 UI 需重抓 stats。

### 10.2 保留

- `SESSION_RETENTION_DAYS`（預設 `0`＝永久）。>0 時每日刪除「結束時間早於 N 天」的**整個場次**（含子表），不做事件級切割，避免場次彙總與回放失真。

### 10.3 備份（SQLite 沒有表級備份）

- 每日全庫線上備份（better-sqlite3 `.backup()`）→ 保留 7 份。
- 另用 `ATTACH` ＋ `INSERT SELECT` 把小表（`sessions`／`entrants`／`profiles`／`targets`／`notifications`）匯出成獨立 `.db`。
- 清理可表級：`DELETE FROM events ...` ＋ `wal_checkpoint(TRUNCATE)`。
- 20GB 警告門檻沿用（`store.checkSize()`）；3 房全收最壞約 300 MB／日。

`scripts/backup-dbs.mjs` 從「三檔輪替」改為「`dy.db` 全庫 ＋ 小表快照」，保留 `vault.db`。

---

## 11. 環境變數、meta、註冊

| 變數 | 說明 |
|---|---|
| `DY_COOKIE_FILE` | 不變 |
| `DY_DASHBOARD_URL` | 不變 |
| `LINE_CHANNEL_ACCESS_TOKEN`／`LINE_TO` | 不變 |
| `DOUYIN_DISABLE` | 新；`1` 停用引擎。舊 `DY_MONITOR_DISABLE`／`DY_ENTER_DISABLE` **只停舊工具**，不影響 douyin |
| `DOUYIN_MAX_TARGETS` | 新；預設 3、上限 5 |
| `SESSION_RETENTION_DAYS` | 新；預設 0（永久） |

```ts
// tools/douyin/meta.ts
export const douyinMeta: ToolMeta = { id: "douyin", title: "DOUYIN LIVE", zhTitle: "抖音直播" };
```

註冊：`server/registry.ts` 加 `{ meta: douyinMeta, register: registerDouyin }`；`src/tools.ts` 加 lazy import 與 `{ meta, Component, projectCard }`。舊 `dy-monitor`／`dy-enter` 兩行在 phase 4 移除。

---

## 12. 退場與回滾

- Phase 1–3：舊工具保持可用，新工具並行；**不要同時把同一間房開在兩邊**（會回到雙輪詢）。上線新工具後以 `DY_MONITOR_DISABLE=1`／`DY_ENTER_DISABLE=1` 停舊引擎，UI 先留著。
- Phase 4：移除舊 tool 目錄、registry、client 註冊、舊 CSS、舊測試，更新 README／`.env.example`／CI。
- 舊 DB 檔不刪，改名或移到 `data/archive/`；確認新工具穩定 N 天後由人工刪除。
- 回滾：`deploy.sh` 切回上一版 release 即可；舊 DB 從未被寫入，資料完整。

---

## 13. 測試策略

新 store／engine 先寫測試（`NODE_ENV=test` 不連網、時鐘可注入），沿用現有慣例。

| 檔案 | 覆蓋 |
|---|---|
| `tests/douyin-store.test.ts` | schema、ingest 去重（重送同 msg_id）、entrants 物化、visits／chat_count／diamonds、markOf、canonical uid、刪除交易、彙總 |
| `tests/douyin-gift.test.ts` | 目錄 lazy 補抓、`diamond × repeat`、未知禮物 0 鑽、去重後才累計、entrants.diamonds 與 events 一致 |
| `tests/douyin-session.test.ts` | 300s 續接、900s 重開 `partial=1`、`room_id` 變更 |
| `tests/douyin-engine.test.ts` | fake client：排程、semaphore、通知冷卻、enabled=0、cluster 守門、退避、stop |
| `tests/douyin-api.test.ts` | 401 牆、targets CRUD、entrants 篩選、CSV BOM、profile、health 真實 cookie |
| `tests/douyin-profile.test.ts` | 數字 uid、handle→sec_uid、`profiles` 快取命中、404、暫時性錯誤不計次、**只反查 mystery** |
| `tests/douyin-cookie.test.ts` | JSON/header 兩種格式、缺 sessionid 拒絕、過大拒絕、原子寫入、熱重載、狀態不回傳值、過期時間解析 |
| 既有 `dy-monitor-parser`／`abogus` | 搬移後改 import 路徑沿用 |

- 增補 `scripts/douyin-ui-check.mjs`：登入牆 → 三分頁 → 名單篩選 → CSV → 手機版面，console 錯誤即失敗。
- e2e 不新增；既有 `tests/e2e` 不受影響（工具頁不在 spec 內）。

---

## 14. 分階段

| 階段 | 內容 | 驗收 |
|---|---|---|
| 1 | `tools/douyin` 骨架：schema、store、engine（monitor 能力＋3 房退避）、meta、registry、`/state`／`targets`／`health` | 新頁面能監控一間房；`npm test`／`lint`／`build` 綠 |
| 2 | `entrants` 物化（含 Gift 建列）＋`profiles`＋優先反查＋名單 API／CSV／分頁 | 名單可篩選／明細／反查／刪除／匯出，數字與 events 對得上 |
| 3 | 歷史分頁（列表／詳情／事件搜尋）、通知抽屜、replay | 與舊 dy-monitor 歷史頁同等功能 |
| 4 | 下線舊工具與文件、備份腳本、CI 冒煙、舊網址 redirect | 舊路由不再存在；README／`.env.example` 更新 |

---

## 15. 風險與限制

1. **磁碟成長**：全收後單房約 104 MB／日；3 房約 300 MB／日。預設不自動清；超過 20GB 只警告。
2. **單引擎是新單點**：所有 client 呼叫都要有 timeout；背景房用 `allSettled`，一間卡住不拖垮其他房。
3. **匿名歸戶的限制**（§4）：被遮的送禮無法接到真實 uid；匿名 key 依賴抖音號／暱稱，可能碰撞。
4. **反查節流**：1.1 秒／次是為了避風控；同時湧入大量神祕人時名單會分批補齊，不是瞬間。
5. **禮物目錄覆蓋率**：lazy 補抓能救背景房，但新禮物、房專屬禮物仍可能短暫以 0 鑽計。
6. **Cookie 熱更新**：貼上後立即生效，但引擎正在飛的請求仍用舊 header，下一輪才用新的；
   驗證失敗不會覆蓋舊檔，避免一次手滑讓抓取全停。
7. **無舊資料**：上線後歷史頁從空開始；舊 DB 僅冷備份，不回填。
8. **`partial` 的意義**：900 秒內復播會把兩段合併成同一場並標 `partial=1`；報表解讀時要看這個旗標。
9. **簽名要求會變**：2026-11 實測 `room/web/enter` 未簽名回空 body（`gift/list`、`fansclub`
   仍可不簽）。設計改成一律先簽名並保留未簽名 fallback，避免端點政策再變時整個工具停擺。
10. **`im/fetch` 尚未驗證**：本機（台灣 IP、新帳號）所有變體都回空；需在 production 或既有
   可用環境確認。若 production 也空，聊天與進場名單會沒有資料，這是合併前必須先確認的事。
11. **簽名器必須無狀態**：`Abogus.transformBytes` 會就地改寫置換表；每次簽名都要用副本，
   否則只有第一次請求成功。已加 `tests/douyin-abogus.test.ts` 鎖住。
12. **房間回空不是網路錯誤**：`room/web/enter` 對已下播／不存在的房回空 body；引擎視為
    「已下播」、改用 60 秒節奏，不做指數退避（避免真的下播後被退避到數十秒）。

---

## 16. v3 已定案／仍開放

已定案：`Like` 不落庫、`targets.enabled`、全庫＋小表備份、名單含送禮者、`profiles` 跨場快取、
名單 CSV、3 房起步＋退避、先去重再累計、禮物目錄 lazy 補抓、**反查只查神祕人**、
**cookie 熱更新與前端狀態**、**live 端點一律先簽名**。

仍開放（不阻塞 Phase 1）：

| # | 問題 | 現況 |
|---|---|---|
| 1 | 禮物價值要不要顯示成 TWD／CNY？ | 目前只有鑽石；要做需加乘數並標「估算」 |
| 2 | 粉絲團燈牌（`粉丝团灯牌`／`点亮粉丝团`）要不要從禮物總值扣除？ | 目前計入，只在聊天流隱藏 |
| 3 | 事件 CSV 匯出？ | 暫不做，等真的要用 |

---

## 17. Phase 1 實作狀態（2026-11）

- 已建立 `tools/douyin/`：`meta.ts`、`types.ts`、`schema.ts`、`store.ts`、`identity.ts`、
  `cookie.ts`、`dycore.ts`、`engine.ts`、`router.ts`、`client/`（api／DouyinPage／douyin.css）。
- 註冊：`server/registry.ts` 已加入；`src/tools.ts` 與 `App.tsx` 已掛 `/tools/douyin`（含分頁路由）。
- 測試：`douyin-store` 17、`douyin-cookie` 15、`douyin-engine` 11、`douyin-api` 13、
  `douyin-abogus` 2（共 58）。
- 實測（真 cookie）：`room/web/enter` 與 `gift/list` 簽名後正常；`profile/self` 與 `profile/other`
  正常；`ranklist/audience` 簽名正常；`im/fetch` 仍回空 → `chat_ok=false`，UI 會明示。
- UI 驗證：登入牆 → 監控（KPI／人數曲線／榜單）→ cookie pill／modal（重新檢查顯示已登入）；
  名單／歷史分頁可載入。
- 尚未做：歷史詳情與回放（Phase 3）、舊工具下線與舊 DB 處理（Phase 4）、`im/fetch` 的
  production 驗證或 `msToken` 對策。
