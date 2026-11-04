// =====================================================================
//  DOUYIN ENTER LOG // 抖音進場名單
//   · 頂部貼直播間 URL → 開始記錄（新場次）
//   · 表格：每人一列（UID／抖音號／暱稱／標記／次數／最後進場）
//   · 點列展開該人的進場明細
//   · 篩選：全部 / 只看神秘人 / 只看疑似隱身
//   · 3 秒輪詢 /state；名單 5 秒刷新
// =====================================================================
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  UnauthorizedError,
  enterApi,
  type Entrant,
  type EnterMark,
  type EnterSession,
  type ProfileHit,
  type StatePayload,
} from "./api";
import "./dy-enter.css";

const POLL_STATE_MS = 3000;
const POLL_LIST_MS = 5000;

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("zh-TW");

const clock = (ts: number | null | undefined) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const dateTime = (ts: number | null | undefined) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function DyEnterPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [pwd, setPwd] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState("");

  const [url, setUrl] = useState("");
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");

  const [state, setState] = useState<StatePayload | null>(null);
  const [sessions, setSessions] = useState<EnterSession[]>([]);
  const [filter, setFilter] = useState<EnterMark | "hidden" | "">("");
  const [rows, setRows] = useState<Entrant[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, number[]>>({});
  const [msgs, setMsgs] = useState<Record<string, { ts: number; content: string }[]>>({});
  const [listErr, setListErr] = useState("");
  const [lookupUid, setLookupUid] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupHit, setLookupHit] = useState<ProfileHit | null>(null);

  const sessionId = state?.session?.id ?? 0;
  const sidRef = useRef(0);
  sidRef.current = sessionId;

  // ---------- 登入狀態 ----------
  useEffect(() => {
    void enterApi
      .me()
      .then(setAuthed)
      .catch(() => setAuthed(false));
  }, []);

  // ---------- /state 輪詢 ----------
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await enterApi.state(20);
        if (alive) {
          setState(s);
          setNotice("");
        }
      } catch (e) {
        if (e instanceof UnauthorizedError) setAuthed(false);
        else if (alive) setNotice(e instanceof ApiError ? e.message : "讀取狀態失敗");
      }
    };
    void tick();
    const t = setInterval(tick, POLL_STATE_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [authed]);

  // ---------- 場次清單（切房後重抓） ----------
  const loadSessions = useCallback(async () => {
    try {
      const j = await enterApi.sessions();
      setSessions(j.sessions);
    } catch {
      /* 忽略 */
    }
  }, []);

  useEffect(() => {
    if (authed) void loadSessions();
  }, [authed, loadSessions, sessionId]);

  // ---------- 名單輪詢 ----------
  useEffect(() => {
    if (!authed || !sessionId) {
      setRows([]);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const j = await enterApi.entrants(sessionId, filter || undefined, 800);
        if (!alive) return;
        setRows(j.entrants);
        setListErr("");
      } catch (e) {
        if (e instanceof UnauthorizedError) setAuthed(false);
        else if (alive) setListErr(e instanceof ApiError ? e.message : "讀取名單失敗");
      }
    };
    void tick();
    const t = setInterval(tick, POLL_LIST_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [authed, sessionId, filter]);

  // ---------- 展開明細 ----------
  const toggle = async (uid: string) => {
    if (expanded === uid) {
      setExpanded(null);
      return;
    }
    setExpanded(uid);
    if (sessionId && (!entries[uid] || !msgs[uid])) {
      try {
        const [e1, m1] = await Promise.all([
          entries[uid] ? Promise.resolve(null) : enterApi.entries(uid, sessionId),
          msgs[uid] ? Promise.resolve(null) : enterApi.messages(uid, sessionId),
        ]);
        if (e1) setEntries((prev) => ({ ...prev, [uid]: e1.entries.map((e) => e.ts) }));
        if (m1) setMsgs((prev) => ({ ...prev, [uid]: m1.messages }));
      } catch {
        /* 忽略 */
      }
    }
  };

  /* ---------- 停止／繼續記錄 ---------- */
  const toggleRecording = async () => {
    if (!sessionId) return;
    setStarting(true);
    try {
      if (state?.paused) {
        const j = await enterApi.resume(sessionId);
        setNotice(`已繼續記錄 → 場次 #${j.session.id}`);
        await loadSessions();
      } else {
        await enterApi.stop(sessionId);
        setNotice("已暫停記錄（場次保持開啟，資料保留）");
      }
      const st = await enterApi.state();
      setState(st);
      const j2 = await enterApi.entrants(sessionId, filter || undefined, 800);
      setRows(j2.entrants);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "操作失敗");
    } finally {
      setStarting(false);
    }
  };

  /* ---------- UID 反查暱稱 ---------- */
  const lookup = async (uidArg?: string) => {
    const uid = (uidArg ?? lookupUid).trim();
    if (!/^\d{5,20}$/.test(uid)) {
      setNotice("請輸入純數字的 UID");
      return;
    }
    setLooking(true);
    try {
      const j = await enterApi.profile(uid, sessionId || undefined);
      setLookupHit(j.profile);
      setNotice(
        `UID ${uid} → ${j.profile.nickname}` +
          (j.profile.uniqueId ? `（抖音號 ${j.profile.uniqueId}）` : "") +
          `｜粉絲 ${j.profile.followers}`
      );
      if (sessionId) {
        const j2 = await enterApi.entrants(sessionId, filter || undefined, 800);
        setRows(j2.entrants);
      }
    } catch (err) {
      setLookupHit(null);
      setNotice(err instanceof ApiError ? err.message : "反查失敗");
    } finally {
      setLooking(false);
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    setStarting(true);
    setNotice("");
    try {
      const j = await enterApi.startSession(value);
      setState((prev) => ({ ...(prev ?? { ok: true, stats: null, recent: [] }), session: j.session, live: j.live }));
      setRows([]);
      setEntries({});
      setMsgs({});
      setExpanded(null);
      await loadSessions();
    } catch (err) {
      if (err instanceof UnauthorizedError) setAuthed(false);
      else setNotice(err instanceof ApiError ? err.message : "開始記錄失敗");
    } finally {
      setStarting(false);
    }
  };

  const switchSession = async (sid: number) => {
    if (!sid || sid === sessionId) return;
    try {
      await enterApi.selectSession(sid);
      setRows([]);
      setEntries({});
      setMsgs({});
      setExpanded(null);
    } catch {
      setNotice("切換場次失敗");
    }
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginErr("");
    try {
      await enterApi.login(pwd);
      setAuthed(true);
      setPwd("");
    } catch (err) {
      setLoginErr(err instanceof ApiError ? err.message : "登入失敗");
    } finally {
      setLoginBusy(false);
    }
  };

  const stats = state?.stats ?? null;
  const live = Boolean(state?.live);
  const current = state?.session ?? null;

  const counts = useMemo(
    () => ({
      all: stats?.total ?? 0,
      mystery: stats?.mystery ?? 0,
      suspect: stats?.suspect_hidden ?? 0,
    }),
    [stats]
  );

  // ---------- 登入牆 ----------
  if (authed === false) {
    return (
      <div className="dye dye-lock">
        <div className="dye-lock-card">
          <h1>
            ENTER LOG<span>抖音進場名單</span>
          </h1>
          <p>需要管理密碼才能查看</p>
          <form onSubmit={login}>
            <input
              type="password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="管理密碼"
              autoFocus
            />
            <button type="submit" disabled={loginBusy || !pwd}>
              {loginBusy ? "驗證中…" : "解鎖"}
            </button>
          </form>
          {loginErr && <small className="err">{loginErr}</small>}
        </div>
      </div>
    );
  }

  if (authed === null) {
    return <div className="dye dye-lock">LOADING…</div>;
  }

  return (
    <div className="dye">
      <header className="dye-top">
        <div className="dye-brand">
          <span className="logo">◤</span>
          <h1>
            ENTER LOG<b>抖音進場名單</b>
          </h1>
        </div>

        <form className="dye-form" onSubmit={start} autoComplete="off">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="貼上直播間網址，例如 https://live.douyin.com/812195156626"
            spellCheck={false}
          />
          <button type="submit" disabled={starting || !url.trim()}>
            {starting ? "連線中…" : "開始記錄"}
          </button>
          {current && (
            <button
              type="button"
              className={`dye-toggle${state?.paused ? " is-resume" : ""}`}
              onClick={() => void toggleRecording()}
              disabled={starting}
              title={state?.paused ? "續接同一場次" : "停止輪詢，場次保持開啟"}
            >
              {state?.paused ? "▶ 繼續記錄" : "❙❙ 暫停記錄"}
            </button>
          )}
        </form>

        <div className="dye-session">
          <select
            value={sessionId || ""}
            onChange={(e) => void switchSession(Number(e.target.value))}
            title="切回舊場次（永久保留）"
          >
            <option value="">— 選擇場次 —</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.id} {s.anchor_name || s.web_rid} · {dateTime(s.started_at)}
                {s.ended_at === null ? "（進行中）" : ""}
              </option>
            ))}
          </select>
          <span className={`dye-live${live ? " is-live" : ""}`}>
            <i className="dot" />
            {state?.paused
              ? "已停止記錄"
              : live
                ? "直播中"
                : current
                  ? "已下播（停止記錄）"
                  : "未選擇房間"}
          </span>
        </div>
      </header>

      {notice && <div className="dye-notice">{notice}</div>}
      {state?.last_error && <div className="dye-notice">⚠ {state.last_error}</div>}

      <section className="dye-summary">
        <article>
          <h3>本場進場（不重複）</h3>
          <p className="val">{fmt(counts.all)}</p>
          <small>總進場次數 {fmt(stats?.visits ?? 0)}</small>
        </article>
        <article>
          <h3>神秘人</h3>
          <p className="val mystery">{fmt(counts.mystery)}</p>
          <small>暱稱以「神秘人」開頭</small>
        </article>
        <article>
          <h3>疑似隱身（僅發言）</h3>
          <p className="val hidden">{fmt(stats?.hidden_chat_only ?? 0)}</p>
          <small>沒有進場事件，只靠發言捕捉</small>
        </article>
        <article>
          <h3>暱稱被遮蔽</h3>
          <p className="val suspect">{fmt(counts.suspect)}</p>
          <small>暱稱空白或全遮蔽（有進場事件）</small>
        </article>
        <article>
          <h3>房間</h3>
          <p className="val sm">{current?.anchor_name || "—"}</p>
          <small>
            {current ? `${current.web_rid} · 場次 #${current.id} · 開始 ${dateTime(current.started_at)}` : "尚未開始"}
          </small>
        </article>
      </section>

      <div className="dye-filters">
        {([
          ["", `全部 ${fmt(counts.all)}`],
          ["mystery", `神秘人 ${fmt(counts.mystery)}`],
          ["hidden", `疑似隱身 ${fmt((counts.suspect ?? 0) + (stats?.hidden_chat_only ?? 0))}`],
        ] as [EnterMark | "hidden" | "", string][]).map(([key, label]) => (
          <button
            key={key || "all"}
            type="button"
            className={`dye-chip${filter === key ? " is-on" : ""}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
        <span className="dye-lookup">
          <input
            value={lookupUid}
            onChange={(e) => setLookupUid(e.target.value)}
            placeholder="輸入 UID 反查暱稱"
            inputMode="numeric"
            onKeyDown={(e) => {
              if (e.key === "Enter") void lookup();
            }}
          />
          <button type="button" onClick={() => void lookup()} disabled={looking || !lookupUid.trim()}>
            {looking ? "查詢中…" : "反查"}
          </button>
          {lookupHit && (
            <em>
              {lookupHit.nickname}
              {lookupHit.uniqueId ? ` · ${lookupHit.uniqueId}` : ""}
            </em>
          )}
        </span>
        <span className="dye-hint">
          資料來源：進場（Member）＋ 發言（Chat）· 每 3 秒更新 · 點列可看進場時間與發言原文
        </span>
      </div>

      <section className="dye-tablewrap">
        <table className="dye-table">
          <thead>
            <tr>
              <th>#</th>
              <th>暱稱／標記</th>
              <th>真實暱稱</th>
              <th>UID</th>
              <th>抖音號</th>
              <th className="num">進場</th>
              <th className="num">發言</th>
              <th>首次進場</th>
              <th>最後進場</th>
            </tr>
          </thead>
          <tbody>
            {!sessionId ? (
              <tr>
                <td colSpan={9} className="empty">
                  先在上方貼一個直播間網址，按「開始記錄」
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty">
                  {listErr || (live ? "等待進場／發言事件…" : "此場次沒有紀錄")}
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <Fragment key={r.uid}>
                  <tr
                    key={r.uid}
                    className={`dye-row${r.mark ? " is-" + r.mark : ""}${expanded === r.uid ? " is-open" : ""}`}
                    onClick={() => void toggle(r.uid)}
                  >
                    <td>{i + 1}</td>
                    <td>
                      <span className="nick">{r.nickname || "（無暱稱）"}</span>
                      {r.mark === "mystery" && <span className="badge mystery">神秘人</span>}
                      {r.mark === "suspect_hidden" && <span className="badge suspect">疑似隱身</span>}
                      {r.visits === 0 && r.chat_count > 0 && (
                        <span className="badge hidden">疑似隱身（僅發言）</span>
                      )}
                      {r.sec_uid && (
                        <a
                          className="plink"
                          href={`https://www.douyin.com/user/${r.sec_uid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          ↗
                        </a>
                      )}
                    </td>
                    <td className="mono">{r.uid}</td>
                    <td className="mono">{r.display_id || "—"}</td>
                    <td className="real">
                      {r.real_nickname ? (
                        <span className="real-name" title={`UID ${r.uid}`}>
                          {r.real_nickname}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="real-btn"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void lookup(r.uid);
                          }}
                          disabled={looking}
                          title="用 UID 反查真實暱稱"
                        >
                          🔍 反查
                        </button>
                      )}
                    </td>
                    <td className="num">{fmt(r.visits)}</td>
                    <td className="num">{fmt(r.chat_count)}</td>
                    <td className="mono">{clock(r.first_ts)}</td>
                    <td className="mono">{clock(r.last_ts)}</td>
                  </tr>
                  {expanded === r.uid && (
                    <tr key={`${r.uid}-detail`} className="dye-detail">
                      <td colSpan={7}>
                        <div className="detail-box">
                          <span className="detail-title">進場（{entries[r.uid]?.length ?? r.visits} 次）</span>
                          <span className="detail-times">
                            {(entries[r.uid] ?? []).map((ts, k) => (
                              <em key={`${ts}-${k}`}>{clock(ts)}</em>
                            ))}
                            {!entries[r.uid] && <em>—</em>}
                          </span>
                        </div>
                        <div className="detail-box">
                          <span className="detail-title">發言（{msgs[r.uid]?.length ?? r.chat_count} 則）</span>
                          <span className="detail-msgs">
                            {(msgs[r.uid] ?? []).map((m, k) => (
                              <em key={`${m.ts}-${k}`}>
                                <b>{clock(m.ts)}</b> {m.content || "（空）"}
                              </em>
                            ))}
                            {!msgs[r.uid] && <em>—</em>}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </section>

      <footer className="dye-foot">
        <span>ENTER LOG · 只記錄進場事件 · SQLite 永久保存（可切回舊場次）</span>
        <span>{state?.paused ? "■ 已停止記錄" : live ? "● 記錄中" : "○ 未記錄"}</span>
      </footer>
    </div>
  );
}
