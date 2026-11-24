// =====================================================================
//  DOUYIN LIVE — 單一工具三分頁（監控／名單／歷史）
//  Phase 1：監控可用；名單基本可用；歷史列表可用（詳情待 Phase 3）
// =====================================================================
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import {
  ApiError,
  UnauthorizedError,
  csvUrl,
  dyApi,
  type EntrantsPayload,
  type SessionsPayload,
  type StateChat,
  type StatePayload,
  type TargetWithState,
} from "./api";
import type { CookieStatus, EntrantRow, RankMember } from "../types";
import "./douyin.css";

const POLL_STATE = 2000;
const POLL_ENTRANTS = 5000;
const POLL_TARGETS = 15_000;

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US");

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

const duration = (start: number, end: number | null) => {
  const sec = Math.max(0, (end ?? Date.now() / 1000) - start);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
};

const TYPE_LABEL: Record<string, string> = { Chat: "聊天", Member: "進場", Gift: "禮物", Like: "點讚" };

function statusText(status: number | undefined): string {
  if (status === 2) return "直播中";
  if (status === 4) return "已下播";
  if (status === 0) return "未開播";
  return "未知";
}

function LockPanel({ onUnlocked }: { onUnlocked: () => void }) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await dyApi.login(pwd);
      setPwd("");
      onUnlocked();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dy-lock">
      <form className="dy-lock-card" onSubmit={submit}>
        <div className="dy-lock-title">DOUYIN LIVE</div>
        <div className="dy-lock-sub">// 需要管理權限</div>
        <input
          className="dy-input"
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          placeholder="管理密碼"
          autoFocus
        />
        <button className="dy-btn dy-btn-primary" type="submit" disabled={busy || !pwd}>
          {busy ? "驗證中…" : "解鎖"}
        </button>
        {err && <div className="dy-err">{err}</div>}
      </form>
    </div>
  );
}

function cookieLabel(st: CookieStatus | null): { text: string; tone: string } {
  if (!st || !st.configured) return { text: "COOKIE 未設定", tone: "grey" };
  if (st.valid === true) return { text: "COOKIE 已登入", tone: "ok" };
  if (st.valid === false) return { text: "COOKIE 驗證失敗", tone: "bad" };
  return { text: "COOKIE 未驗證", tone: "warn" };
}

function CookiePill({ status, onClick }: { status: CookieStatus | null; onClick: () => void }) {
  const label = cookieLabel(status);
  return (
    <button type="button" className={`dy-pill dy-pill--${label.tone}`} onClick={onClick}>
      <i className="dot" />
      {label.text}
      {status?.account ? <b>{status.account.nickname}</b> : null}
    </button>
  );
}

