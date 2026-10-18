// =====================================================================
//  DOUYIN MONITOR client 頁面（單頁儀表板 + 監控清單抽屜）
//  - 登入牆：沿用站上 admin session（/api/auth/*），401 一律回到鎖定畫面
//  - 2 秒輪詢 /state（cursor 增量併入彈幕）；/targets 每 15 秒刷新
//  - 選中房離線時自動抓 /replay（60 秒快取）顯示歷史回放
// =====================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  UnauthorizedError,
  dyApi,
  type ReplayPayload,
  type StatePayload,
  type TargetWithState,
} from "./api";
import "./dy-monitor.css";

type Phase = "checking" | "locked" | "open";
type ChatFilter = "all" | "chat" | "gift" | "member";

const CHAT_LIMIT = 120;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function hhmmss(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
function duration(start: number | null | undefined, end: number | null | undefined): string {
  if (!start) return "—";
  const sec = Math.max(0, (end ?? Date.now() / 1000) - start);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${pad(m)}m` : `${m}m`;
}

// ─────────────────────────── 鎖定畫面 ───────────────────────────
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
    <div className="dym-lock">
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

// ─────────────────────────── 人數曲線 ───────────────────────────
function ViewerChart({
  series,
  replay,
}: {
  series: { ts: number; viewers: number; likes: number }[];
  replay: boolean;
}) {
  const data = useMemo(() => series.slice(-240), [series]);
  const max = Math.max(1, ...data.map((d) => d.viewers));
  const w = 600;
  const h = 150;
  const points = data
    .map((d, i) => {
      const x = data.length <= 1 ? 0 : (i / (data.length - 1)) * w;
      const y = h - (d.viewers / max) * (h - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = points ? `${points} ${w},${h} 0,${h}` : "";
  const last = data[data.length - 1];
  const first = data[0];
  const delta = last && first ? last.viewers - first.viewers : 0;

  return (
    <div className="dym-chart">
      <div className="dym-chart-head">
        <span>在線人數</span>
        <span className="dym-dim">{replay ? "上場全程" : "近 5 分鐘"}</span>
        <span className={delta >= 0 ? "dym-up" : "dym-down"}>
          {delta >= 0 ? "▲" : "▼"} {num(Math.abs(delta))}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="dym-svg">
        <defs>
          <linearGradient id="dymFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(168,230,255,0.22)" />
            <stop offset="100%" stopColor="rgba(168,230,255,0)" />
          </linearGradient>
        </defs>
        {data.length > 2 && <polygon points={area} fill="url(#dymFill)" />}
        {points && <polyline points={points} fill="none" stroke="var(--ice)" strokeWidth="1.6" />}
      </svg>
      <div className="dym-chart-foot">
        <span>{data.length ? hhmmss(data[0]!.ts) : "--:--:--"}</span>
        <span>峰值 {compact(max)}</span>
        <span>{last ? hhmmss(last.ts) : "--:--:--"}</span>
      </div>
    </div>
  );
}

// ─────────────────────────── 監控清單抽屜 ───────────────────────────
function TargetDrawer({
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
  const [notifs, setNotifs] = useState<{ id: number; kind: string | null; ok: number; error: string | null; text: string | null; ts: number }[]>([]);

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
      onError(r.ok ? "測試推播已送出 ✓" : `測試推播失敗：${r.error ?? "未知"}`);
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
    <aside className={`dym-drawer${open ? " is-open" : ""}`} aria-hidden={!open}>
      <header className="dym-drawer-head">
        <span>監控清單 {targets.length}/{maxTargets}</span>
        <button className="dym-btn dym-btn-ghost" onClick={onClose} type="button">
          CLOSE
        </button>
      </header>

      <form className="dym-add" onSubmit={add}>
        <input
          className="dym-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://live.douyin.com/812195156626"
        />
        <button className="dym-btn dym-btn-primary" type="submit" disabled={busy}>
          {busy ? "…" : "ADD"}
        </button>
      </form>

      <div className="dym-targets">
        {targets.length === 0 && <div className="dym-empty">清單為空，先貼一個直播間網址</div>}
        {targets.map((t) => {
          const live = t.last_status === 2;
          return (
            <div key={t.web_rid} className={`dym-target${t.selected ? " is-sel" : ""}`}>
              <div className="dym-target-main" onClick={() => select(t.web_rid)}>
                <span className={`dym-dot${live ? " is-live" : ""}`} />
                <span className="dym-target-name">{t.anchor_name || t.label || t.web_rid}</span>
                <span className="dym-dim">{t.web_rid}</span>
                <span className="dym-badge">{t.status_text}</span>
                {t.selected && <span className="dym-badge dym-badge-ice">主畫面</span>}
              </div>
              <div className="dym-target-actions">
                <button
                  type="button"
                  className={`dym-chip${t.notify_live ? " on" : ""}`}
                  onClick={() => patch(t.web_rid, { notify_live: t.notify_live ? 0 : 1 })}
                >
                  開播
                </button>
                <button
                  type="button"
                  className={`dym-chip${t.notify_end ? " on" : ""}`}
                  onClick={() => patch(t.web_rid, { notify_end: t.notify_end ? 0 : 1 })}
                >
                  下播
                </button>
                <button
                  type="button"
                  className={`dym-chip${t.capture ? " on" : ""}`}
                  onClick={() => setExpanded(expanded === t.web_rid ? null : t.web_rid)}
                >
                  {t.capture ? `${t.caps_on}/5` : "不收錄"}
                </button>
                <button type="button" className="dym-chip dym-chip-danger" onClick={() => remove(t.web_rid)}>
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
          測試推播
        </button>
        <div className="dym-notifs">
          {notifs.length === 0 && <div className="dym-empty">尚無通知紀錄</div>}
          {notifs.map((n) => (
            <div key={n.id} className="dym-notif">
              <span className={n.ok ? "dym-up" : "dym-down"}>{n.ok ? "OK" : "FAIL"}</span>
              <span className="dym-dim">{hhmmss(n.ts)}</span>
              <span>{n.kind ?? "-"}</span>
              <span className="dym-dim dym-ellipsis">{n.ok ? (n.text ?? "").split("\n")[0] : n.error}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ─────────────────────────── 主頁面 ───────────────────────────
export default function DyMonitorPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [state, setState] = useState<StatePayload | null>(null);
  const [targets, setTargets] = useState<TargetWithState[]>([]);
  const [maxTargets, setMaxTargets] = useState(5);
  const [selectedRid, setSelectedRid] = useState("");
  const [chat, setChat] = useState<StatePayload["chat"]>([]);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState("");
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [replayAt, setReplayAt] = useState(0);

  const cursor = useRef(0);
  const selectedRef = useRef("");
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
      selectedRef.current = res.selected;
    } catch (ex) {
      if (ex instanceof UnauthorizedError) setPhase("locked");
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const h = await dyApi.health();
      setMaxTargets(Number(h.max_targets ?? 5));
    } catch {
      // health 失敗不影響主流程
    }
  }, []);

  // 認證檢查
  useEffect(() => {
    dyApi
      .me()
      .then((authed) => setPhase(authed ? "open" : "locked"))
      .catch(() => setPhase("locked"));
  }, []);

  // 選中房切換 → 重置游標與彈幕
  useEffect(() => {
    cursor.current = 0;
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
          setChat((prev) => [...prev, ...s.chat].slice(-CHAT_LIMIT));
        }
        if (s.room?.status !== 2 && s.selected_web_rid) {
          const now = Date.now();
          if (!replay || now - replayAt > 60_000) {
            try {
              const r = await dyApi.replay(s.selected_web_rid);
              if (alive) {
                setReplay(r);
                setReplayAt(now);
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

  // 清單與上限（15 秒）
  useEffect(() => {
    if (phase !== "open") return;
    void loadTargets();
    void loadHealth();
    const t = setInterval(() => void loadTargets(), 15_000);
    return () => clearInterval(t);
  }, [phase, loadTargets, loadHealth]);

  if (phase === "checking") return <div className="dym-loading">ESTABLISHING LINK…</div>;
  if (phase === "locked") return <LockPanel onUnlocked={() => setPhase("open")} />;

  const isReplay = Boolean(replay) && state?.room?.status !== 2;
  const room = (isReplay ? replay!.session : state?.room ?? {}) as Record<string, unknown>;
  const series = isReplay ? replay!.series : state?.series ?? [];
  const rank = (isReplay ? replay!.rank : state?.rank ?? []) as StatePayload["rank"];
  const fans = (isReplay ? replay!.fans ?? {} : state?.fans ?? {}) as StatePayload["fans"];
  const fansMeta = (isReplay ? replay!.fans ?? {} : state?.fans_meta ?? {}) as StatePayload["fans_meta"];
  const gifts = isReplay ? replay!.gifts : state?.gifts ?? { total_diamonds: 0, events: 0, catalog: 0, top: [] };
  const chatRows = isReplay
    ? replay!.chat.map((c) => ({ ...c, id: 0, nickname: c.nickname ?? "", gift_name: c.gift_name ?? "" }))
    : chat;

  const filteredChat = chatRows.filter((c) =>
    filter === "all"
      ? true
      : filter === "chat"
        ? c.type === "Chat"
        : filter === "gift"
          ? c.type === "Gift"
          : c.type === "Member" || c.type === "Like"
  );

  const status = Number(room.status ?? state?.room?.status ?? 0);
  const live = status === 2;
  const viewerCount = Number(room.viewers ?? 0);
  const likeCount = Number(room.like_count ?? 0);
  const inter = state?.inter;

  return (
    <div className="dym">
      {toast && <div className="dym-toast">{toast}</div>}

      <header className="dym-head">
        <div className="dym-head-left">
          <span className={`dym-live${live ? " is-live" : ""}`}>{live ? "● LIVE" : "○ OFFLINE"}</span>
          <span className="dym-anchor">{(room.anchor_name as string) || "未選擇房間"}</span>
          <span className="dym-title">{String(room.title ?? "")}</span>
        </div>
        <div className="dym-head-right">
          {isReplay && (
            <span className="dym-badge dym-badge-replay">
              ◷ 歷史回放 {room.started_at ? hhmmss(Number(room.started_at)) : ""}–
              {room.ended_at ? hhmmss(Number(room.ended_at)) : ""}
            </span>
          )}
          {!state?.api.abogus && <span className="dym-badge dym-badge-warn">榜單待啟用</span>}
          <button className="dym-btn" type="button" onClick={() => setDrawer(true)}>
            ☰ 監控清單 {targets.length}
          </button>
        </div>
      </header>

      <section className="dym-kpis">
        {[
          { label: "在線人數", value: compact(viewerCount), sub: String(room.viewer_text ?? "") },
          { label: "本場點讚", value: compact(likeCount), sub: `+${num(inter?.likes_per_min ?? 0)}/分` },
          { label: "累計觀眾", value: String(room.total_user ?? "—"), sub: "整場" },
          { label: "禮物", value: num(gifts.total_diamonds), sub: `${num(gifts.events)} 次 · 鑽` },
          { label: "彈幕", value: num(inter?.chat ?? 0), sub: `${num(inter?.chat_users ?? 0)} 人 · ${inter?.chat_per_min ?? 0}/分` },
          { label: "進場", value: num(inter?.member ?? 0), sub: `${inter?.member_per_min ?? 0}/分` },
        ].map((k) => (
          <div key={k.label} className="dym-kpi">
            <div className="dym-kpi-label">{k.label}</div>
            <div className="dym-kpi-value">{k.value}</div>
            <div className="dym-kpi-sub">{k.sub}</div>
          </div>
        ))}
      </section>

      <section className="dym-grid">
        <div className="dym-panel dym-panel-chart">
          <ViewerChart series={series} replay={isReplay} />
        </div>

        <div className="dym-panel dym-panel-chat">
          <div className="dym-panel-head">
            <span>彈幕</span>
            <div className="dym-filters">
              {(["all", "chat", "gift", "member"] as ChatFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`dym-chip${filter === f ? " on" : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "全部" : f === "chat" ? "聊天" : f === "gift" ? "禮物" : "進場"}
                </button>
              ))}
            </div>
          </div>
          <div className="dym-panel-body dym-chat">
            {filteredChat.length === 0 && <div className="dym-empty">沒有訊息</div>}
            {filteredChat.map((c, i) => (
              <div key={`${c.id}-${i}`} className={`dym-chat-row dym-t-${c.type}`}>
                <span className="dym-dim">{hhmmss(c.ts)}</span>
                <span className="dym-nick">{c.nickname || "—"}</span>
                <span className="dym-content">{c.content}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dym-panel">
          <div className="dym-panel-head">
            <span>粉絲團親密度</span>
            <span className="dym-dim">{isReplay ? "上場最後快照" : `${fansMeta.club_name ?? fans.club_name ?? ""}`}</span>
          </div>
          <div className="dym-panel-body">
            <div className="dym-fans-meta">
              <span>活躍 {num(fans.active)}</span>
              <span>總數 {num(fans.total)}</span>
              {fansMeta.today_new !== undefined && <span>今日 +{num(fansMeta.today_new)}</span>}
            </div>
            {(fans.members ?? []).slice(0, 10).map((m, i) => (
              <div key={`${m.nickname}-${i}`} className="dym-rank-row">
                <span className="dym-rank-idx">{i + 1}</span>
                <span className="dym-nick">{m.nickname}</span>
                <span className="dym-dim">Lv.{m.level}</span>
                <span className="dym-rank-score">{compact(m.intimacy)}</span>
              </div>
            ))}
            {(fans.members ?? []).length === 0 && <div className="dym-empty">沒有親密度資料</div>}
          </div>
        </div>

        <div className="dym-panel">
          <div className="dym-panel-head">
            <span>在線觀眾榜</span>
            <span className="dym-dim">{state?.api.rank_ok ? "即時" : "待啟用"}</span>
          </div>
          <div className="dym-panel-body">
            {rank.length === 0 && (
              <div className="dym-empty">
                {state?.api.abogus ? "榜單暫無資料" : "P2 才會啟用 a_bogus 簽名（觀眾榜）"}
              </div>
            )}
            {rank.slice(0, 10).map((m, i) => (
              <div key={`${m.nickname}-${i}`} className="dym-rank-row">
                <span className="dym-rank-idx">{m.rank ?? i + 1}</span>
                <span className="dym-nick">{m.nickname}</span>
                <span className="dym-dim">付費 Lv.{m.pay_level}</span>
                <span className="dym-dim">粉 Lv.{m.fans_level}</span>
                {m.guard && <span className="dym-badge dym-badge-ice">守護</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="dym-panel">
          <div className="dym-panel-head">
            <span>送禮貢獻榜</span>
            <span className="dym-dim">{num(gifts.total_diamonds)} 鑽</span>
          </div>
          <div className="dym-panel-body">
            {gifts.top.length === 0 && <div className="dym-empty">本場尚無禮物</div>}
            {gifts.top.map((g, i) => (
              <div key={`${g.nickname}-${i}`} className="dym-rank-row">
                <span className="dym-rank-idx">{i + 1}</span>
                <span className="dym-nick">{g.nickname}</span>
                <span className="dym-dim">{num(g.count)} 次</span>
                <span className="dym-rank-score">{num(g.diamonds)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dym-panel dym-panel-status">
          <div className="dym-panel-head">
            <span>SYSTEM</span>
            <span className="dym-dim">uptime {Math.floor((state?.uptime ?? 0) / 60)}m</span>
          </div>
          <div className="dym-panel-body dym-status">
            <div>
              輪詢 <b>{state?.intervals.stats ?? "—"}s</b> · 彈幕 <b>{state?.intervals.chat ?? "—"}s</b> · 榜單{" "}
              <b>{state?.intervals.rank ?? "—"}s</b>
            </div>
            <div>
              DB <b>{state?.db.size_mb ?? "—"} MB</b>
              {state?.db.warning && <span className="dym-badge dym-badge-warn">容量警告</span>} · 場次{" "}
              <b>#{state?.db.session_id ?? "—"}</b>
            </div>
            <div>
              彈幕 API <b className={state?.api.chat_ok ? "dym-up" : "dym-down"}>{state?.api.chat_ok ? "OK" : "FAIL"}</b>{" "}
              · 榜單 API{" "}
              <b className={state?.api.rank_ok ? "dym-up" : "dym-down"}>{state?.api.rank_ok ? "OK" : "—"}</b>
            </div>
            {(state?.errors ?? []).slice(0, 3).map((e, i) => (
              <div key={i} className="dym-down dym-ellipsis">
                {hhmmss(e.ts)} {e.msg}
              </div>
            ))}
            {isReplay && (
              <div className="dym-dim">
                回放場次 #{replay!.session.id} · {duration(replay!.session.started_at, replay!.session.ended_at)} ·{" "}
                {num(replay!.session.chat_count)} 則彈幕
              </div>
            )}
          </div>
        </div>
      </section>

      <TargetDrawer
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
