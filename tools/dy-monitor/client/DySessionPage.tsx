// =====================================================================
//  單場詳情（/tools/dy-monitor/history/:sid）
//  KPI + 在線曲線 + 三張榜（送禮/觀眾/親密度）+ 熱門禮物 + 事件分頁
// =====================================================================
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import ToolFrame from "../../../src/components/ToolFrame";
import ViewerChart from "./ViewerChart";
import {
  ApiError,
  UnauthorizedError,
  dyApi,
  type HistoryEventRow,
} from "./api";
import { LockNotice } from "./DyHistoryPage";
import "./dy-monitor.css";

const PAGE = 100;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function hhmmss(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dt(sec: number | null | undefined): string {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dur(a: number, b: number | null): string {
  const sec = Math.max(0, (b ?? Date.now() / 1000) - a);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${pad(m)}m` : `${m}m`;
}
function num(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}
function compact(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}萬`;
  return String(v);
}

interface Detail {
  session: Record<string, unknown>;
  ranks: Record<string, { ts: number | null; rows: Record<string, unknown>[] }>;
  fans: Record<string, unknown> | null;
  gift_top: { nickname: string; d: number; c: number }[];
  gift_names: { gift_name: string; n: number; d: number }[];
  event_counts: Record<string, number>;
  series: { ts: number; viewers: number; like_count: number }[];
}

export default function DySessionPage() {
  const { sid } = useParams();
  const sessionId = Number(sid);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<HistoryEventRow[]>([]);
  const [eventTotal, setEventTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [error, setError] = useState("");

  const loadDetail = useCallback(async () => {
    try {
      const res = await dyApi.historySession(sessionId);
      setDetail(res as Detail);
      setAuthed(true);
    } catch (ex) {
      if (ex instanceof UnauthorizedError) setAuthed(false);
      else setError(ex instanceof ApiError ? ex.message : "載入失敗");
    }
  }, [sessionId]);

  const loadEvents = useCallback(async () => {
    try {
      const res = await dyApi.historyEvents(sessionId, { type, q, limit: PAGE, offset });
      setEvents(res.events);
      setEventTotal(res.total);
      setAuthed(true);
    } catch (ex) {
      if (ex instanceof UnauthorizedError) setAuthed(false);
      else setError(ex instanceof ApiError ? ex.message : "事件載入失敗");
    }
  }, [sessionId, type, q, offset]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    document.title = `DOUYIN MONITOR // 場次 #${sid}`;
  }, [sid]);
  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const s = detail?.session ?? {};
  const counts = detail?.event_counts ?? {};
  const ranks = detail?.ranks ?? {};
  const series = (detail?.series ?? []).map((p) => ({
    ts: p.ts,
    viewers: p.viewers,
    likes: p.like_count,
  }));

  return (
    <ToolFrame title="DOUYIN MONITOR" zh={`抖音直播監控台 // 場次 #${sid}`}>
      <div className="dym">
        <header className="dym-head">
          <div className="dym-head-left">
            <span className="dym-anchor">場次 #{sid}</span>
            <span className="dym-dim">{String(s.anchor_name ?? "")}</span>
            <span className="dym-title">{String(s.title ?? "")}</span>
            {Number(s.partial) ? <span className="dym-badge dym-badge-warn">中途開始記錄</span> : null}
          </div>
          <div className="dym-head-right">
            <Link className="dym-btn" to="/tools/dy-monitor/history">
              ◂ 場次列表
            </Link>
            <Link className="dym-btn" to="/tools/dy-monitor">
              回監控台
            </Link>
          </div>
        </header>

        {authed === false && <LockNotice onLogin={() => void loadDetail()} />}
        {error && <div className="dym-err">{error}</div>}

        {detail && (
          <>
            <section className="dym-kpis">
              {[
                { label: "開播", value: dt(Number(s.started_at)), sub: dt(Number(s.ended_at)) },
                { label: "時長", value: dur(Number(s.started_at), s.ended_at as number | null), sub: String(s.total_user ?? "") },
                { label: "在線 峰/均", value: `${compact(Number(s.peak_viewers))} / ${compact(Math.round(Number(s.avg_viewers)))}`, sub: `${(detail.series ?? []).length} 筆快照` },
                { label: "禮物", value: num(Number(s.gift_diamonds)), sub: `${num(Number(s.gift_events))} 次 · 鑽` },
                { label: "聊天 / 進場", value: `${num(Number(s.chat_count))} / ${num(Number(s.member_count))}`, sub: `${num(Number(s.chat_users))} 位發言者` },
                { label: "點讚增量", value: `+${num(Number(s.likes_end) - Number(s.likes_start))}`, sub: `終值 ${compact(Number(s.likes_end))}` },
              ].map((k) => (
                <div key={k.label} className="dym-kpi">
                  <div className="dym-kpi-label">{k.label}</div>
                  <div className="dym-kpi-value">{k.value}</div>
                  <div className="dym-kpi-sub">{k.sub}</div>
                </div>
              ))}
            </section>

            <section className="dym-grid dym-grid-history">
              <div className="dym-panel dym-panel-chart">
                <ViewerChart series={series} replay label="在線人數（本場全程）" hint="歷史回放" />
              </div>

              <div className="dym-panel">
                <div className="dym-panel-head">
                  <span>送禮貢獻榜</span>
                  <span className="dym-dim">{(detail.gift_top ?? []).length} 位</span>
                </div>
                <div className="dym-panel-body">
                  {(detail.gift_top ?? []).map((g, i) => (
                    <div key={`${g.nickname}-${i}`} className="dym-rank-row">
                      <span className="dym-rank-idx">{i + 1}</span>
                      <span className="dym-nick">{g.nickname || "匿名"}</span>
                      <span className="dym-dim">{num(g.c)} 次</span>
                      <span className="dym-rank-score">{num(g.d)}</span>
                    </div>
                  ))}
                  {(detail.gift_top ?? []).length === 0 && <div className="dym-empty">無禮物資料</div>}
                </div>
              </div>

              <div className="dym-panel">
                <div className="dym-panel-head">
                  <span>在線觀眾榜</span>
                  <span className="dym-dim">{ranks.audience?.ts ? hhmmss(ranks.audience.ts) : "未收錄"}</span>
                </div>
                <div className="dym-panel-body">
                  {(ranks.audience?.rows ?? []).map((r, i) => (
                    <div key={i} className="dym-rank-row">
                      <span className="dym-rank-idx">{String(r.rank ?? i + 1)}</span>
                      <span className="dym-nick">{String(r.nickname ?? "")}</span>
                      <span className="dym-dim">Lv.{String(r.level ?? 0)}</span>
                    </div>
                  ))}
                  {(ranks.audience?.rows ?? []).length === 0 && (
                    <div className="dym-empty">本場未收錄榜單</div>
                  )}
                </div>
              </div>

              <div className="dym-panel">
                <div className="dym-panel-head">
                  <span>粉絲團親密度</span>
                  <span className="dym-dim">
                    {detail.fans ? String(detail.fans.club_name ?? "") : "未收錄"}
                  </span>
                </div>
                <div className="dym-panel-body">
                  {detail.fans ? (
                    <>
                      <div className="dym-fans-meta">
                        <span>活躍 {num(Number(detail.fans.active))}</span>
                        <span>總數 {num(Number(detail.fans.total))}</span>
                        <span>今日 +{num(Number(detail.fans.today_new))}</span>
                      </div>
                      {((detail.fans.members ?? []) as { nickname: string; intimacy: number; level: number }[])
                        .slice(0, 50)
                        .map((m, i) => (
                          <div key={i} className="dym-rank-row">
                            <span className="dym-rank-idx">{i + 1}</span>
                            <span className="dym-nick">{m.nickname}</span>
                            <span className="dym-dim">Lv.{m.level}</span>
                            <span className="dym-rank-score">{compact(m.intimacy)}</span>
                          </div>
                        ))}
                    </>
                  ) : (
                    <div className="dym-empty">本場未收錄親密度</div>
                  )}
                </div>
              </div>

              <div className="dym-panel">
                <div className="dym-panel-head">
                  <span>熱門禮物</span>
                  <span className="dym-dim">{(detail.gift_names ?? []).length} 種</span>
                </div>
                <div className="dym-panel-body">
                  {(detail.gift_names ?? []).map((g, i) => (
                    <div key={i} className="dym-rank-row dym-rank-gift">
                      <span className="dym-nick">{g.gift_name || "（未知）"}</span>
                      <span className="dym-dim">{num(g.n)} 個</span>
                      <span className="dym-rank-score">{num(g.d)}</span>
                    </div>
                  ))}
                  {(detail.gift_names ?? []).length === 0 && <div className="dym-empty">無禮物資料</div>}
                </div>
              </div>
            </section>

            <section className="dym-panel" style={{ marginTop: 10 }}>
              <div className="dym-panel-head">
                <span>事件紀錄（{num(eventTotal)} 筆）</span>
                <div className="dym-filters">
                  {["", "Chat", "Gift", "Member", "Like"].map((t) => (
                    <button
                      key={t || "all"}
                      type="button"
                      className={`dym-chip${type === t ? " on" : ""}`}
                      onClick={() => {
                        setType(t);
                        setOffset(0);
                      }}
                    >
                      {t === "" ? "全部" : t}
                      {t && counts[t] !== undefined ? ` ${num(counts[t])}` : ""}
                    </button>
                  ))}
                  <form
                    className="dym-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setQ(qInput.trim());
                      setOffset(0);
                    }}
                  >
                    <input
                      className="dym-input"
                      value={qInput}
                      onChange={(e) => setQInput(e.target.value)}
                      placeholder="搜尋暱稱/內容/禮物"
                    />
                    <button className="dym-btn" type="submit">
                      搜尋
                    </button>
                  </form>
                </div>
              </div>
              <div className="dym-panel-body dym-h-wrap">
                <table className="dym-h-table dym-h-events">
                  <thead>
                    <tr>
                      <th>時間</th>
                      <th>類型</th>
                      <th>暱稱</th>
                      <th>內容</th>
                      <th>禮物</th>
                      <th>鑽石</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={i}>
                        <td className="dym-dim">{hhmmss(e.ts)}</td>
                        <td className={`dym-t-${e.type}`}>{e.type}</td>
                        <td className="dym-nick">{e.nickname || "—"}</td>
                        <td>{e.content || ""}</td>
                        <td>{e.gift_name || ""}</td>
                        <td className="dym-rank-score">{e.diamonds ? num(e.diamonds) : ""}</td>
                      </tr>
                    ))}
                    {events.length === 0 && (
                      <tr>
                        <td colSpan={6} className="dym-empty">
                          沒有符合條件的事件
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {eventTotal > PAGE && (
                <div className="dym-pager">
                  <button
                    className="dym-btn"
                    type="button"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE))}
                  >
                    ◂ PREV
                  </button>
                  <span className="dym-dim">
                    {offset + 1}–{Math.min(offset + PAGE, eventTotal)} / {eventTotal}
                  </span>
                  <button
                    className="dym-btn"
                    type="button"
                    disabled={offset + PAGE >= eventTotal}
                    onClick={() => setOffset(offset + PAGE)}
                  >
                    NEXT ▸
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </ToolFrame>
  );
}