function CookieModal({
  status,
  onClose,
  onSaved,
}: {
  status: CookieStatus | null;
  onClose: () => void;
  onSaved: (st: CookieStatus) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    const raw = text.trim();
    if (!raw) {
      setErr("請先貼上 cookie JSON");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const j = await dyApi.updateCookie(raw);
      onSaved(j.status);
      setText("");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "更新失敗");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setErr("");
    try {
      const j = await dyApi.verifyCookie();
      onSaved(j.status);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "驗證失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dy-modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dy-modal">
        <header>
          <h2>抖音 cookie</h2>
          <button type="button" className="dy-x" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="dy-hint">
          貼上 Playwright／瀏覽器擴充匯出的 JSON 陣列（需含 <code>sessionid</code>）。
          驗證通過才會寫入檔案並立即生效；失敗不會覆蓋舊 cookie。
        </p>
        <div className="dy-cookie-state">
          <span className={`dy-pill dy-pill--${cookieLabel(status).tone}`}>{cookieLabel(status).text}</span>
          <span>帳號：{status?.account?.nickname ?? "—"}</span>
          <span>到期：{status?.expires_at ? dateTime(status.expires_at / 1000) : "—"}</span>
          {status?.last_error && <span className="dy-err">上次錯誤：{status.last_error}</span>}
        </div>
        <textarea
          className="dy-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='[{"name":"sessionid","value":"…","domain":".douyin.com"}]'
          spellCheck={false}
        />
        <div className="dy-modal-actions">
          <button type="button" className="dy-btn dy-btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? "驗證中…" : "驗證並更新"}
          </button>
          <button type="button" className="dy-btn" onClick={() => void verify()} disabled={busy}>
            重新檢查
          </button>
          <button
            type="button"
            className="dy-btn dy-btn-danger"
            disabled={busy}
            onClick={() => {
              void dyApi.clearCookie().then((j) => onSaved(j.status));
            }}
          >
            清除
          </button>
        </div>
        {err && <div className="dy-err">{err}</div>}
      </div>
    </div>
  );
}

function Chart({ series }: { series: { ts: number; viewers: number }[] }) {
  const W = 640;
  const H = 160;
  const points = useMemo(() => {
    if (series.length < 2) return "";
    const values = series.map((s) => s.viewers);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    return series
      .map((s, i) => {
        const x = (i / (series.length - 1)) * W;
        const y = H - 10 - ((s.viewers - min) / span) * (H - 20);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [series]);

  if (series.length < 2) return <div className="dy-empty">累積資料中…（首次快照約 3 秒）</div>;
  return (
    <svg className="dy-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function MonitorTab({
  state,
  chat,
  targets,
  onSelect,
  onStart,
  starting,
}: {
  state: StatePayload | null;
  chat: StateChat[];
  targets: TargetWithState[];
  onSelect: (rid: string) => void;
  onStart: (url: string) => Promise<void>;
  starting: boolean;
}) {
  const [url, setUrl] = useState("");
  const room = (state?.room ?? {}) as {
    status?: number;
    anchor_name?: string;
    title?: string;
    viewers?: number;
    like_count?: number;
    total_user?: string;
    web_rid?: string;
    viewer_text?: string;
  };
  const live = room.status === 2;

  return (
    <div className="dy-monitor">
      <div className="dy-roombar">
        <form
          className="dy-roomform"
          onSubmit={(e) => {
            e.preventDefault();
            const v = url.trim();
            if (v) void onStart(v).then(() => setUrl(""));
          }}
        >
          <input
            className="dy-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="貼上直播間網址，例如 https://live.douyin.com/812195156626"
            spellCheck={false}
          />
          <button className="dy-btn dy-btn-primary" type="submit" disabled={starting || !url.trim()}>
            {starting ? "連線中…" : "開始監控"}
          </button>
        </form>
        {targets.length > 0 && (
          <select
            className="dy-select"
            value={state?.selected_web_rid ?? ""}
            onChange={(e) => onSelect(e.target.value)}
          >
            {targets.map((t) => (
              <option key={t.web_rid} value={t.web_rid}>
                {t.anchor_name || t.label || t.web_rid}（{t.status_text}）
              </option>
            ))}
          </select>
        )}
      </div>

      <section className="dy-cards">
        <article className={`dy-card${live ? " is-live" : ""}`}>
          <h3>開播狀態</h3>
          <p className="dy-val">{statusText(room.status)}</p>
          <small>{room.title || "—"}</small>
        </article>
        <article className="dy-card">
          <h3>在線人數</h3>
          <p className="dy-val">{fmt(room.viewers)}</p>
          <small>{room.viewer_text || "—"}</small>
        </article>
        <article className="dy-card">
          <h3>本場點讚</h3>
          <p className="dy-val">{fmt(room.like_count)}</p>
          <small>讚／分 {fmt(state?.inter.likes_per_min)}</small>
        </article>
        <article className="dy-card">
          <h3>總觀看人次</h3>
          <p className="dy-val">{room.total_user || "—"}</p>
          <small>聊天 {fmt(state?.inter.chat)}｜進場 {fmt(state?.inter.member)}</small>
        </article>
        <article className="dy-card">
          <h3>本場禮物</h3>
          <p className="dy-val">{fmt(state?.gifts.total_diamonds)} 鑽</p>
          <small>{fmt(state?.gifts.events)} 次｜目錄 {fmt(state?.gifts.catalog)}</small>
        </article>
        <article className="dy-card">
          <h3>主播</h3>
          <p className="dy-val dy-val-sm">{room.anchor_name || "—"}</p>
          <small>{room.web_rid || "—"}</small>
        </article>
      </section>

      {state?.stale && <div className="dy-notice">資料可能過期：{state.errors[0]?.msg ?? "房間沒有回應"}</div>}
      {!state?.api.chat_ok && state?.db.session_id && (
        <div className="dy-notice">聊天事件目前沒有資料（im/fetch 失敗或房間無人發言）。</div>
      )}

      <main className="dy-grid">
        <section className="dy-panel dy-panel--wide">
          <header>
            <h2>在線人數曲線</h2>
            <span>{state?.stale ? "STALE" : "LIVE"}</span>
          </header>
          <Chart series={state?.series ?? []} />
        </section>

        <section className="dy-panel">
          <header>
            <h2>在線觀眾 Top 10</h2>
          </header>
          <table className="dy-table">
            <thead>
              <tr>
                <th>#</th>
                <th>暱稱</th>
                <th className="num">等級</th>
              </tr>
            </thead>
            <tbody>
              {(state?.rank ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="dy-empty">
                    {state?.api.rank_ok === false ? "榜單暫時不可用" : "等待榜單…"}
                  </td>
                </tr>
              )}
              {(state?.rank ?? []).slice(0, 10).map((r: RankMember) => (
                <tr key={`${r.rank}-${r.nickname}`}>
                  <td>{r.rank}</td>
                  <td>{r.nickname}</td>
                  <td className="num">{r.pay_level || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="dy-panel dy-panel--chat">
          <header>
            <h2>彈幕</h2>
            <span>{chat.length} 則</span>
          </header>
          <div className="dy-chat">
            {chat.length === 0 && <div className="dy-empty">等待聊天／進場／禮物事件…</div>}
            {chat.map((m) => (
              <div key={m.id} className={`dy-crow dy-crow--${m.type.toLowerCase()}`}>
                <span className="dy-ctype">{TYPE_LABEL[m.type] ?? m.type}</span>
                <span className="dy-cname">{m.nickname || "—"}</span>
                <span className="dy-ctext">
                  {m.content || m.gift_name || ""}
                  {m.diamonds ? <em>{fmt(m.diamonds)} 鑽</em> : null}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="dy-panel">
          <header>
            <h2>粉絲團親密度</h2>
          </header>
          <table className="dy-table">
            <thead>
              <tr>
                <th>#</th>
                <th>暱稱</th>
                <th className="num">親密度</th>
              </tr>
            </thead>
            <tbody>
              {(state?.fans.members ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="dy-empty">
                    {state?.fans_ok === false ? "親密度暫時不可用" : "等待資料…"}
                  </td>
                </tr>
              )}
              {(state?.fans.members ?? []).slice(0, 10).map((m, i) => (
                <tr key={`${m.nickname}-${i}`}>
                  <td>{i + 1}</td>
                  <td>{m.nickname}</td>
                  <td className="num">{fmt(m.intimacy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="dy-panel">
          <header>
            <h2>送禮貢獻</h2>
          </header>
          <table className="dy-table">
            <thead>
              <tr>
                <th>#</th>
                <th>暱稱</th>
                <th className="num">鑽石</th>
              </tr>
            </thead>
            <tbody>
              {(state?.gifts.top ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="dy-empty">
                    尚無禮物
                  </td>
                </tr>
              )}
              {(state?.gifts.top ?? []).map((g, i) => (
                <tr key={g.uid || i}>
                  <td>{i + 1}</td>
                  <td>{g.nickname || g.uid}</td>
                  <td className="num">{fmt(g.diamonds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

function EntrantsTab({ sessionId }: { sessionId: number | null }) {
  const [data, setData] = useState<EntrantsPayload | null>(null);
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, { ts: number; type: string; content: string | null }[]>>({});
  const sid = data?.session_id ?? sessionId;

  const load = useCallback(async () => {
    try {
      const j = await dyApi.entrants({ sessionId: sessionId ?? undefined, mark: filter || undefined, q });
      setData(j);
      setErr("");
    } catch (e) {
      if (e instanceof UnauthorizedError) return;
      setErr(e instanceof ApiError ? e.message : "讀取名單失敗");
    }
  }, [sessionId, filter, q]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_ENTRANTS);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async (uid: string) => {
    if (expanded === uid) {
      setExpanded(null);
      return;
    }
    setExpanded(uid);
    if (sid && !events[uid]) {
      try {
        const j = await dyApi.entrantEvents(uid, sid);
        setEvents((prev) => ({ ...prev, [uid]: j.events }));
      } catch {
        /* ignore */
      }
    }
  };

  const remove = async (r: EntrantRow) => {
    if (!sid) return;
    if (!window.confirm(`刪除「${r.nickname || r.uid}」在本場的紀錄？此操作無法復原。`)) return;
    try {
      await dyApi.deleteEntrant(r.uid, sid);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "刪除失敗");
    }
  };

  const stats = data?.stats;
  const rows = data?.entrants ?? [];

  return (
    <div className="dy-entrants">
      <section className="dy-cards">
        <article className="dy-card">
          <h3>本場人數</h3>
          <p className="dy-val">{fmt(stats?.total)}</p>
          <small>總進場 {fmt(stats?.visits)}</small>
        </article>
        <article className="dy-card">
          <h3>神祕人</h3>
          <p className="dy-val">{fmt(stats?.mystery)}</p>
          <small>會自動反查真名</small>
        </article>
        <article className="dy-card">
          <h3>未見進場</h3>
          <p className="dy-val">{fmt((stats?.suspect_hidden ?? 0) + (stats?.hidden_chat_only ?? 0))}</p>
          <small>只有發言／暱稱被遮</small>
        </article>
        <article className="dy-card">
          <h3>匿名</h3>
          <p className="dy-val">{fmt(stats?.anon)}</p>
          <small>uid 被換成 111111</small>
        </article>
        <article className="dy-card">
          <h3>禮物鑽石</h3>
          <p className="dy-val">{fmt(stats?.diamonds)}</p>
          <small>本場累計</small>
        </article>
      </section>

      <div className="dy-toolbar">
        {[
          ["", `全部 ${fmt(stats?.total)}`],
          ["mystery", `神祕人 ${fmt(stats?.mystery)}`],
          ["hidden", `未見進場 ${fmt((stats?.suspect_hidden ?? 0) + (stats?.hidden_chat_only ?? 0))}`],
        ].map(([key, label]) => (
          <button
            key={key || "all"}
            type="button"
            className={`dy-chip${filter === key ? " is-on" : ""}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
        <input
          className="dy-input dy-input--sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜暱稱／抖音號／uid"
        />
        {sid && (
          <a className="dy-btn" href={csvUrl(sid)}>
            匯出 CSV
          </a>
        )}
      </div>

      {err && <div className="dy-notice">{err}</div>}
      {!sid && <div className="dy-empty">先到「監控」分頁貼上直播間網址。</div>}

      {sid && (
        <div className="dy-tablewrap">
          <table className="dy-table dy-table--entrants">
            <thead>
              <tr>
                <th>#</th>
                <th>暱稱／標記</th>
                <th>真實ID</th>
                <th>uid／抖音號</th>
                <th className="num">進場</th>
                <th className="num">發言</th>
                <th className="num">鑽石</th>
                <th>最後</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="dy-empty">
                    還沒有名單資料
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <Fragment key={r.uid}>
                  <tr className={r.mark ? `is-${r.mark}` : ""} onClick={() => void toggle(r.uid)}>
                    <td>{i + 1}</td>
                    <td>
                      <span className="dy-nick">{r.nickname || "（無暱稱）"}</span>
                      {r.mark === "mystery" && <span className="dy-badge mystery">神祕人</span>}
                      {r.mark === "suspect_hidden" && <span className="dy-badge suspect">暱稱被遮蔽</span>}
                      {r.hidden_flag === 1 && <span className="dy-badge hidden">未見進場</span>}
                      {r.anonymous === 1 && <span className="dy-badge anon">匿名</span>}
                    </td>
                    <td>
                      {r.real_nickname ? (
                        <span className="dy-real">{r.real_nickname}</span>
                      ) : r.mark === "mystery" && r.anonymous === 0 ? (
                        <span className="dy-wait">反查中…</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono">
                      {r.anonymous === 1 ? "匿名" : r.uid}
                      {r.display_id ? <em> · {r.display_id}</em> : null}
                    </td>
                    <td className="num">{fmt(r.visits)}</td>
                    <td className="num">{fmt(r.chat_count)}</td>
                    <td className="num">{r.diamonds ? fmt(r.diamonds) : "—"}</td>
                    <td className="mono">{clock(r.last_ts)}</td>
                    <td>
                      <button
                        type="button"
                        className="dy-x dy-x--sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(r);
                        }}
                        title="刪除這個人在本場的紀錄"
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                  {expanded === r.uid && (
                    <tr className="dy-detail">
                      <td colSpan={9}>
                        {(events[r.uid] ?? []).length === 0 ? (
                          <span className="dy-empty">沒有明細</span>
                        ) : (
                          <div className="dy-detail-list">
                            {(events[r.uid] ?? []).slice(0, 30).map((ev, k) => (
                              <span key={`${ev.ts}-${k}`}>
                                <b>{clock(ev.ts)}</b> {TYPE_LABEL[ev.type] ?? ev.type} {ev.content || ""}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HistoryTab() {
  const [data, setData] = useState<SessionsPayload | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await dyApi.sessions();
        if (alive) {
          setData(j);
          setErr("");
        }
      } catch (e) {
        if (alive) setErr(e instanceof ApiError ? e.message : "讀取歷史失敗");
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="dy-history">
      {err && <div className="dy-notice">{err}</div>}
      <div className="dy-tablewrap">
        <table className="dy-table">
          <thead>
            <tr>
              <th>#</th>
              <th>主播</th>
              <th>開始</th>
              <th>長度</th>
              <th className="num">聊天</th>
              <th className="num">進場</th>
              <th className="num">禮物鑽</th>
              <th className="num">峰值</th>
            </tr>
          </thead>
          <tbody>
            {(data?.sessions ?? []).length === 0 && (
              <tr>
                <td colSpan={8} className="dy-empty">
                  還沒有任何場次
                </td>
              </tr>
            )}
            {(data?.sessions ?? []).map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.anchor_name || s.web_rid}</td>
                <td className="mono">{dateTime(s.started_at)}</td>
                <td className="mono">{duration(s.started_at, s.ended_at)}</td>
                <td className="num">{fmt(s.chat_count)}</td>
                <td className="num">{fmt(s.member_count)}</td>
                <td className="num">{fmt(s.gift_diamonds)}</td>
                <td className="num">{fmt(s.peak_viewers)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dy-hint">單場詳情（榜單／事件搜尋／回放）在 Phase 3 接上。</p>
    </div>
  );
}

export default function DouyinPage() {
  const location = useLocation();
  const tab = location.pathname.endsWith("/entrants")
    ? "entrants"
    : location.pathname.includes("/history")
      ? "history"
      : "monitor";

  const [authed, setAuthed] = useState<boolean | null>(null);
  const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [state, setState] = useState<StatePayload | null>(null);
  const [chat, setChat] = useState<StateChat[]>([]);
  const [targets, setTargets] = useState<TargetWithState[]>([]);
  const [notice, setNotice] = useState("");
  const [starting, setStarting] = useState(false);
  const cursor = useRef(0);

  useEffect(() => {
    void dyApi
      .me()
      .then(setAuthed)
      .catch(() => setAuthed(false));
  }, []);

  const loadCookie = useCallback(async () => {
    try {
      const j = await dyApi.cookie();
      setCookieStatus(j.status);
    } catch (e) {
      if (e instanceof UnauthorizedError) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    if (authed) void loadCookie();
  }, [authed, loadCookie]);

  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const tick = async () => {
      try {
        const j = await dyApi.targets();
        if (alive) setTargets(j.targets);
      } catch (e) {
        if (e instanceof UnauthorizedError) setAuthed(false);
      }
    };
    void tick();
    const t = setInterval(tick, POLL_TARGETS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [authed]);

  useEffect(() => {
    if (!authed || tab !== "monitor") return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await dyApi.state(cursor.current);
        if (!alive) return;
        setState(s);
        cursor.current = s.chat_cursor;
        if (s.chat.length > 0) setChat((prev) => [...prev, ...s.chat].slice(-200));
        setNotice("");
      } catch (e) {
        if (e instanceof UnauthorizedError) setAuthed(false);
        else if (alive) setNotice(e instanceof ApiError ? e.message : "讀取狀態失敗");
      }
    };
    void tick();
    const t = setInterval(tick, POLL_STATE);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [authed, tab]);

  const start = async (url: string) => {
    setStarting(true);
    setNotice("");
    try {
      const j = await dyApi.addTarget(url);
      await dyApi.selectTarget(j.target.web_rid);
      setState(null);
      setChat([]);
      cursor.current = 0;
      setNotice(`開始監控 ${j.target.anchor_name || j.target.web_rid}`);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "開始監控失敗");
    } finally {
      setStarting(false);
    }
  };

  const select = async (rid: string) => {
    try {
      await dyApi.selectTarget(rid);
      setState(null);
      setChat([]);
      cursor.current = 0;
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "切換失敗");
    }
  };

  if (authed === false) {
    return (
      <LockPanel
        onUnlocked={() => {
          setAuthed(true);
        }}
      />
    );
  }
  if (authed === null) return <div className="dy-loading">ESTABLISHING LINK…</div>;

  return (
    <div className="dy">
      <header className="dy-top">
        <div className="dy-brand">
          <span className="dy-logo">◤</span>
          <h1>
            DOUYIN LIVE<b>抖音直播</b>
          </h1>
        </div>
        <nav className="dy-tabs">
          <NavLink to="/tools/douyin" end className={({ isActive }) => (isActive ? "is-on" : "")}>
            監控
          </NavLink>
          <NavLink to="/tools/douyin/entrants" className={({ isActive }) => (isActive ? "is-on" : "")}>
            名單
          </NavLink>
          <NavLink to="/tools/douyin/history" className={({ isActive }) => (isActive ? "is-on" : "")}>
            歷史
          </NavLink>
        </nav>
        <div className="dy-actions">
          <CookiePill status={cookieStatus} onClick={() => setCookieOpen(true)} />
          <span className={`dy-live${state?.room && (state.room as { status?: number }).status === 2 ? " is-on" : ""}`}>
            <i className="dot" />
            {state?.room && (state.room as { status?: number }).status === 2 ? "直播中" : "未開播"}
          </span>
        </div>
      </header>

      {notice && <div className="dy-notice">{notice}</div>}

      {tab === "monitor" && (
        <MonitorTab
          state={state}
          chat={chat}
          targets={targets}
          onSelect={(rid) => void select(rid)}
          onStart={start}
          starting={starting}
        />
      )}
      {tab === "entrants" && <EntrantsTab sessionId={state?.db.session_id ?? null} />}
      {tab === "history" && <HistoryTab />}

      <footer className="dy-foot">
        <span>DOUYIN LIVE · 事件唯一真相 · SQLite 永久保存</span>
        <span>{cookieStatus?.expires_at ? `cookie 到期 ${dateTime(cookieStatus.expires_at / 1000)}` : ""}</span>
      </footer>

      {cookieOpen && (
        <CookieModal
          status={cookieStatus}
          onClose={() => setCookieOpen(false)}
          onSaved={(st) => {
            setCookieStatus(st);
            setCookieOpen(false);
          }}
        />
      )}
    </div>
  );
}
