// =====================================================================
//  BINANCE QUANT client 主頁面 —— FUI 儀表板
//  GRAPH CONTROL 雷達 / KILL SWITCH / FAILURE MATRIX / ACCOUNT /
//  VERIFICATION LEDGER / DASHBOARD VS GROUND TRUTH
//  資料通道：/state 初始化 + SSE（/stream）每 update 帶完整 state + delta feed
//  canvas 手刻（零依賴）：雷達 rAF 連續（掃描線）、趨勢線資料驅動重繪
// =====================================================================
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useReducedMotion } from "framer-motion";
import type { MonitorSnapshot, PanelUpdate } from "../types";
import { binanceApi } from "./api";
import {
  fmtClock,
  fmtCompact,
  fmtHold,
  fmtInt,
  fmtPrice,
  fmtQty,
  fmtRate,
  fmtSigned,
  fmtUsdt,
} from "./format";
import "./binance.css";

/* ── 常數 ─────────────────────────────────────────────────────── */
const TRADE_CAP = 140;
const LEDGER_CAP = 200;
const HIST_SECONDS = 120; // 趨勢線樣本深度
const TAPE_BUF = 200; // 成交流緩衝（buffer 全留，DOM 只渲染前段）
const TAPE_DOM = 56; // tape 實際渲染行數（其餘下沉出容器被 mask 裁掉）

interface HistPoint {
  ts: number;
  price: number;
  score: number;
  cvd: number;
  oi: number;
  depth: number;
}

interface RadarFlash {
  id: number;
  at: number; // 注入時刻（ms）
  kind: "alert" | "entry" | "exit";
  side: "BUY" | "SELL" | "LONG" | "SHORT";
  amount: number;
}

interface LedgerRow {
  id: number;
  ts: number;
  code: string;
  info: string;
  cls: string;
  st: string;
}

interface FeedState {
  trades: FeedTrade[];
  alerts: FeedAlert[];
  signals: FeedSignal[];
}
interface FeedTrade {
  t: number;
  p: number;
  q: number;
  m: boolean;
}
interface FeedAlert {
  t: number;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  totalUsdt: number;
}
interface FeedSignal {
  t: number;
  strategy: string;
  action: "ENTRY" | "EXIT";
  side: string;
  price: number;
  qty: number;
  pnl: number;
  reason: string;
}

function emptyFeed(): FeedState {
  return { trades: [], alerts: [], signals: [] };
}
function mergeFeed(prev: FeedState, delta: FeedState): FeedState {
  return {
    trades: [...delta.trades, ...prev.trades].slice(0, TRADE_CAP),
    alerts: [...delta.alerts, ...prev.alerts].slice(0, 30),
    signals: [...delta.signals, ...prev.signals].slice(0, 40),
  };
}

let rowSeq = 1;

/* =================================================================
   GRAPH CONTROL —— 六軸雷達 canvas（rAF 連續、掃描線、事件爆閃）
   ================================================================= */
const RADAR_LABELS = ["CVD", "DIR", "DEPTH", "OI", "LIQ", "PRICE"] as const;

interface TapeRow {
  id: number;
  t: number;
  p: number;
  q: number;
  m: boolean;
  vol: number; // 0-100 量能條
}

interface RadarProps {
  axes: number[]; // 六軸 0..1（與 RADAR_LABELS 對應）
  axesCls: ("up" | "down" | "neu")[];
  flashes: RadarFlash[];
  running: boolean;
}

function RadarCanvas({ axes, axesCls, flashes, running }: RadarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ axes, axesCls, flashes, running });
  const reduced = useReducedMotion();
  propsRef.current = { axes, axesCls, flashes, running };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let visible = true;

    const onVis = () => {
      visible = document.visibilityState === "visible";
      if (visible && !raf) loop(performance.now());
    };
    document.addEventListener("visibilitychange", onVis);

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    const loop = (nowMs: number) => {
      raf = 0;
      if (!visible) return;
      fit();
      drawRadarFrame(ctx, canvas, nowMs, propsRef.current, reduced === true);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className="bq-radar-canvas" aria-label="六軸市場狀態雷達" />;
}

function drawRadarFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  nowMs: number,
  p: RadarProps,
  staticFrame: boolean
): void {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  if (W < 60 || H < 60) return;
  const cx = W * 0.47;
  const cy = H * 0.5;
  const R = Math.min(W * 0.34, H * 0.42);
  if (R < 30) return;
  const innerR = R * 0.16;

  // ── 同心圓軌道 + 徑向刻度 ──
  ctx.lineWidth = 1;
  for (const frac of [0.33, 0.66, 1]) {
    ctx.strokeStyle = `rgba(168, 230, 255, ${frac === 1 ? 0.22 : 0.1})`;
    ctx.beginPath();
    ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 外圈十字刻度
  ctx.strokeStyle = "rgba(168, 230, 255, 0.14)";
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.0, 0, Math.PI * 2);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r1 = R * 1.0;
    const r2 = R * (i % 3 === 0 ? 1.06 : 1.03);
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
  }
  ctx.stroke();

  // ── 六軸 ──
  const N = RADAR_LABELS.length;
  const AX = ["#46ffa8", "#ff2e4d", "#a8e6ff", "#ffb020", "#ff9fe5", "#c9a6ff"]; // per-axis hue
  const pts: { x: number; y: number; cls: string }[] = [];
  for (let i = 0; i < N; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI * 2) / N;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    // 軸線
    ctx.strokeStyle = "rgba(168, 230, 255, 0.13)";
    ctx.beginPath();
    ctx.moveTo(cx + cos * innerR, cy + sin * innerR);
    ctx.lineTo(cx + cos * R, cy + sin * R);
    ctx.stroke();
    // 標籤 + 值（外側）
    const lx = cx + cos * (R + 24);
    const ly = cy + sin * (R + 24);
    ctx.font = "500 9px ui-monospace, monospace";
    ctx.textAlign = cos > 0.3 ? "left" : cos < -0.3 ? "right" : "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(139, 162, 184, 0.9)";
    ctx.fillText(RADAR_LABELS[i], lx, ly - 4);
    ctx.fillStyle = AX[i];
    ctx.font = "600 11px ui-monospace, monospace";
    ctx.fillText((p.axes[i] * 100).toFixed(0).padStart(3, "0"), lx, ly + 9);

    const v = Math.max(0.02, Math.min(1, p.axes[i]));
    const rv = innerR + v * (R * 0.86 - innerR);
    pts.push({ x: cx + cos * rv, y: cy + sin * rv, cls: p.axesCls[i] });
  }

  // ── 六邊形填充/描邊 ──
  ctx.beginPath();
  pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.closePath();
  ctx.fillStyle = "rgba(168, 230, 255, 0.05)";
  ctx.fill();
  ctx.strokeStyle = "rgba(168, 230, 255, 0.7)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 頂點
  pts.forEach((pt, i) => {
    const hue = AX[i];
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = hue;
    ctx.shadowColor = hue;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  });

  // ── 中心節點 ──
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 900);
  ctx.beginPath();
  ctx.arc(cx, cy, 5 + pulse * 2.5, 0, Math.PI * 2);
  ctx.fillStyle = p.running ? "rgba(70, 255, 168, 0.9)" : "rgba(139, 162, 184, 0.5)";
  ctx.shadowColor = p.running ? "#46ffa8" : "#8ba2b8";
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;

  // ── 掃描線（reduced-motion 靜態停 12 點鐘方向）──
  const sweepAng =
    staticFrame || !p.running ? -Math.PI / 2 : -Math.PI / 2 + ((nowMs % 4000) / 4000) * Math.PI * 2;
  ctx.strokeStyle = "rgba(168, 230, 255, 0.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(sweepAng) * innerR, cy + Math.sin(sweepAng) * innerR);
  ctx.lineTo(cx + Math.cos(sweepAng) * (R * 0.96), cy + Math.sin(sweepAng) * (R * 0.96));
  ctx.stroke();
  // 掃描尾跡（扇形）
  const trail = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
  trail.addColorStop(0, "rgba(168, 230, 255, 0)");
  trail.addColorStop(1, "rgba(168, 230, 255, 0.05)");
  ctx.fillStyle = trail;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R * 0.96, sweepAng - 0.22, sweepAng);
  ctx.closePath();
  ctx.fill();

  // ── 事件爆閃（3s 淡出）──
  for (const f of p.flashes) {
    const age = (nowMs - f.at) / 1000;
    if (age > 3) continue;
    const a = 1 - age / 3;
    const ang = -Math.PI / 2 + (f.id % 6) * ((Math.PI * 2) / 6); // 依序落在六軸方向軌道
    const rv = R * (0.5 + ((f.id * 37) % 100) / 220);
    const color =
      f.kind === "exit"
        ? "#c9a6ff"
        : f.side === "SELL" || f.side === "SHORT"
          ? "#ff2e4d"
          : f.kind === "alert"
            ? "#46ffa8"
            : "#a8e6ff";
    const x = cx + Math.cos(ang) * rv;
    const y = cy + Math.sin(ang) * rv;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x, y, 3.5 + (1 - a) * 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 8 + (1 - a) * 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 連到 KILL SWITCH 的指示線（右側視覺連線）
  ctx.strokeStyle = "rgba(70, 255, 168, 0.25)";
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(-Math.PI / 6) * R, cy + Math.sin(-Math.PI / 6) * R);
  ctx.lineTo(W - 4, cy);
  ctx.stroke();
  ctx.setLineDash([]);
}

