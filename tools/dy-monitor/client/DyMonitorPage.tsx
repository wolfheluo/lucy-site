// =====================================================================
//  DOUYIN MONITOR 儀表板（版面/色彩照 Python 原版 templates/index.html）
//  結構：topbar（網址切換＋狀態＋清單）→ 6 卡 → 3×2 主區 → footer
//  · 左上 在線人數曲線 / 左下 在線觀眾 Top10 / 中間 即時彈幕（跨兩列）
//  · 右上 粉絲團親密度 / 右下 貢獻榜（送禮・本場累計）
//  資料：2 秒輪詢 /state（cursor 增量）；離線時抓 /replay（60 秒快取）
// =====================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  UnauthorizedError,
  dyApi,
  type ReplayPayload,
  type StatePayload,
  type TargetWithState,
} from "./api";
import { parseRid } from "./room";
import "./dy-monitor.css";

type ChatFilter = "all" | "Chat" | "Member" | "Gift";
const CHAT_LIMIT = 400;
const TYPE_LABEL: Record<string, string> = { Chat: "聊天", Member: "進場", Gift: "禮物", Like: "點讚" };
const TYPE_FALLBACK: Record<string, string> = {
  Member: "進入了直播間",
  Gift: "送出了禮物",
  Like: "點讚了主播",
};
const GIFT_MUTED = ["粉丝团灯牌", "点亮粉丝团"];

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (n: number | null | undefined) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US");
const hhmmss = (t?: number | null) => {
  if (!t) return "尚未更新";
  const d = new Date(t * 1000);
  return `更新於 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtDate = (t?: number | null) => {
  if (!t) return "—";
  const d = new Date(t * 1000);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isMutedGift = (m: { gift_name?: string | null; content?: string | null }) =>
  GIFT_MUTED.some((k) => (m.gift_name ?? "").includes(k) || (m.content ?? "").includes(k));

interface ChatItem {
  id?: number;
  type: string;
  nickname: string;
  content: string;
  gift_name?: string | null;
  diamonds?: number | null;
  ts: number;
}

// ── 鎖定畫面 ────────────────────────────────────────────────
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
      onUnlocked();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dym dym-lock">
      <form className="dym-lock-panel" onSubmit={submit}>
        <div className="dym-lock-title">DOUYIN MONITOR</div>
        <div className="dym-lock-sub">// 需要管理權限</div>
        <input
          className="dym-input"
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          placeholder="ACCESS CODE"
          autoFocus
        />
        <button className="dym-btn dym-btn-primary" type="submit" disabled={busy || !pwd}>
          {busy ? "驗證中…" : "AUTHENTICATE"}
        </button>
        {err && <div className="dym-err">{err}</div>}
      </form>
    </div>
  );
}

// ── 人數曲線（原版 viewBox 800×240）─────────────────────────
function Chart({ series }: { series: { ts: number; viewers: number }[] }) {
  const data = series.slice(-240);
  const W = 800;
  const H = 240;
  const max = Math.max(1, ...data.map((d) => d.viewers));
  const pts = data
    .map((d, i) => {
      const x = data.length <= 1 ? 0 : (i / (data.length - 1)) * W;
      const y = H - (d.viewers / max) * (H - 16) - 8;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = pts ? `${pts} ${W},${H} 0,${H}` : "";
  return (
    <div className="dym-chartwrap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="dym-svg">
        <defs>
          <linearGradient id="dymFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(0,229,255,0.28)" />
            <stop offset="100%" stopColor="rgba(0,229,255,0)" />
          </linearGradient>
        </defs>
        {data.length > 2 && <polygon points={area} fill="url(#dymFill)" />}
        {pts && (
          <polyline points={pts} fill="none" stroke="var(--cyan)" strokeWidth="2" strokeLinejoin="round" />
        )}
      </svg>
      <div className="dym-chartaxis">
        <span>{data.length ? fmtDate(data[0]!.ts).slice(-11) : "--:--"}</span>
        <span>峰值 {fmt(max)}</span>
        <span>{data.length ? fmtDate(data[data.length - 1]!.ts).slice(-11) : "--:--"}</span>
      </div>
    </div>
  );
}

// ── 監控清單抽屜（原版 drawer）──────────────────────────────
function Drawer({
  open,
  targets,
  maxTargets,
  onClose,
  onChanged,
  onError,
}: {
  open: boolean;
  targets: TargetWithState[];
  maxTargets: number;
  onClose: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notifs, setNotifs] = useState<
    { id: number; kind: string | null; ok: number; error: string | null; text: string | null; ts: number }[]
  >([]);

  const refreshNotifs = useCallback(() => {
    dyApi
      .notifications(8)
      .then((r) => setNotifs(r.notifications))
      .catch(() => setNotifs([]));
  }, []);

  useEffect(() => {
    if (open) refreshNotifs();
  }, [open, refreshNotifs]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const res = await dyApi.addTarget(url.trim());
      setUrl("");
      onChanged();
      onError(`已加入：${res.target.anchor_name || res.target.web_rid}`);
    } catch (ex) {
      onError(ex instanceof ApiError ? ex.message : "加入失敗");
    } finally {
      setBusy(false);
    }
  };

  const patch = async (rid: string, body: Record<string, unknown>) => {
    try {
      await dyApi.patchTarget(rid, body);
      onChanged();
    } catch (ex) {
      onError(ex instanceof ApiError ? ex.message : "更新失敗");
    }
  };

  const remove = async (rid: string) => {
    try {
      await dyApi.deleteTarget(rid);
      onChanged();
    } catch (ex) {
      onError(ex instanceof ApiError ? ex.message : "刪除失敗");
    }
  };

  const select = async (rid: string) => {
    try {
      await dyApi.selectTarget(rid);
      onChanged();
      onClose();
    } catch (ex) {
      onError(ex instanceof ApiError ? ex.message : "切換失敗");
    }
  };

  const test = async () => {
    try {
      const r = await dyApi.testPush();
      onError(r.ok ? "測試推送已送出 ✓" : `測試推送失敗：${r.error ?? "未知"}`);
      refreshNotifs();
    } catch (ex) {
      onError(ex instanceof ApiError ? ex.message : "測試失敗");
    }
  };

  const CAPS: { key: string; label: string }[] = [
    { key: "cap_chat", label: "聊天" },
    { key: "cap_gift", label: "禮物" },
    { key: "cap_member", label: "進場點讚" },
    { key: "cap_snap", label: "快照" },
    { key: "cap_rank", label: "榜單" },
  ];

  return (
    <>
      <div className={`dym-mask${open ? " is-open" : ""}`} onClick={onClose} aria-hidden="true" />
      <aside className={`dym-drawer${open ? " is-open" : ""}`} aria-hidden={!open}>
        <div className="dym-drawer-head">
          <h2>監控清單 {targets.length}/{maxTargets}</h2>
          <button className="dym-x" type="button" onClick={onClose}>
            ✕
          </button>
        </div>

        <form className="dym-roomform" onSubmit={add}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="貼上直播間網址，例如 https://live.douyin.com/123456789"
            spellCheck={false}
          />
          <button type="submit" disabled={busy}>
            {busy ? "…" : "加入"}
          </button>
        </form>
        <p className="dym-drawer-hint">
          點列＝切換主畫面到該房（選中房強制收錄）；右側開關控制通知與收錄。
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {targets.length === 0 && <div className="dym-empty">清單為空，先貼一個直播間網址</div>}
          {targets.map((t) => {
            const live = t.last_status === 2;
            return (
              <div key={t.web_rid} className={`dym-trow${t.selected ? " sel" : ""}`}>
                <div className="dym-tinfo" onClick={() => select(t.web_rid)}>
                  <span className="dym-tname">{t.anchor_name || t.label || t.web_rid}</span>
                  <span className="dym-trid">{t.web_rid}</span>
                  <span className={`dym-badge ${live ? "live" : "off"}`}>{t.status_text}</span>
                  {t.selected && <span className="dym-seltag">主畫面</span>}
                </div>
                <div className="dym-switches">
                  <button
                    type="button"
                    className={`dym-tg${t.notify_live ? " on" : ""}`}
                    onClick={() => patch(t.web_rid, { notify_live: t.notify_live ? 0 : 1 })}
                    aria-label="開播通知"
                  >
                    <i />
                  </button>
                  <span className="dym-tg-label">開播</span>
                  <button
                    type="button"
                    className={`dym-tg${t.notify_end ? " on" : ""}`}
                    onClick={() => patch(t.web_rid, { notify_end: t.notify_end ? 0 : 1 })}
                    aria-label="下播通知"
                  >
                    <i />
                  </button>
                  <span className="dym-tg-label">下播</span>
                  <button
                    type="button"
                    className={`dym-chip${t.capture ? " on" : ""}`}
                    onClick={() => setExpanded(expanded === t.web_rid ? null : t.web_rid)}
                    title="收錄細項"
                  >
                    {t.capture ? `收錄 ${t.caps_on}/5` : "不收錄"}
                  </button>
                  <button
                    type="button"
                    className="dym-chip danger"
                    onClick={() => remove(t.web_rid)}
                    title="移除"
                  >
                    移除
                  </button>
                </div>
                {expanded === t.web_rid && (
                  <div className="dym-caps">
                    {CAPS.map((c) => {
                      const on = Number((t as unknown as Record<string, number>)[c.key] ?? 0);
                      return (
                        <button
                          key={c.key}
                          type="button"
                          className={`dym-chip${on ? " on" : ""}`}
                          onClick={() => patch(t.web_rid, { [c.key]: on ? 0 : 1 })}
                        >
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="dym-drawer-foot">
          <button className="dym-btn" type="button" onClick={test}>
            測試推送
          </button>
          <h3 style={{ margin: "12px 0 6px", fontSize: 12, letterSpacing: 1, color: "#8ba2b4" }}>
            最近通知
          </h3>
          <div className="dym-notifs">
            {notifs.length === 0 && <div className="dym-empty">尚無紀錄</div>}
            {notifs.map((n) => (
              <div key={n.id} className="dym-nrow">
                <span className={n.ok ? "good" : "bad"}>{n.ok ? "OK" : "FAIL"}</span>
                <span>{hhmmss(n.ts).replace("更新於 ", "")}</span>
                <span>{n.kind ?? "-"}</span>
                <span className="dym-ellipsis">
                  {n.ok ? (n.text ?? "").split("\n")[0] : n.error}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}

// ── 主頁面 ──────────────────────────────────────────────────
export default function DyMonitorPage() {
  const [phase, setPhase] = useState<"checking" | "locked" | "open">("checking");
  const [state, setState] = useState<StatePayload | null>(null);
  const [targets, setTargets] = useState<TargetWithState[]>([]);
  const [maxTargets, setMaxTargets] = useState(5);
  const [selectedRid, setSelectedRid] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState("");
  const [roomUrl, setRoomUrl] = useState("");
  const [switching, setSwitching] = useState(false);
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [replayAt, setReplayAt] = useState(0);

  const cursor = useRef(0);
  const likesRef = useRef<{ last: number | null; delta: number }>({ last: null, delta: 0 });
  const chatBox = useRef<HTMLDivElement | null>(null);
  const stickBottom = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }, []);

  const loadTargets = useCallback(async () => {
    try {
      const res = await dyApi.targets();
      setTargets(res.targets);
      setSelectedRid(res.selected);
      const sel = res.targets.find((t) => t.web_rid === res.selected);
      if (sel && !roomUrl) setRoomUrl(`https://live.douyin.com/${res.selected}`);
    } catch (ex) {
      if (ex instanceof UnauthorizedError) setPhase("locked");
    }
    // roomUrl 只做初始值，避免覆寫使用者輸入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const h = await dyApi.health();
      setMaxTargets(Number(h.max_targets ?? 5));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    dyApi
      .me()
      .then((authed) => setPhase(authed ? "open" : "locked"))
      .catch(() => setPhase("locked"));
  }, []);

  // 選中房切換 → 重置游標與彈幕
  useEffect(() => {
    cursor.current = 0;
    likesRef.current = { last: null, delta: 0 };
    setChat([]);
    setReplay(null);
    setReplayAt(0);
  }, [selectedRid]);

  // 2 秒輪詢
  useEffect(() => {
    if (phase !== "open") return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await dyApi.state(cursor.current);
        if (!alive) return;
        cursor.current = s.chat_cursor;
        setState(s);
        if (s.chat.length > 0) {
          setChat((prev) => {
            const next = [...prev, ...(s.chat as unknown as ChatItem[])];
            return next.slice(-CHAT_LIMIT);
          });
        }
        if (s.room?.status !== 2 && s.selected_web_rid) {
          const now = Date.now();
          if (!replay || now - replayAt > 60_000) {
            try {
              const r = await dyApi.replay(s.selected_web_rid);
              if (alive) {
                setReplay(r);
                setReplayAt(now);
                if (r.ok) {
                  setChat(
                    (r.chat ?? []).map((c, i) => ({
                      id: i,
                      type: c.type,
                      nickname: c.nickname ?? "",
                      content: c.content ?? "",
                      gift_name: c.gift_name,
                      diamonds: c.diamonds,
                      ts: c.ts,
                    }))
                  );
                }
              }
            } catch {
              if (alive) setReplay(null);
            }
          }
        } else if (replay) {
          setReplay(null);
        }
      } catch (ex) {
        if (ex instanceof UnauthorizedError) setPhase("locked");
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, replay, replayAt]);

  useEffect(() => {
    if (phase !== "open") return;
    void loadTargets();
    void loadHealth();
    const t = setInterval(() => void loadTargets(), 15_000);
    return () => clearInterval(t);
  }, [phase, loadTargets, loadHealth]);

  // 彈幕自動貼底
  useEffect(() => {
    const box = chatBox.current;
    if (box && stickBottom.current) box.scrollTop = box.scrollHeight;
  }, [chat, filter]);

  const switchRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const rid = parseRid(roomUrl);
    if (!rid) {
      notify("網址裡找不到直播間號");
      return;
    }
    setSwitching(true);
    try {
      await dyApi.selectTarget(rid);
      await loadTargets();
      notify(`已切換到 ${rid}`);
    } catch (ex) {
      notify(ex instanceof ApiError ? ex.message : "切換失敗");
    } finally {
      setSwitching(false);
    }
  };

  if (phase === "checking") return <div className="dym-loading">ESTABLISHING LINK…</div>;
  if (phase === "locked") return <LockPanel onUnlocked={() => setPhase("open")} />;

  // ── 顯示資料：即時 or 回放 ──
  const live = state?.room?.status === 2;
  const isReplay = !live && Boolean(replay?.ok);
  const rp = replay;
  const room = state?.room ?? {};
  const series = isReplay ? (rp?.series ?? []) : (state?.series ?? []);
  const rank = isReplay ? (rp?.rank ?? []) : (state?.rank ?? []);
  const fans = isReplay ? rp?.fans ?? null : state?.fans ?? null;
  const fansMeta = isReplay ? rp?.fans ?? {} : state?.fans_meta ?? {};
  const giftTop = isReplay
    ? (rp?.gifts.top ?? [])
    : (state?.gifts.top ?? []).map((g) => ({ nickname: g.nickname, diamonds: g.diamonds, count: g.count }));
  const giftTotal = isReplay ? (rp?.gifts.total_diamonds ?? 0) : (state?.gifts.total_diamonds ?? 0);
  const giftEvents = isReplay ? (rp?.gifts.events ?? 0) : (state?.gifts.events ?? 0);
  const catalogSize = state?.gifts.catalog ?? 0;
  const inter = state?.inter;

  const statusText = isReplay
    ? "已下播（回放）"
    : state?.loading
      ? "載入中…"
      : String(room.status_text ?? "未知");
  const statusLive = !isReplay && Number(room.status) === 2;

  // 點讚增量（本次監控累計，對照原版 likedelta）
  const likeCount = Number(room.like_count ?? 0);
  if (!isReplay) {
    if (likesRef.current.last !== null) {
      const d = likeCount - likesRef.current.last;
      if (d > 0) likesRef.current.delta += d;
    }
    likesRef.current.last = likeCount;
  }

  const chatView = chat.filter((m) => {
    if (filter === "all") return true;
    if (filter === "Gift") return m.type === "Gift" && !isMutedGift(m);
    return m.type === filter;
  });
  const mutedCount = chat.filter(isMutedGift).length;
  const chatCountText =
    filter === "all"
      ? `${chat.length} 則`
      : `${chatView.length} 則 / 共 ${chat.length}` +
        (filter === "Gift" && mutedCount ? `（已濾粉絲團 ${mutedCount}）` : "");

  const up = state?.uptime ?? 0;
  const upStr = `${Math.floor(up / 3600)}:${pad(Math.floor((up % 3600) / 60))}:${pad(up % 60)}`;
  const apiOk = Boolean(state?.api.chat_ok && state?.api.rank_ok);
  const firstError = state?.errors?.[0]?.msg;

  return (
    <div className="dym dym-dash">
      {toast && <div className="dym-toast">{toast}</div>}

      {/* ── 頂欄 ── */}
      <header className="dym-topbar">
        <form className="dym-roomform" onSubmit={switchRoom} autoComplete="off">
          <input
            value={roomUrl}
            onChange={(e) => setRoomUrl(e.target.value)}
            placeholder="貼上直播間網址，例如 https://live.douyin.com/123456789"
            spellCheck={false}
          />
          <button type="submit" disabled={switching}>
            切換監控
          </button>
        </form>

        {isReplay && (
          <span className="dym-replaytag">
            ◷ 歷史回放 {fmtDate(rp?.session.started_at)}–{fmtDate(rp?.session.ended_at)}
            {rp?.session.partial ? "（中途開始）" : ""}
          </span>
        )}

        <div className={`dym-status${statusLive ? " is-live" : " is-off"}`}>
          <i className="dot" />
          <span>{statusLive ? "直播中" : statusText}</span>
        </div>

        <Link className="dym-btn" to="/tools/dy-monitor/history">
          場次複盤
        </Link>
        <button className="dym-btn" type="button" onClick={() => setDrawer(true)}>
          ☰ 監控清單 <b>{targets.length}</b>
        </button>
      </header>

      {/* ── 6 張資訊卡（原版欄位）── */}
      <section className="dym-cards">
        <article className="dym-card">
          <h3>開播狀態</h3>
          <p className="val" style={{ color: statusLive ? "var(--lime)" : "var(--magenta)" }}>
            {statusText}
          </p>
          <small className="sub">{String(room.title ?? "（無標題）")}</small>
        </article>
        <article className="dym-card">
          <h3>在線人數</h3>
          <p className="val">{isReplay ? fmt(Number(rp?.session.peak_viewers ?? 0)) : fmt(Number(room.viewers ?? 0))}</p>
          <small className="sub">
            {isReplay
              ? `上場峰值 · 平均 ${fmt(Math.round(Number(rp?.session.avg_viewers ?? 0)))}`
              : String(room.viewers_desc || (room.viewer_text ? `顯示：${room.viewer_text}` : "—")) +
                (state?.stale ? "（資料延遲中）" : "")}
          </small>
        </article>
        <article className="dym-card">
          <h3>本場點讚</h3>
          <p className="val">{fmt(Number(room.like_count ?? 0))}</p>
          <small className="sub">
            {isReplay
              ? `本場 +${fmt(Number(rp?.session.likes_end ?? 0) - Number(rp?.session.likes_start ?? 0))}`
              : `本次監控 +${fmt(likesRef.current.delta)}`}
          </small>
        </article>
        <article className="dym-card">
          <h3>總觀看人次</h3>
          <p className="val">{String(room.total_user || "—")}</p>
          <small className="sub">本場累計進房人次</small>
        </article>
        <article className="dym-card">
          <h3>本場禮物總值</h3>
          <p className="val">{fmt(giftTotal)}</p>
          <small className="sub">
            {fmt(giftEvents)} 次{catalogSize ? ` · 目錄 ${fmt(catalogSize)}` : ""}
          </small>
        </article>
        <article className="dym-card">
          <h3>主播</h3>
          <p className="val sm">{String(room.anchor_name || "—")}</p>
          <small className="sub">直播間 {String(room.web_rid || selectedRid || "—")}</small>
        </article>
      </section>

      {/* ── 主區 3×2 ── */}
      <main className="dym-main">
        <section className="dym-panel dym-p-chart">
          <div className="dym-phead">
            <h2>在線人數曲線</h2>
            <span className="dym-hint">{isReplay ? "上場全程" : "近 5 分鐘"}</span>
          </div>
          <Chart series={series} />
        </section>

        <section className="dym-panel dym-p-rank">
          <div className="dym-phead">
            <h2>在線觀眾 Top 10</h2>
            <span className="dym-hint">
              {state?.api.abogus ? `30 秒更新 · ${hhmmss(state?.ts.rank)}` : "榜單未啟用"}
            </span>
          </div>
          <div className="dym-tablewrap">
            <table className="dym-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>觀眾</th>
                  <th className="num">付費等級</th>
                  <th className="num">粉絲團</th>
                </tr>
              </thead>
              <tbody>
                {rank.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      {state?.api.abogus ? "尚無觀眾資料" : "P2 簽名未啟用，榜單暫停"}
                    </td>
                  </tr>
                ) : (
                  rank.map((r, i) => (
                    <tr key={`${r.nickname}-${i}`}>
                      <td>{r.rank ?? i + 1}</td>
                      <td>
                        {r.nickname || "匿名"}
                        {r.guard ? " 🛡" : ""}
                      </td>
                      <td className="num">{r.pay_level ? `Lv${r.pay_level}` : "—"}</td>
                      <td className="num">{r.fans_level ? `Lv${r.fans_level}` : "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dym-panel dym-p-chat">
          <div className="dym-phead">
            <h2>即時彈幕</h2>
            <div className="dym-tabs">
              {(["all", "Member", "Gift", "Chat"] as ChatFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`dym-tab${filter === f ? " active" : ""}`}
                  data-filter={f}
                  onClick={() => {
                    setFilter(f);
                    stickBottom.current = true;
                  }}
                >
                  {f === "all" ? "全部" : TYPE_LABEL[f]}
                </button>
              ))}
            </div>
            <span className="dym-hint">{chatCountText}</span>
            <span className="dym-hint">
              {inter
                ? `${fmt(inter.chat)} 則｜發言 ${fmt(inter.chat_users)} 人｜${inter.chat_per_min}/分｜進場 ${inter.member_per_min}/分｜讚 ${inter.likes_per_min}/分`
                : "—"}
            </span>
          </div>
          <div
            className="dym-chat"
            ref={chatBox}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {chatView.length === 0 ? (
              <div className="dym-empty">
                {chat.length ? "此分類目前沒有訊息" : "等待彈幕…（約 4 秒後開始）"}
              </div>
            ) : (
              chatView.slice(-200).map((m, i) => (
                <div key={m.id ?? i} className={`dym-crow${isMutedGift(m) ? " is-gift" : ""}`}>
                  <span className={`dym-tag ${m.type}`}>{TYPE_LABEL[m.type] ?? m.type}</span>
                  <span className="dym-who">{m.nickname || "匿名"}</span>
                  <span className="dym-say">{m.content || TYPE_FALLBACK[m.type] || ""}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="dym-panel dym-p-fans">
          <div className="dym-phead">
            <h2>粉絲團親密度榜</h2>
            <span className="dym-hint">
              {isReplay ? "上場最後快照" : `60 秒更新 · ${hhmmss(state?.ts.fans)}`}
            </span>
          </div>
          <div className="dym-fans-meta">
            活躍 <b>{fmt(fans?.active)}</b> ｜ 總數 <b>{fmt(fans?.total)}</b>
            {fansMeta.today_new !== undefined ? ` ｜ 今日 +${fmt(fansMeta.today_new)}` : ""}
            {fans?.club_name ? ` ｜ ${fans.club_name}` : ""}
          </div>
          <div className="dym-tablewrap">
            <table className="dym-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>團員</th>
                  <th className="num">親密度</th>
                  <th className="num">等級</th>
                </tr>
              </thead>
              <tbody>
                {(fans?.members ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      尚無資料
                    </td>
                  </tr>
                ) : (
                  (fans?.members ?? []).slice(0, 10).map((m, i) => (
                    <tr key={`${m.nickname}-${i}`}>
                      <td>{i + 1}</td>
                      <td>{m.nickname}</td>
                      <td className="num">{fmt(m.intimacy)}</td>
                      <td className="num">Lv{m.level}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dym-panel dym-p-gifters">
          <div className="dym-phead">
            <h2>貢獻榜（送禮・本場累計）</h2>
            <span className="dym-hint">
              {isReplay
                ? `上場 ${fmt(giftEvents)} 次 · ${fmt(giftTotal)} 鑽`
                : `自建統計 · ${fmt(giftEvents)} 次`}
            </span>
          </div>
          <div className="dym-tablewrap">
            <table className="dym-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>觀眾</th>
                  <th className="num">鑽石</th>
                  <th className="num">次數</th>
                </tr>
              </thead>
              <tbody>
                {giftTop.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      尚無送禮紀錄
                    </td>
                  </tr>
                ) : (
                  giftTop.slice(0, 10).map((g, i) => (
                    <tr key={`${g.nickname}-${i}`}>
                      <td>{i + 1}</td>
                      <td>{g.nickname || "匿名"}</td>
                      <td className="num">{fmt(g.diamonds)}</td>
                      <td className="num">{fmt(g.count)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* ── 頁尾（原版 foot）── */}
      <footer className="dym-foot">
        <span>
          輪詢 {state?.intervals.stats ?? "—"}s ｜ 彈幕 {state?.intervals.chat ?? "—"}s ｜ 貢獻榜{" "}
          {state?.intervals.rank ?? "—"}s ｜ 親密度 {state?.intervals.fans ?? "—"}s ｜ 純 API
        </span>
        <span>
          {firstError ? (
            <span className="err">⚠ {firstError}｜運行 {upStr}</span>
          ) : (
            <>
              API {apiOk ? "OK" : "連線中…"} ｜ 運行 {upStr} ｜ DB {state?.db.size_mb ?? "—"}MB
              {state?.db.session_id ? ` ｜ 場次 #${state.db.session_id}` : ""}
            </>
          )}
        </span>
        <Link to="/tools/dy-monitor/history">場次複盤 →</Link>
      </footer>

      <Drawer
        open={drawer}
        targets={targets}
        maxTargets={maxTargets}
        onClose={() => setDrawer(false)}
        onChanged={() => void loadTargets()}
        onError={notify}
      />
    </div>
  );
}
