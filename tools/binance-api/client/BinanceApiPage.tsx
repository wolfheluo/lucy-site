// =====================================================================
//  BINANCE QUANT client 主頁面（即時監控儀表板）
//  - 一次 /state 初始化 + SSE（/stream）訂閱即時指標
//  - 記憶體 feed（成交 / 告警 / 策略訊號）+ DB 歷史表
//  - 管理端（登入後）可 START / STOP 引擎
// =====================================================================
import { useEffect, useState } from "react";
import type {
  FeedAlert,
  FeedSignal,
  FeedSummary,
  FeedTrade,
  ForceOrderRow,
  MonitorSnapshot,
  PanelUpdate,
  StrategyOrderRow,
} from "../types";
import { binanceApi } from "./api";
import {
  fmtClock,
  fmtCompact,
  fmtHold,
  fmtInt,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtRate,
  fmtSigned,
  fmtUsdt,
} from "./format";

const TRADE_CAP = 140;
const ALERT_CAP = 30;
const SIGNAL_CAP = 40;

interface FeedState {
  trades: FeedTrade[];
  alerts: FeedAlert[];
  signals: FeedSignal[];
}

function emptyFeed(): FeedState {
  return { trades: [], alerts: [], signals: [] };
}

/** 把 SSE delta 併入現有 feed（delta 已是 newest-first） */
function mergeFeed(prev: FeedState, delta: FeedSummary): FeedState {
  return {
    trades: [...delta.trades, ...prev.trades].slice(0, TRADE_CAP),
    alerts: [...delta.alerts, ...prev.alerts].slice(0, ALERT_CAP),
    signals: [...delta.signals, ...prev.signals].slice(0, SIGNAL_CAP),
  };
}

function scoreClass(score: number): string {
  if (score > 65) return "ba-up";
  if (score < 35) return "ba-down";
  return "ba-flat";
}

/** 顏色語意類別（正/負） */
function signedClass(n: number): string {
  if (n > 0) return "ba-up";
  if (n < 0) return "ba-down";
  return "ba-flat";
}

