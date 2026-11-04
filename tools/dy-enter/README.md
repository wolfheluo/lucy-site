# ENTER LOG — 抖音進場名單

只做一件事：**記錄誰進過直播間**，並標註「神秘人」與「疑似隱身」。資料寫入獨立 SQLite
（`data/dy-enter.db`），場次永久保留，可從下拉切回舊場次。

## 為什麼獨立一套

與 `dy-monitor` 共用同一個 lucy-site 站體與登入牆，但**自己的 DB、自己的抓取引擎**：
動到這裡不會影響監控台，反之亦然。代價是同一間房若兩邊都開，`im/fetch` 會有兩份輪詢。

## 抓什麼、不抓什麼

| 項目 | 說明 |
|---|---|
| `room/web/enter` | 每 60 秒：取 `room_id`／狀態／主播名（判斷要不要收） |
| `im/fetch` | 每 3 秒：**只留 `WebcastMemberMessage`（進場）**，Chat／Gift 一律丟棄 |
| 寫入 | `entrants`（每人一列）＋ `entries`（每次進場一列） |

`uid` 為空或 `111111`（送禮訊息中被遮蔽的哨兵值）的進場不會入庫——無法識別就沒有意義。

## 標記規則

| 條件 | `mark` | UI |
|---|---|---|
| 暱稱以 `神秘人` 開頭（`神秘人①`、`神秘人五阶`…） | `mystery` | 🔴 神秘人 |
| 暱稱空白或只剩遮蔽符號（`*`、`***`、`·`…） | `suspect_hidden` | 🟡 疑似隱身 |
| 其他 | `''` | 無 |

**已知限制**：`疑似隱身` 是推測（一般用戶清空暱稱也會被標到），UI 一律寫「疑似」。
真正的匿名旗標（protobuf `is_anonymous` / `hide_by_room`）尚未定位，等抓到樣本再補，
屆時只影響標記精準度，不動 schema。

## API（`/api/tools/dy-enter`，全部 requireAuth）

| Method | Path | 說明 |
|---|---|---|
| POST | `/session` | `{url}` → 驗證房間、建立/續接場次並切換 |
| POST | `/session/:sid/select` | 切到既有場次 |
| GET | `/state` | 當前場次摘要＋統計＋最近進場 |
| GET | `/entrants?session_id&mark&limit&offset` | 每人一列（`mark` 可篩 `mystery`／`suspect_hidden`） |
| GET | `/entrants/:uid/entries?session_id` | 該人的進場明細 |
| GET | `/sessions` | 場次清單（永久保留） |
| GET | `/health` | 引擎狀態、cookie、目前場次 |

## 行為細節

- 貼新 URL → 新場次；同房同 `room_id` 且在 3 分鐘內 → 續接同一場
- 貼上時房間已下播 → 場次立即結案（`ended_at`），下拉不會顯示「進行中」
- 房間中途下播 → 場次結案；重新開播（`room_id` 變）→ 自動開新場次
- `room_id` 每場直播都不同，所以不能快取

## 驗證方式

沙箱的 `better-sqlite3` 有 ABI 問題（segfault），整合測試改在 VPS 用**部署後的 dist-server** 跑：

```bash
ssh ubuntu@<vps> 'cd /www/wwwroot/lucy-site && sudo -u www env PATH=<node> node /tmp/enter_check.mjs'
```

涵蓋：標記判定、uid 去重（visits）、統計、`mark` 篩選、明細、登入牆 401。