/* =================================================================
   主頁面
   ================================================================= */
export default function BinanceApiPage() {
  const [state, setState] = useState<MonitorSnapshot | null>(null);
  const [feed, setFeed] = useState<FeedState>(emptyFeed);
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [flashes, setFlashes] = useState<RadarFlash[]>([]);
  const [hist, setHist] = useState<HistPoint[]>([]);
  const [nowTick, setNowTick] = useState(0);
  const [tapeRows, setTapeRows] = useState<TapeRow[]>([]);

  const histRef = useRef<HistPoint[]>([]);
  const flashSeq = useRef(1);
  const tapeBuf = useRef<TapeRow[]>([]);
  const tapeSeq = useRef(1);
  const tapeRaf = useRef(0);

  const pushLedger = (row: Omit<LedgerRow, "id">) =>
    setLedger((prev) => {
      const next = [{ id: rowSeq++, ...row }, ...prev];
      return next.length > LEDGER_CAP ? next.slice(0, LEDGER_CAP) : next;
    });

  const pushFlash = (kind: RadarFlash["kind"], side: RadarFlash["side"], amount: number) =>
    setFlashes((prev) => {
      const next = [{ id: flashSeq.current++, at: Date.now(), kind, side, amount }, ...prev];
      return next.slice(0, 24);
    });

  // ── tape（成交流）────────────────────────────────────────
  const flushTape = () => {
    const buf = tapeBuf.current;
    if (buf.length === 0) return;
    let maxQ = 0;
    for (const r of buf) if (r.q > maxQ) maxQ = r.q;
    setTapeRows(
      buf.slice(0, TAPE_DOM).map((r) => ({
        ...r,
        vol: maxQ > 0 ? Math.max(4, Math.min(100, Math.round((r.q / maxQ) * 100))) : 0,
      })),
    );
  };
  const scheduleTapeFlush = () => {
    if (tapeRaf.current) return;
    tapeRaf.current = requestAnimationFrame(() => {
      tapeRaf.current = 0;
      flushTape();
    });
  };
  const pushTrades = (list: Array<{ t: number; p: number | string; q: number | string; m: boolean | string }>) => {
    if (!list || list.length === 0) return;
    const buf = tapeBuf.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const tr = list[i];
      const p = Number(tr.p);
      const q = Number(tr.q);
      if (!(p > 0) || !(q > 0)) continue;
      buf.unshift({ id: tapeSeq.current++, t: tr.t, p, q, m: tr.m === true || tr.m === "true", vol: 0 });
    }
    if (buf.length > TAPE_BUF) buf.length = TAPE_BUF;
    scheduleTapeFlush();
  };

  // ── 初始：state + auth + BOOT ledger ────────────────────────
  useEffect(() => {
    let alive = true;
    pushLedger({ ts: Date.now(), code: "MONITOR BOOT", info: "linking market feed", cls: "sys", st: "…" });
    binanceApi
      .state()
      .then((s) => {
        if (!alive) return;
        setState(s.state);
        setFeed(mergeFeed(emptyFeed(), s.feed));
        seedHist(s.state);
        pushTrades(s.feed.trades);
      })
      .catch(() => {
        if (alive) pushLedger({ ts: Date.now(), code: "STATE FAIL", info: "cannot reach /state", cls: "sys", st: "ERR" });
      });
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((b: { authed?: boolean }) => {
        if (alive) setAuthed(b.authed === true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seedHist = (s: MonitorSnapshot) => {
    const pt: HistPoint = {
      ts: s.ts,
      price: s.lastPrice || s.markPrice,
      score: s.score,
      cvd: s.stats1m.cvd,
      oi: s.oiChange5s,
      depth: s.depthImbalance,
    };
    histRef.current = [pt];
    setHist([...histRef.current]);
  };

  const appendHist = (s: MonitorSnapshot) => {
    const arr = histRef.current;
    const ts = s.ts;
    const last = arr[arr.length - 1];
    if (last && ts - last.ts < 800) {
      // 同秒多 update：覆寫最新值（保留窗深度）
      last.price = s.lastPrice || s.markPrice;
      last.score = s.score;
      last.cvd = s.stats1m.cvd;
      last.oi = s.oiChange5s;
      last.depth = s.depthImbalance;
      return;
    }
    arr.push({
      ts,
      price: s.lastPrice || s.markPrice,
      score: s.score,
      cvd: s.stats1m.cvd,
      oi: s.oiChange5s,
      depth: s.depthImbalance,
    });
    const cutoff = ts - HIST_SECONDS * 1000;
    while (arr.length > 2 && arr[0].ts < cutoff) arr.shift();
    if (arr.length > 240) arr.splice(0, arr.length - 240);
  };

  // ── SSE ─────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource(binanceApi.streamUrl());
    let prevLedgerState = { running: state?.running, connected: state?.connected, warmingUp: state?.warmingUp };
    es.onopen = () => {
      setConn("open");
      binanceApi
        .state()
        .then((s) => {
          setState(s.state);
          appendHist(s.state);
          setHist([...histRef.current]);
        })
        .catch(() => {});
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const u = JSON.parse(ev.data) as PanelUpdate;
        const st = u.state;
        setState(st);
        appendHist(st);
        // 每秒節流更新 hist state（供趨勢線重繪）
        const nowS = Math.floor(st.ts / 1000);
        if (nowS % 1 === 0) setNowTick(nowS);

        // feed delta → ledger + 雷達爆閃
        pushTrades(u.feed.trades);
        for (const a of u.feed.alerts) {
          const t = a.t;
          pushLedger({
            ts: t,
            code: a.side === "SELL" ? "LIQ SELL" : "LIQ BUY",
            info: `$${a.price.toFixed(1)} × ${a.qty.toFixed(3)} = $${fmtInt(a.totalUsdt)}`,
            cls: a.side === "SELL" ? "alert-sell" : "alert-buy",
            st: a.side === "SELL" ? "LONG KILLED" : "SHORT KILLED",
          });
          pushFlash("alert", a.side, a.totalUsdt);
        }
        for (const sg of u.feed.signals) {
          const isLong = sg.side === "LONG";
          const isEntry = sg.action === "ENTRY";
          pushLedger({
            ts: sg.t,
            code: `${String(sg.strategy).toUpperCase()} ${isEntry ? "ENTRY" : "EXIT"}`,
            info: `${sg.side} @ $${sg.price.toFixed(1)} ${sg.reason}${!isEntry ? ` · pnl ${fmtSigned(sg.pnl, 0)}` : ""}`,
            cls: isEntry ? (isLong ? "entry-long" : "entry-short") : "exit",
            st: isEntry ? (isLong ? "OPEN LONG" : "OPEN SHORT") : "CLOSED",
          });
          pushFlash(isEntry ? "entry" : "exit", isLong ? "BUY" : "SELL", sg.qty);
        }

        // 系統事件（state 前後比較）
        const p = prevLedgerState;
        if (p.running !== undefined && p.running !== st.running) {
          pushLedger({
            ts: st.ts,
            code: st.running ? "ENGINE START" : "ENGINE STOP",
            info: st.running ? "market monitor armed" : "market monitor halted",
            cls: "sys",
            st: st.running ? "ARMED" : "HALTED",
          });
        }
        if (p.connected !== undefined && p.connected !== st.connected) {
          pushLedger({
            ts: st.ts,
            code: st.connected ? "LINK UP" : "LINK DOWN",
            info: "binance combined stream",
            cls: "sys",
            st: st.connected ? "LIVE" : "LOST",
          });
        }
        if (p.warmingUp !== undefined && p.warmingUp !== st.warmingUp) {
          pushLedger({
            ts: st.ts,
            code: st.warmingUp ? "STATS REWARM" : "STATS WARM",
            info: "1m rolling statistics",
            cls: "sys",
            st: st.warmingUp ? "HOLD" : "READY",
          });
        }
        prevLedgerState = { running: st.running, connected: st.connected, warmingUp: st.warmingUp };
        setHist([...histRef.current]);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => setConn("closed");
    return () => {
      es.close();
      if (tapeRaf.current) cancelAnimationFrame(tapeRaf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 管理開關 ────────────────────────────────────────────────
  const toggleRunning = async () => {
    if (!state || busy) return;
    setBusy(true);
    try {
      await binanceApi.setRunning(!state.running);
      window.setTimeout(async () => {
        try {
          const s = await binanceApi.state();
          setState(s.state);
        } catch {
          /* ignore */
        }
      }, 400);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div className="bq">
        <div className="bq-boot">
          <div>LINKING MARKET FEED // {fmtClock(Date.now())}</div>
          <div className="bar" />
        </div>
      </div>
    );
  }

  // ── 每 frame 資料計算（render 時；SSE 驅動）───────────────
  const st = state.stats1m;
  const refPrice = state.lastPrice > 0 ? state.lastPrice : state.markPrice;
  const pnlPct = state.initialCapital > 0 ? ((state.capital - state.initialCapital) / state.initialCapital) * 100 : 0;
  const liqMax = Math.max(
    ...histRef.current.map((h) => Math.abs(h.cvd)),
    5
  );
  const priceMin = Math.min(...histRef.current.map((h) => h.price || 1), refPrice || 1);
  const priceMax = Math.max(...histRef.current.map((h) => h.price || 1), refPrice || 1);
  const oiAbsMax = Math.max(...histRef.current.map((h) => Math.abs(h.oi)), 1);

  const cvdNow = st.cvd;
  const cvdAbsNorm = liqMax > 0 ? Math.min(1, Math.abs(cvdNow) / liqMax) : 0;
  const dirNorm = cvdAbsNorm * 0.45 + 0.5 * Math.sign(cvdNow || 1) * 0 + (cvdNow > 0 ? 0.5 + cvdAbsNorm * 0.5 : 0.5 - cvdAbsNorm * 0.5);
  const depthNorm = Math.max(0, Math.min(1, state.depthImbalance));
  const oiNorm = Math.max(0.02, Math.min(1, 0.5 + (oiAbsMax > 0 ? (state.oiChange5s / oiAbsMax) * 0.5 : 0)));
  const pricePos = priceMax > priceMin ? (refPrice - priceMin) / (priceMax - priceMin) : 0.5;

  const axes = [
    cvdAbsNorm,
    dirNorm,
    depthNorm,
    oiNorm,
    0.05, // LIQ：以爆閃顯示為主，軸保持低基線
    pricePos,
  ];
  const axesCls: ("up" | "down" | "neu")[] = [
    cvdNow >= 0 ? "up" : "down",
    cvdNow >= 0 ? "up" : "down",
    "neu",
    state.oiChange5s >= 0 ? "up" : "down",
    "neu",
    "neu",
  ];

  const openPos = state.positions[0];
  const feedAgeSec = feed.trades.length > 0 ? Math.round((Date.now() - feed.trades[0].t) / 1000) : -1;
  const move = state.priceMove15sPct;
  const moveLow = move !== null && move < 0.1;
  const score = Math.round(state.score);

  return (
    <div className="bq">
      {/* ── 頂欄 ── */}
      <div className="bq-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="bq-brand">
            BINANCE<em>//QUANT</em>
          </span>
          <span className="bq-sym">{state.symbol}-PERP</span>
        </div>
        <div className="bq-head-right">
          <span className={`bq-status-pill ${state.running ? "run" : "stop"}`}>{state.running ? "RUNNING" : "HALTED"}</span>
          <span className={`bq-status-pill ${conn === "open" ? "link" : "warm"}`}>{conn === "open" ? "LINK OK" : "LINK …"}</span>
          <span className={`bq-status-pill ${state.warmingUp ? "warm" : "run"}`}>{state.warmingUp ? "WARMING" : "READY"}</span>
          {authed && (
            <button
              className={`bq-admin-btn ${state.running ? "stop" : ""}`}
              onClick={toggleRunning}
              disabled={busy}
            >
              {state.running ? "■ STOP" : "▶ START"}
            </button>
          )}
        </div>
      </div>

      <div className="bq-grid">
        {/* ── GRAPH CONTROL（雷達 + KILL SWITCH）────────────── */}
        <section className="bq-mod bq-radar">
          <div className="bq-mod-head">
            <span>GRAPH CONTROL — LOOPS WATCHING LOOPS</span>
            <span className="hd-right">
              <span className="hd-dot ok" /> {state.symbol} {fmtClock(Date.now())}
            </span>
          </div>
          <div className="bq-radar-body">
            <RadarCanvas axes={axes} axesCls={axesCls} flashes={flashes} running={state.running} />
            {/* KILL SWITCH 節點 */}
            <div className="bq-kill">
              <span className="ks-name">KILL&nbsp;SWITCH</span>
              <span className={`ks-state ${state.running ? "armed" : "idle"}`}>{state.running ? "ARMED" : "IDLE"}</span>
              <span className={`ks-move ${moveLow ? "low" : ""}`}>
                {move === null ? "--" : `${move.toFixed(2)}%`}
              </span>
              <span className="ks-cap">PRICE MOVE // 15S</span>
            </div>
          </div>
          {/* 底部數據帶 */}
          <div className="bq-tape">
            <span className="tp">
              <span className="tp-k">LAST</span>
              <span className="tp-v">{fmtPrice(refPrice)}</span>
            </span>
            <span className="tp">
              <span className="tp-k">MARK</span>
              <span className="tp-v">{state.markPrice > 0 ? fmtPrice(state.markPrice) : "--"}</span>
            </span>
            <span className="tp">
              <span className="tp-k">FUNDING</span>
              <span className="tp-v">{state.fundingRate !== 0 ? fmtRate(state.fundingRate) : "--"}</span>
            </span>
            <span className="tp">
              <span className="tp-k">PREMIUM</span>
              <span className={`tp-v ${state.premium >= 0 ? "up" : "down"}`}>{fmtSigned(state.premium, 1)}</span>
            </span>
            <span className="tp">
              <span className="tp-k">OI</span>
              <span className="tp-v">{fmtCompact(state.openInterest)}</span>
            </span>
            <span className="tp">
              <span className="tp-k">OI Δ5s</span>
              <span className={`tp-v ${state.oiChange5s >= 0 ? "up" : "down"}`}>{fmtSigned(state.oiChange5s, 2)}</span>
            </span>
            <span className="tp">
              <span className="tp-k">1M CVD</span>
              <span className={`tp-v ${cvdNow >= 0 ? "up" : "down"}`}>{fmtSigned(cvdNow, 2)}</span>
            </span>
            <span className="tp">
              <span className="tp-k">DEPTH IMB</span>
              <span className="tp-v">{(state.depthImbalance * 100).toFixed(0)}%</span>
            </span>
            <span className="tp">
              <span className="tp-k">SCORE</span>
              <span className={`tp-v ${score > 55 ? "up" : score < 45 ? "down" : ""}`}>{score}</span>
            </span>
          </div>
        </section>

        {/* ── ACCOUNT（紙上資金 + 方向燈）──────────────────── */}
        <section className="bq-mod bq-account">
          <div className="bq-mod-head">
            <span>ACCOUNT // PAPER CAPITAL</span>
            <span className="hd-right">
              <span className="hd-dot ok" /> ENGINE
            </span>
          </div>
          <div className="bq-account-body">
            <div className="bq-cap-row">
              <span className="bq-cap">{fmtUsdt(state.capital)}</span>
              <span className={`bq-pnl ${pnlPct >= 0 ? "up" : "down"}`}>{fmtSigned(pnlPct, 1)}%</span>
            </div>
            <div className="bq-dir3" aria-hidden>
              <div className={`bq-dir ${openPos?.side === "LONG" ? "long" : ""}`}>
                BUY<span className="dir-sub">{openPos?.side === "LONG" ? openPos.strategy.toUpperCase() : "LONG"}</span>
              </div>
              <div className={`bq-dir ${openPos?.side === "SHORT" ? "short" : ""}`}>
                SELL<span className="dir-sub">{openPos?.side === "SHORT" ? openPos.strategy.toUpperCase() : "SHORT"}</span>
              </div>
              <div className={`bq-dir ${!openPos ? "flat" : ""}`}>
                FLAT<span className="dir-sub">{!openPos ? "NO POSITION" : "—"}</span>
              </div>
            </div>
            {state.positions.map((pos) => (
              <div key={`${pos.strategy}-${pos.entryTime}`} className={`bq-pos ${pos.side === "LONG" ? "long" : "short"}`}>
                <span>
                  {pos.side} {pos.strategy.replace("_", " ").toUpperCase()} @ {fmtPrice(pos.entryPrice)}
                </span>
                <span className="pos-meta">
                  {fmtQty(pos.qty)} BTC · HOLD {fmtHold(pos.holdMs)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ── FAILURE MATRIX ────────────────────────────────── */}
        <section className="bq-mod bq-matrix">
          <div className="bq-mod-head">
            <span>FAILURE MATRIX</span>
            <span className="hd-right">SYSTEM MONITOR</span>
          </div>
          <div className="bq-matrix-body">
            <FailureRow name="WS LINK" val={state.connected ? "LIVE" : "DOWN"} st={state.connected ? "ok" : "fail"} />
            <FailureRow
              name="DATA FEED"
              val={feedAgeSec >= 0 ? `${feedAgeSec}s` : "--"}
              st={feedAgeSec >= 0 && feedAgeSec <= 5 ? "ok" : feedAgeSec > 5 ? "warn" : "dim"}
            />
            <FailureRow name="STATS WARM" val={state.warmingUp ? "HOLD" : "READY"} st={state.warmingUp ? "warn" : "ok"} />
            <FailureRow name="PAPER ENGINE" val={state.running ? "ARMED" : "IDLE"} st={state.running ? "ok" : "dim"} />
            <FailureRow
              name="PRICE MOTION"
              val={move === null ? "--" : `${move.toFixed(2)}%/15s`}
              st={move === null ? "dim" : moveLow ? "fail" : "ok"}
            />
            <FailureRow name="OI POLL" val={state.openInterest > 0 ? "SYNC" : "--"} st={state.openInterest > 0 ? "ok" : "dim"} />
            <FailureRow name="UPLINK SSE" val={conn === "open" ? "LIVE" : "RETRY"} st={conn === "open" ? "ok" : "warn"} />
          </div>
        </section>

        {/* ── VERIFICATION LEDGER ───────────────────────────── */}
        <section className="bq-mod bq-ledger">
          <div className="bq-mod-head">
            <span>VERIFICATION LEDGER</span>
            <span className="hd-right">AUDIT TRAIL // LAST {LEDGER_CAP}</span>
          </div>
          <div className="bq-ledger-body">
            {ledger.map((row) => (
              <div key={row.id} className={`bq-lg-row ${row.cls}`}>
                <span className="lg-ts">{fmtClock(row.ts)}</span>
                <span className="lg-code">{row.code}</span>
                <span className="lg-info">{row.info}</span>
                <span className="lg-st">{row.st}</span>
              </div>
            ))}
            {ledger.length === 0 && <div style={{ padding: 8, color: "var(--faint)" }}>awaiting events…</div>}
          </div>
        </section>

        {/* ── TREND ─────────────────────────────────────────── */}
        <section className="bq-mod bq-trend">
          <div className="bq-mod-head">
            <span>DASHBOARD VS GROUND TRUTH</span>
            <span className="hd-right">
              <span style={{ color: "var(--ice)" }}>— SCORE</span>{" "}
              <span style={{ color: "var(--bq-ok)" }}>— PRICE</span>
            </span>
          </div>
          <div className="bq-trend-body">
            <TrendCanvas hist={hist} nowTick={nowTick} />
          </div>
        </section>

        {/* ── TAPE TRADES（最右直欄成交流）────────────────── */}
        <TradesTape rows={tapeRows} />
      </div>
    </div>
  );
}

/* ── 小元件 ─────────────────────────────────────────────────── */
function TradesTape({ rows }: { rows: TapeRow[] }) {
  return (
    <section className="bq-mod bq-trades">
      <div className="bq-mod-head">
        <span>TAPE TRADES — EXECUTION STREAM</span>
        <span className="hd-right">
          <span className="hd-dot ok" />
          LIVE
        </span>
      </div>
      <div className="bq-trades-body">
        {rows.map((r) => (
          <div key={r.id} className={`bq-tr ${r.m ? "sell" : "buy"}`}>
            <span className="tm">{fmtClock(r.t)}</span>
            <span className="px">{fmtPrice(r.p)}</span>
            <span className="qt">{fmtQty(r.q)}</span>
            <span className="uv">{fmtUsdt(r.p * r.q)}</span>
            <span
              className="vb"
              style={{ "--vol": `${r.vol}%` } as CSSProperties}
            />
          </div>
        ))}
        {rows.length === 0 && <div className="bq-tr-empty">awaiting execution stream…</div>}
      </div>
    </section>
  );
}

function FailureRow({ name, val, st }: { name: string; val: string; st: string }) {
  return (
    <div className="bq-mx-row">
      <span className="mx-name">{name}</span>
      <span className="mx-val">{val}</span>
      <span className={`mx-st ${st}`}>{st.toUpperCase()}</span>
    </div>
  );
}

/** 趨勢折線：SCORE（0-100，冰藍）vs PRICE（min-max 規範，綠） */
function TrendCanvas({ hist, nowTick }: { hist: HistPoint[]; nowTick: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const histRef2 = useRef(hist);
  histRef2.current = hist;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    fit();
    drawTrend(ctx, canvas, histRef2.current);
    raf = requestAnimationFrame(function tick() {
      drawTrend(ctx, canvas, histRef2.current);
      raf = requestAnimationFrame(tick);
    });
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  void nowTick;
  return <canvas ref={canvasRef} className="bq-trend-canvas" aria-label="評分與價格趨勢對比" />;
}

function drawTrend(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, hist: HistPoint[]): void {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  if (W < 40 || H < 40 || hist.length < 2) return;
  const padL = 8;
  const padR = 10;
  const padT = 10;
  const padB = 16;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  // 網格（25/50/75）
  ctx.strokeStyle = "rgba(160, 215, 255, 0.07)";
  ctx.fillStyle = "rgba(139, 162, 184, 0.6)";
  ctx.font = "8px ui-monospace, monospace";
  ctx.lineWidth = 1;
  for (const g of [25, 50, 75]) {
    const y = padT + (g / 100) * ih;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(String(g), 2, y + 2);
  }

  const prices = hist.map((h) => h.price).filter((v) => v > 0);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const pSpan = pMax - pMin > 0 ? pMax - pMin : 1;

  const xOf = (i: number) => padL + (i / (hist.length - 1)) * iw;
  const scoreY = (v: number) => padT + (1 - Math.max(0, Math.min(100, v)) / 100) * ih;
  const priceY = (v: number) => padT + (1 - (v - pMin) / pSpan) * ih;

  // SCORE 線（冰藍）
  ctx.strokeStyle = "rgba(168, 230, 255, 0.95)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  hist.forEach((h, i) => {
    const x = xOf(i);
    const y = scoreY(h.score);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // SCORE 填充
  ctx.lineTo(xOf(hist.length - 1), padT + ih);
  ctx.lineTo(xOf(0), padT + ih);
  ctx.closePath();
  ctx.fillStyle = "rgba(168, 230, 255, 0.05)";
  ctx.fill();

  // PRICE 線（綠，GROUND TRUTH）
  ctx.strokeStyle = "rgba(70, 255, 168, 0.9)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  hist.forEach((h, i) => {
    const x = xOf(i);
    const y = priceY(h.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 尾端游標點 + 時間標
  const last = hist[hist.length - 1];
  const lx = xOf(hist.length - 1);
  ctx.beginPath();
  ctx.arc(lx, scoreY(last.score), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#a8e6ff";
  ctx.shadowColor = "#a8e6ff";
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(lx, priceY(last.price), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#46ffa8";
  ctx.shadowColor = "#46ffa8";
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(139, 162, 184, 0.75)";
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.fillText(fmtClock(last.ts), W - padR, H - 4);
  // 範圍標（左：price 低-高）
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(70, 255, 168, 0.7)";
  ctx.fillText(fmtPrice(pMax), padL, padT + 2);
  ctx.fillStyle = "rgba(139, 162, 184, 0.6)";
  ctx.fillText(fmtPrice(pMin), padL, H - 4);
}