export default function BinanceApiPage() {
  const [state, setState] = useState<MonitorSnapshot | null>(null);
  const [feed, setFeed] = useState<FeedState>(emptyFeed);
  const [orders, setOrders] = useState<StrategyOrderRow[]>([]);
  const [liquidations, setLiquidations] = useState<ForceOrderRow[]>([]);
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  const [dbMsg, setDbMsg] = useState<string | null>(null);

  // ── 初始載入：/state + DB 歷史 + 登入與否 ─────────────────────
  useEffect(() => {
    let alive = true;
    Promise.all([binanceApi.state(), binanceApi.orders(40), binanceApi.liquidations(40)])
      .then(([s, o, l]) => {
        if (!alive) return;
        setState(s.state);
        setFeed(mergeFeed(emptyFeed(), s.feed));
        setOrders(o.orders);
        setLiquidations(l.liquidations);
      })
      .catch((e: unknown) => {
        if (alive) setDbMsg((e as Error).message);
      });
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((b: { authed?: boolean }) => {
        if (alive) setAuthed(b.authed === true);
      })
      .catch(() => {
        /* 不影響公開瀏覽 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── SSE 訂閱（EventSource 自帶重連；open 時重新同步一次）──────
  useEffect(() => {
    const es = new EventSource(binanceApi.streamUrl());
    es.onopen = () => {
      setConnState("open");
      // 重連後與 server 記憶體對齊（避免掉資料）
      binanceApi
        .state()
        .then((s) => {
          setState(s.state);
          setFeed(mergeFeed(emptyFeed(), s.feed));
        })
        .catch(() => {
          /* ignore */
        });
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const update = JSON.parse(ev.data) as PanelUpdate;
        setState(update.state);
        setFeed((prev) => mergeFeed(prev, update.feed));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      // EventSource 自動重連；先顯示斷線狀態
      setConnState("closed");
    };
    return () => es.close();
  }, []);

  // ── 管理端開關 ────────────────────────────────────────────────
  const toggleRunning = async () => {
    if (!state || busy) return;
    setBusy(true);
    try {
      await binanceApi.setRunning(!state.running);
      window.setTimeout(() => {
        binanceApi
          .state()
          .then((s) => setState(s.state))
          .catch(() => {
            /* ignore */
          });
      }, 400);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  const refreshDb = async () => {
    setDbMsg(null);
    try {
      const [o, l] = await Promise.all([binanceApi.orders(40), binanceApi.liquidations(40)]);
      setOrders(o.orders);
      setLiquidations(l.liquidations);
    } catch (e: unknown) {
      setDbMsg((e as Error).message);
    }
  };

  if (!state) {
    return (
      <div className="ba">
        <div className="tool-loading">LINKING MARKET FEED…</div>
        {dbMsg && <div className="ba-msg">{dbMsg}</div>}
      </div>
    );
  }

  const st = state.stats1m;
  const cvdCls = signedClass(st.cvd);
  const oiCls = signedClass(state.oiChange5s);
  const score = Math.round(state.score);

  return (
    <div className="ba">
      {/* ── 頂欄：狀態 + 管理開關 ─────────────────────────────── */}
      <div className="ba-head">
        <div className="ba-head-main">
          <div className="ba-brand">
            BINANCE<span className="ba-brand-accent">//QUANT</span>
          </div>
          <div className="ba-sub">
            <span className={`ba-led${state.running ? " on" : ""}`} aria-hidden="true" />
            <span>ENGINE {state.running ? "RUNNING" : "STANDBY"}</span>
            <span className="ba-sep">|</span>
            <span className={`ba-led${state.connected ? " on" : ""}`} aria-hidden="true" />
            <span>WS {state.connected ? "LINKED" : "LINKING"}</span>
            <span className="ba-sep">|</span>
            <span className="ba-sym">{state.symbol}/USDT PERP</span>
          </div>
        </div>
        <div className="ba-head-side">
          {authed ? (
            <button
              type="button"
              className={`ba-btn${state.running ? " danger" : ""}`}
              onClick={() => void toggleRunning()}
              disabled={busy}
            >
              {state.running ? "■ STOP ENGINE" : "▶ START ENGINE"}
            </button>
          ) : (
            <span className="ba-hint">管理員登入可控制引擎</span>
          )}
        </div>
      </div>

      {/* ── 指標卡 ────────────────────────────────────────────── */}
      <div className="ba-grid">
        <div className="ba-card ba-card-price">
          <div className="ba-label">LAST PRICE</div>
          <div className="ba-price">
            {state.lastPrice > 0 ? fmtPrice(state.lastPrice) : "—"}
            <span className="ba-dir">◈</span>
          </div>
          <div className="ba-card-sub">
            標記 {state.markPrice > 0 ? fmtPrice(state.markPrice) : "—"} · 溢價{" "}
            <span className={signedClass(state.premium)}>{fmtSigned(state.premium, 1)}</span>
          </div>
        </div>

        <div className="ba-card">
          <div className="ba-label">CVD 1M</div>
          <div className={`ba-big ${cvdCls}`}>{st.cvd === 0 && st.totalVol === 0 ? "—" : fmtSigned(st.cvd, 1)}</div>
          <div className="ba-card-sub">
            買 <span className="ba-up">{fmtCompact(st.buyVol)}</span> · 賣{" "}
            <span className="ba-down">{fmtCompact(st.sellVol)}</span>
          </div>
        </div>

        <div className="ba-card">
          <div className="ba-label">OPEN INTEREST</div>
          <div className="ba-big">{state.openInterest > 0 ? fmtInt(state.openInterest) : "—"}</div>
          <div className="ba-card-sub">
            Δ5s <span className={oiCls}>{fmtSigned(state.oiChange5s, 1)}</span>
          </div>
        </div>

        <div className="ba-card">
          <div className="ba-label">BID DEPTH</div>
          <div className={`ba-big ${signedClass(state.depthImbalance - 0.5)}`}>
            {fmtPct(state.depthImbalance * 100)}
          </div>
          <div className="ba-card-sub">
            B {fmtCompact(state.bidDepthVol)} · A {fmtCompact(state.askDepthVol)}
          </div>
        </div>

        <div className="ba-card">
          <div className="ba-label">FUNDING RATE</div>
          <div className={`ba-big ${signedClass(state.fundingRate)}`}>{fmtRate(state.fundingRate)}</div>
          <div className="ba-card-sub">
            買盤比 {fmtPct(st.buyRatio)}
          </div>
        </div>

        <div className="ba-card">
          <div className="ba-label">SCORE // 短線評分</div>
          <div className={`ba-score ${scoreClass(state.score)}`}>{score}</div>
          <div className="ba-score-bar">
            <i style={{ width: `${state.score}%` }} />
          </div>
          <div className="ba-card-sub">
            CAPITAL <span className="ba-cold">{fmtUsdt(state.capital)}</span>
          </div>
        </div>
      </div>

      {/* ── 紙上部位 strip ─────────────────────────────────────── */}
      {state.positions.length > 0 && (
        <div className="ba-positions">
          <div className="ba-label">PAPER POSITIONS</div>
          {state.positions.map((p) => (
            <div className="ba-pos-chip" key={p.strategy}>
              <span className={`ba-pos-side ${p.side === "LONG" ? "ba-up" : "ba-down"}`}>
                {p.side}
              </span>
              <span className="ba-pos-name">
                {p.strategy === "liquidation_reversal" ? "LIQ-REVERSAL" : "CVD-BREAKOUT"}
              </span>
              <span className="ba-pos-qty">
                {fmtQty(p.qty)} @ {fmtPrice(p.entryPrice)}
              </span>
              <span className="ba-pos-hold">{fmtHold(p.holdMs)}</span>
              <span className={`ba-pos-pnl ${signedClass(p.unrealizedPnl)}`}>
                {fmtSigned(p.unrealizedPnl, 2)} ({fmtSigned(p.unrealizedPct, 2)}%)
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── 即時 feed 三欄 ─────────────────────────────────────── */}
      <div className="ba-cols">
        <section className="ba-card ba-card-feed">
          <div className="ba-label">TRADE FLOW // 成交</div>
          {feed.trades.length === 0 ? (
            <div className="ba-empty">等待成交資料…</div>
          ) : (
            <ul className="ba-feed-list">
              {feed.trades.map((tr, i) => (
                <li key={`${tr.t}-${i}`}>
                  <span className="ba-feed-time">{fmtClock(tr.t)}</span>
                  <span className={`ba-feed-side ${tr.m ? "ba-down" : "ba-up"}`}>
                    {tr.m ? "SELL" : "BUY"}
                  </span>
                  <span className="ba-feed-price">{fmtPrice(tr.p)}</span>
                  <span className="ba-feed-qty">{fmtQty(tr.q)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ba-card ba-card-feed">
          <div className="ba-label">STRATEGY SIGNALS // 紙上訊號</div>
          {feed.signals.length === 0 ? (
            <div className="ba-empty">尚未觸發策略訊號</div>
          ) : (
            <ul className="ba-feed-list">
              {feed.signals.map((sg, i) => (
                <li key={`${sg.t}-${i}`} className="ba-signal">
                  <span className="ba-feed-time">{fmtClock(sg.t)}</span>
                  <span className={`ba-tag ${sg.action === "ENTRY" ? "tag-entry" : "tag-exit"}`}>
                    {sg.action}
                  </span>
                  <span className="ba-sig-name">
                    {sg.strategy === "liquidation_reversal" ? "LIQ" : "CVD"}
                  </span>
                  <span className={`ba-pos-side ${sg.side === "LONG" ? "ba-up" : "ba-down"}`}>
                    {sg.side}
                  </span>
                  <span className="ba-sig-price">{fmtPrice(sg.price)}</span>
                  {sg.action === "EXIT" && (
                    <span className={`ba-sig-pnl ${signedClass(sg.pnl)}`}>
                      {fmtSigned(sg.pnl, 2)}
                    </span>
                  )}
                  <span className="ba-sig-reason">{sg.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ba-card ba-card-feed">
          <div className="ba-label">LIQUIDATION ALERTS // 大額爆倉</div>
          {feed.alerts.length === 0 ? (
            <div className="ba-empty">無 $50,000+ 強平事件</div>
          ) : (
            <ul className="ba-feed-list">
              {feed.alerts.map((al, i) => (
                <li key={`${al.t}-${i}`} className="ba-alert">
                  <span className="ba-feed-time">{fmtClock(al.t)}</span>
                  <span className="ba-alert-side">
                    {al.side === "SELL" ? "💥 MULTI-LIQ" : "🚀 SHORT-SQZ"}
                  </span>
                  <span className="ba-alert-main">
                    {fmtPrice(al.price)} × {fmtQty(al.qty)}
                  </span>
                  <span className="ba-alert-usdt">{fmtUsdt(al.totalUsdt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── DB 歷史（SQLite）───────────────────────────────────── */}
      <div className="ba-card ba-db">
        <div className="ba-db-head">
          <div className="ba-label">STRATEGY ORDERS // SQLite 歷史</div>
          <button type="button" className="ba-btn ghost" onClick={() => void refreshDb()}>
            ⟳ REFRESH
          </button>
        </div>
        {dbMsg && <div className="ba-msg">{dbMsg}</div>}
        {orders.length === 0 ? (
          <div className="ba-empty">資料庫尚無策略訂單</div>
        ) : (
          <div className="ba-table-wrap">
            <table className="ba-table">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>STRATEGY</th>
                  <th>ACTION</th>
                  <th>SIDE</th>
                  <th className="num">PRICE</th>
                  <th className="num">QTY</th>
                  <th className="num">PNL</th>
                  <th className="num">CAPITAL</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{fmtClock(o.timestamp)}</td>
                    <td>{o.strategy === "liquidation_reversal" ? "LIQ-REVERSAL" : "CVD-BREAKOUT"}</td>
                    <td>
                      <span className={`ba-tag ${o.action === "ENTRY" ? "tag-entry" : "tag-exit"}`}>
                        {o.action}
                      </span>
                    </td>
                    <td className={o.side === "LONG" ? "ba-up" : "ba-down"}>{o.side}</td>
                    <td className="num">{fmtPrice(o.price)}</td>
                    <td className="num">{fmtQty(o.quantity)}</td>
                    <td className={`num ${signedClass(o.pnl)}`}>{o.action === "EXIT" ? fmtSigned(o.pnl, 2) : "—"}</td>
                    <td className="num">{fmtUsdt(o.capitalAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="ba-card ba-db">
        <div className="ba-db-head">
          <div className="ba-label">LIQUIDATION EVENTS // SQLite 歷史</div>
        </div>
        {liquidations.length === 0 ? (
          <div className="ba-empty">資料庫尚無大額強平事件</div>
        ) : (
          <div className="ba-table-wrap">
            <table className="ba-table">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>SIDE</th>
                  <th className="num">PRICE</th>
                  <th className="num">QTY</th>
                  <th className="num">NOTIONAL</th>
                </tr>
              </thead>
              <tbody>
                {liquidations.map((x) => (
                  <tr key={x.id}>
                    <td>{fmtClock(x.timestamp)}</td>
                    <td className={x.side === "SELL" ? "ba-down" : "ba-up"}>{x.side}</td>
                    <td className="num">{fmtPrice(x.price)}</td>
                    <td className="num">{fmtQty(x.quantity)}</td>
                    <td className="num">{fmtUsdt(x.totalUsdt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 頁尾 ────────────────────────────────────────────────── */}
      <div className="ba-foot">
        <span className="ba-led on" aria-hidden="true" />
        {connState === "open" ? "LIVE FEED" : "RECONNECTING…"} · 僅供市場資料監控與研究，
        不會送出交易委託，不構成投資建議。引擎於 server 啟動時自動運行（管理端可停止）。
      </div>
    </div>
  );
}
