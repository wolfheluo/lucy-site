# DY-MONITOR — Douyin Live Monitoring Tool

Operational documentation for the `dy-monitor` tool. The tool observes Douyin (TikTok China)
live rooms through the public webcast endpoints, persists every broadcast into a dedicated
SQLite database, and dispatches LINE notifications on live/offline transitions. It is a
TypeScript port of an earlier single-process Flask implementation; the wire semantics,
database layout, and session-continuity rules were preserved verbatim so that historical
data remains interpretable by both implementations.

## 1. Scope and Status

| Phase | Content | Status |
|---|---|---|
| P1 | Core monitoring: room snapshots, chat/gift/member events, watch list, LINE notifications, offline replay, login-walled dashboard | Implemented |
| P2 | `a_bogus` request signing for the online-audience ranking (`/webcast/ranklist/audience/`) | Not implemented (documented seam) |
| P3 | Session history pages and CLI parity | Out of scope for P1 |

The audience ranking is the only feature that requires a signed request. `server/signer.ts`
exposes the interface and returns an explicit `{ ok: false, reason }` result, so the rest of
the engine continues to operate and the interface reports the panel as pending. The ranking
fetch path is skipped entirely while the signer is unavailable, which prevents periodic
failed requests and log noise.

## 2. Architecture

A single Hono process hosts the tool. The engine runs inside that process as self-scheduling
timers, in the same manner as the `binance-api` engine.

```
Hono process
├── /api/tools/dy-monitor/*        (all routes behind requireAuth)
├── DyEngine
│   ├── Monitor (selected room)     snapshot 3 s live / 60 s offline
│   │                               chat 4 s, audience rank 30 s, fans club 60 s
│   └── Warden (all other targets)  status 60 s, capture 10 s (per room)
│                                   background snapshot 60 s, ranking 60 s
└── DyMonitorStore  data/dy-monitor.db (WAL, batched writes every 2 s)
```

Two constraints are enforced in code:

* **Single instance.** The engine starts only when `NODE_APP_INSTANCE` is absent or `"0"`.
  A second cluster worker would otherwise poll the same rooms, duplicate sessions, and send
  duplicate notifications.
* **Bounded concurrency.** `im/fetch` calls share a semaphore of three; the watch list is
  capped at five rooms (`MAX_TARGETS`). The current operational requirement is one to three
  rooms, and each background room costs roughly seven requests per minute.

## 3. Data Model

The database is independent of `vault.db` because event-level storage grows at approximately
104 MB per room per day, which is two orders of magnitude larger than the rest of the site's
data. Tables and columns match the Python implementation:

`sessions`, `events`, `snapshots`, `rank_snapshots`, `fans_snapshots`, `gift_catalog`,
`targets`, `notifications`, `meta`.

Timestamps are stored as floating-point epoch **seconds**, not milliseconds, so imported
historical rows and newly written rows share one representation.

Session continuity rules:

* A session is resumed when the same room is observed live again within `liveTolerance`
  (300 s) of its last live sighting.
* A session closed less than `resumeWindow` (900 s) ago is reopened (`partial = 1`) rather
  than duplicated, so switching the selected room back and forth does not fragment a
  broadcast.
* `events` carries a partial unique index on `(session_id, msg_id)`; duplicate deliveries are
  ignored at the database level.

The five capture flags (`cap_chat`, `cap_gift`, `cap_member`, `cap_snap`, `cap_rank`) control
persistence only. The dashboard always displays full data; `capture` is synchronised by the
server as the OR of the five flags. `sessions.flags` records the configuration in force when
the session was created and is not rewritten afterwards.

## 4. HTTP API

All endpoints require an authenticated admin session (`/api/auth/login`); an unauthenticated
request receives `401`.

| Method | Path | Description |
|---|---|---|
| GET | `/state?since=<cursor>` | Selected room state, viewer series, chat delta, rankings, gift aggregation |
| GET | `/targets` | Watch list joined with current status and `caps_on` |
| POST | `/targets` | `{ url }` — resolves and validates the room before inserting |
| PATCH | `/targets/:rid` | Notification toggles, `capture`, or individual `cap_*` flags |
| DELETE | `/targets/:rid` | Removes a target; the selected room cannot be removed |
| POST | `/targets/:rid/select` | Switches the dashboard to that room |
| GET | `/replay/:rid` | Last session with activity: KPI, series, 120 events, rank, fans, contribution board |
| GET | `/notifications?limit=` | Recent delivery attempts |
| POST | `/notify/test` | Sends a test message and records the outcome |
| GET | `/health` | Engine state, data age, credential presence, database size |

## 5. Configuration

Environment variables (loaded from the site `.env`, owner `root`, mode 600):

| Variable | Purpose |
|---|---|
| `DY_COOKIE_FILE` | Path to the Douyin cookie file (JSON array or raw header), mode 600 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API channel access token |
| `LINE_TO` | Destination user, group, or room identifier |
| `DY_DASHBOARD_URL` | URL appended to notification messages |
| `DY_MONITOR_DISABLE` | `1` disables the engine (maintenance or test runs) |

If the LINE credentials are absent, notifications are still recorded with `ok = 0` and the
reason, so the interface remains testable without a channel.

## 6. Operations

Deployment uses the site's standard `deploy.sh`, which transfers `dist` and `dist-server`
only; `data/` is not part of the artifact set and is therefore never overwritten. The smoke
step additionally verifies that the dy-monitor health endpoint returns `401` without a
session and `200` with one.

Historical data migration from the Python implementation is a one-off operation:

```bash
npx tsx scripts/import-dy-monitor.mjs --from <python monitor.db> --to <ts dy-monitor.db>
```

Daily backups of `vault.db` and `dy-monitor.db` run from `/root/scripts/backup-dbs.mjs` at
04:10 server time, using better-sqlite3's online backup API and retaining seven copies per
database in `/root/backups/lucy-site/`.

Verification utilities:

```bash
node scripts/dy-ui-check.mjs http://127.0.0.1:3001 <password>   # lock screen → dashboard → drawer → mobile
npx vitest run tests/dy-monitor-*.test.ts                       # parser, store, engine, API
```

## 7. Known Limitations

* The audience ranking remains disabled until the `a_bogus` implementation is added.
* `inter` counters are incremented before message de-duplication, matching the Python
  implementation; overlapping cursors can therefore over-count interaction totals while the
  chat queue and database remain de-duplicated.
* Event-level data is retained indefinitely. Storage growth is surfaced in the dashboard and
  in the log; pruning is a manual operation, consistent with the site owner's stated
  preference for monitoring data.
* The upstream endpoints are undocumented and may change without notice. A change to the
  `im/fetch` protobuf layout would require updating `server/parser.ts` and its fixtures.
