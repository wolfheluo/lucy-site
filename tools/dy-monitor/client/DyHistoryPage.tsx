// =====================================================================
//  歷史場次列表（/tools/dy-monitor/history）
//  - 分頁 50 筆；點列進入單場詳情
// =====================================================================
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import ToolFrame from "../../../src/components/ToolFrame";
import { ApiError, UnauthorizedError, dyApi, type HistorySessionRow } from "./api";
import "./dy-monitor.css";

const PAGE = 50;

function pad(n: number): string {
  return String(n).padStart(2, "0");
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

export function LockNotice({ onLogin }: { onLogin: () => void }) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await dyApi.login(pwd);
      onLogin();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "登入失敗");
    }
  };
  return (
    <div className="dym-lock">
      <form className="dym-lock-panel" onSubmit={submit}>
        <div className="dym-lock-title">DOUYIN MONITOR</div>
        <div className="dym-lock-sub">// 歷史場次需要管理權限</div>
        <input
          className="dym-input"
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          placeholder="ACCESS CODE"
          autoFocus
        />
        <button className="dym-btn dym-btn-primary" type="submit" disabled={!pwd}>
          AUTHENTICATE
        </button>
        {err && <div className="dym-err">{err}</div>}
      </form>
    </div>
  );
}

export default function DyHistoryPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [rows, setRows] = useState<HistorySessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      const res = await dyApi.historySessions(PAGE, offset);
      setRows(res.sessions);
      setTotal(res.total);
      setAuthed(true);
    } catch (ex) {
      if (ex instanceof UnauthorizedError) setAuthed(false);
      else setError(ex instanceof ApiError ? ex.message : "載入失敗");
    }
  }, [offset]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = "DOUYIN MONITOR // 歷史場次";
  }, []);

  return (
    <ToolFrame title="DOUYIN MONITOR" zh="抖音直播監控台 // 歷史場次">
      <div className="dym">
        <header className="dym-head">
          <div className="dym-head-left">
            <span className="dym-anchor">歷史場次</span>
            <span className="dym-dim">共 {num(total)} 場</span>
          </div>
          <div className="dym-head-right">
            <Link className="dym-btn" to="/tools/dy-monitor">
              ◂ 回監控台
            </Link>
          </div>
        </header>

        {authed === false && <LockNotice onLogin={() => void load()} />}
        {error && <div className="dym-err">{error}</div>}

        {authed && (
          <div className="dym-panel" style={{ marginTop: 12 }}>
            <div className="dym-panel-body dym-h-wrap">
              <table className="dym-h-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>主播</th>
                    <th>開播</th>
                    <th>時長</th>
                    <th>在線 峰/均</th>
                    <th>禮物 鑽/次</th>
                    <th>聊天</th>
                    <th>進場</th>
                    <th>點讚</th>
                    <th>來源</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => nav(`/tools/dy-monitor/history/${r.id}`)}>
                      <td className="dym-dim">{r.id}</td>
                      <td>
                        {r.anchor_name || r.web_rid}
                        {r.partial ? <span className="dym-badge dym-badge-warn">中途</span> : null}
                      </td>
                      <td className="dym-dim">{dt(r.started_at)}</td>
                      <td>{dur(r.started_at, r.ended_at)}</td>
                      <td>
                        {num(r.peak_viewers)} / {Math.round(r.avg_viewers)}
                      </td>
                      <td>
                        {num(r.gift_diamonds)} / {num(r.gift_events)}
                      </td>
                      <td>{num(r.chat_count)}</td>
                      <td>{num(r.member_count)}</td>
                      <td>+{num((r.likes_end ?? 0) - (r.likes_start ?? 0))}</td>
                      <td className="dym-dim">{r.source}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="dym-empty">
                        還沒有任何場次
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {total > PAGE && (
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
                  {offset + 1}–{Math.min(offset + PAGE, total)} / {total}
                </span>
                <button
                  className="dym-btn"
                  type="button"
                  disabled={offset + PAGE >= total}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  NEXT ▸
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </ToolFrame>
  );
}
