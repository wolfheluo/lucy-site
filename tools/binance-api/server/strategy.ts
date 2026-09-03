// =====================================================================
//  BINANCE QUANT 紙上交易策略引擎（strategy.py 的 TypeScript 移植）
//  純邏輯、無 IO、無外部依賴；參數可注入以利單元測試。
//  只模擬交易，永不連接 Binance 下單 API。
// =====================================================================
import type { LiquidationSide, OrderAction, PositionSide, StrategyId } from "../types.js";

/** 引擎需要的市場快照欄位（鏡像 Python snapshot dict） */
export interface StrategySnapshot {
  timestamp: number;
  price: number;
  /** 最近 1 分鐘 CVD */
  cvd_1m: number;
  /** OI 近 5 秒變化 */
  oi_change: number;
  /** 買盤深度比例 0..1 */
  depth_imbalance: number;
  /** 本筆是否來自大額強平（SELL = 多頭被清算） */
  liquidation_side?: LiquidationSide;
  liquidation_usdt?: number;
}

/** 引擎單一紙上部位 */
export interface StrategyPosition {
  strategy: StrategyId;
  side: PositionSide;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  /** 進場時記錄的完整觸發條件（DB trigger_conditions JSON 內容） */
  triggerConditions: Record<string, unknown>;
  previousCvd: number | null;
  cvdSlowCount: number;
}

/** 進出場事件（engine 落庫 / 推送前的中間格式） */
export interface StrategyOrderEvent {
  timestamp: number;
  strategy: StrategyId;
  action: OrderAction;
  side: PositionSide;
  price: number;
  quantity: number;
  pnl: number;
  capitalBefore: number;
  capitalAfter: number;
  /** 序列化進 DB trigger_conditions 的內容 */
  conditions: Record<string, unknown>;
}

export interface StrategyEngineOptions {
  initialCapital: number;
  positionAllocation: number;
  liquidationTakeProfit: number;
  liquidationStopLoss: number;
  liquidationMaxHoldMs: number;
  cvdThreshold: number;
  oiIncreaseThreshold: number;
  cvdConfirmationUpdates: number;
  oppositeWallRatio: number;
  cvdSlowCount: number;
  cvdMaxHoldMs: number;
  /** CVD 順勢停損（signed return，-0.005 = -0.5%） */
  cvdStopLoss: number;
  cooldownMs: number;
}

const REQUIRED_FIELDS = ["timestamp", "price", "cvd_1m", "oi_change", "depth_imbalance"] as const;

function finiteNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 必須是有限數字`);
  return n;
}

function sortedJson(value: unknown): string {
  // 鏡像 Python json.dumps(sort_keys=True, ensure_ascii=True)
  return JSON.stringify(sortKeys(value as Record<string, unknown>));
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

export class StrategyEngine {
  initialCapital: number;
  capital: number;
  private readonly opts: StrategyEngineOptions;
  private readonly positions = new Map<StrategyId, StrategyPosition>();
  private readonly lastExitTime = new Map<StrategyId, number>();
  private cvdBreakoutStreak = 0;
  private cvdBreakoutDirection: PositionSide | null = null;

  constructor(options: StrategyEngineOptions) {
    if (!(options.initialCapital > 0)) {
      throw new Error("initialCapital must be positive");
    }
    this.opts = { ...options };
    this.initialCapital = options.initialCapital;
    this.capital = options.initialCapital;
  }

  reset(): void {
    this.capital = this.initialCapital;
    this.positions.clear();
    this.lastExitTime.clear();
    this.cvdBreakoutStreak = 0;
    this.cvdBreakoutDirection = null;
  }

  /** 目前持倉（外層引擎估值用） */
  positionList(): StrategyPosition[] {
    return [...this.positions.values()];
  }

  get openCount(): number {
    return this.positions.size;
  }

  /** 處理一筆市場快照，回傳本筆產生的紙上進出場事件（依序：先出場後進場）。 */
  process(snapshot: StrategySnapshot): StrategyOrderEvent[] {
    this.validateSnapshot(snapshot);
    this.updateCvdState(snapshot.cvd_1m, snapshot.oi_change);
    const events: StrategyOrderEvent[] = [];
    events.push(...this.checkExits(snapshot));

    if (!this.positions.has("liquidation_reversal")) {
      const ev = this.tryLiquidationEntry(snapshot);
      if (ev) events.push(ev);
    }
    if (!this.positions.has("cvd_breakout")) {
      const ev = this.tryCvdEntry(snapshot);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** 驗證快照欄位；鏡像 Python 的 numeric / finite / 正數檢查 */
  validateSnapshot(snapshot: StrategySnapshot): void {
    for (const field of REQUIRED_FIELDS) {
      if (!(field in snapshot)) {
        throw new Error(`snapshot missing fields: ${REQUIRED_FIELDS.join(", ")}`);
      }
    }
    const timestamp = finiteNumber(snapshot.timestamp, "timestamp");
    const price = finiteNumber(snapshot.price, "price");
    const cvd = finiteNumber(snapshot.cvd_1m, "cvd_1m");
    const oiChange = finiteNumber(snapshot.oi_change, "oi_change");
    const imbalance = finiteNumber(snapshot.depth_imbalance, "depth_imbalance");
    if (timestamp <= 0 || price <= 0) {
      throw new Error("snapshot timestamp and price must be positive");
    }
    snapshot.timestamp = Math.trunc(timestamp);
    snapshot.price = price;
    snapshot.cvd_1m = cvd;
    snapshot.oi_change = oiChange;
    snapshot.depth_imbalance = imbalance;
    if (snapshot.liquidation_usdt !== undefined) {
      const usdt = Number(snapshot.liquidation_usdt);
      if (!Number.isFinite(usdt)) throw new Error("snapshot liquidation_usdt 必須是有限數字");
      snapshot.liquidation_usdt = usdt;
    }
  }

  private tryLiquidationEntry(snapshot: StrategySnapshot): StrategyOrderEvent | null {
    const liqSide = snapshot.liquidation_side;
    const liqUsdt = Number(snapshot.liquidation_usdt ?? 0);
    if (liqSide !== "BUY" && liqSide !== "SELL") return null;
    if (!(liqUsdt > 0)) return null;
    if (this.inCooldown("liquidation_reversal", snapshot.timestamp)) return null;

    const side: PositionSide = liqSide === "SELL" ? "LONG" : "SHORT";
    const conditions: Record<string, unknown> = {
      liquidation_side: liqSide,
      liquidation_usdt: liqUsdt,
      entry_window: "1-5 minutes",
      entry_reason: "large liquidation may create a liquidity vacuum",
      take_profit_rule: "price reversion of 0.30%",
      stop_loss_rule: "adverse move of 0.50%",
    };
    return this.openPosition("liquidation_reversal", side, snapshot, conditions);
  }

  private tryCvdEntry(snapshot: StrategySnapshot): StrategyOrderEvent | null {
    const cvd = snapshot.cvd_1m;
    const oiChange = snapshot.oi_change;
    if (Math.abs(cvd) < this.opts.cvdThreshold || oiChange <= this.opts.oiIncreaseThreshold) {
      return null;
    }
    const direction: PositionSide = cvd > 0 ? "LONG" : "SHORT";
    if (
      this.cvdBreakoutDirection !== direction ||
      this.cvdBreakoutStreak < this.opts.cvdConfirmationUpdates
    ) {
      return null;
    }
    if (this.inCooldown("cvd_breakout", snapshot.timestamp)) return null;

    const conditions: Record<string, unknown> = {
      cvd_1m: cvd,
      cvd_threshold: this.opts.cvdThreshold,
      oi_change: oiChange,
      oi_increase_threshold: this.opts.oiIncreaseThreshold,
      confirmation_updates: this.opts.cvdConfirmationUpdates,
      entry_window: "5-15 minutes",
      entry_reason: "directional CVD and increasing OI indicate momentum",
      exit_rule: "CVD growth slows or opposite depth wall reaches 65%",
    };
    return this.openPosition("cvd_breakout", direction, snapshot, conditions);
  }

  private checkExits(snapshot: StrategySnapshot): StrategyOrderEvent[] {
    const events: StrategyOrderEvent[] = [];
    for (const [strategy, position] of this.positions) {
      const signedReturn = this.signedReturn(position, snapshot.price);
      const holdMs = snapshot.timestamp - position.entryTime;
      let reason: string | null = null;

      if (strategy === "liquidation_reversal") {
        if (signedReturn >= this.opts.liquidationTakeProfit) {
          reason = "liquidity vacuum reversion target reached";
        } else if (signedReturn <= this.opts.liquidationStopLoss) {
          reason = "risk stop reached";
        } else if (holdMs >= this.opts.liquidationMaxHoldMs) {
          reason = "maximum liquidation-reversal window reached";
        }
      } else if (strategy === "cvd_breakout") {
        const oppositeWall =
          position.side === "LONG"
            ? snapshot.depth_imbalance <= 1 - this.opts.oppositeWallRatio
            : snapshot.depth_imbalance >= this.opts.oppositeWallRatio;
        // B-4：停損最優先——虧損守護不等待放緩/牆/持倉上限
        if (signedReturn <= this.opts.cvdStopLoss) {
          reason = "risk stop reached";
        } else if (position.cvdSlowCount >= this.opts.cvdSlowCount) {
          reason = "CVD growth slowed for three updates";
        } else if (oppositeWall) {
          reason = "opposite order-book wall reached 65%";
        } else if (holdMs >= this.opts.cvdMaxHoldMs) {
          reason = "maximum CVD-breakout window reached";
        }
      }

      if (reason) events.push(this.closePosition(strategy, snapshot, signedReturn, reason));
    }
    return events;
  }

  private openPosition(
    strategy: StrategyId,
    side: PositionSide,
    snapshot: StrategySnapshot,
    conditions: Record<string, unknown>
  ): StrategyOrderEvent | null {
    // B-3：資本已耗盡（≤0）不再開倉——否則 quantity≤0、部位反向、虧損無上界
    if (this.capital <= 0) return null;
    const price = snapshot.price;
    const quantity = (this.capital * this.opts.positionAllocation) / price;
    const position: StrategyPosition = {
      strategy,
      side,
      entryTime: snapshot.timestamp,
      entryPrice: price,
      quantity,
      triggerConditions: conditions,
      previousCvd: strategy === "cvd_breakout" ? snapshot.cvd_1m : null,
      cvdSlowCount: 0,
    };
    this.positions.set(strategy, position);
    return {
      timestamp: snapshot.timestamp,
      strategy,
      action: "ENTRY",
      side,
      price,
      quantity,
      pnl: 0,
      capitalBefore: this.capital,
      capitalAfter: this.capital,
      conditions,
    };
  }

  private closePosition(
    strategy: StrategyId,
    snapshot: StrategySnapshot,
    signedReturn: number,
    reason: string
  ): StrategyOrderEvent {
    const position = this.positions.get(strategy);
    if (!position) throw new Error(`no open ${strategy} position`);
    this.positions.delete(strategy);

    const entryNotional = position.entryPrice * position.quantity;
    const pnl = entryNotional * signedReturn;
    const capitalBefore = this.capital;
    this.capital += pnl;
    this.lastExitTime.set(strategy, snapshot.timestamp);

    const conditions: Record<string, unknown> = {
      exit_reason: reason,
      signed_return_pct: signedReturn * 100,
      hold_minutes: (snapshot.timestamp - position.entryTime) / 60_000,
      entry_conditions: position.triggerConditions,
    };
    return {
      timestamp: snapshot.timestamp,
      strategy,
      action: "EXIT",
      side: position.side,
      price: snapshot.price,
      quantity: position.quantity,
      pnl,
      capitalBefore,
      capitalAfter: this.capital,
      conditions,
    };
  }

  private signedReturn(position: StrategyPosition, price: number): number {
    const rawReturn = (price - position.entryPrice) / position.entryPrice;
    return position.side === "LONG" ? rawReturn : -rawReturn;
  }

  private inCooldown(strategy: StrategyId, timestamp: number): boolean {
    const lastExit = this.lastExitTime.get(strategy);
    return lastExit !== undefined && timestamp - lastExit < this.opts.cooldownMs;
  }

  private updateCvdState(cvd: number, oiChange: number): void {
    if (Math.abs(cvd) >= this.opts.cvdThreshold && oiChange > this.opts.oiIncreaseThreshold) {
      const direction: PositionSide = cvd > 0 ? "LONG" : "SHORT";
      if (direction === this.cvdBreakoutDirection) {
        this.cvdBreakoutStreak += 1;
      } else {
        this.cvdBreakoutDirection = direction;
        this.cvdBreakoutStreak = 1;
      }
    } else {
      this.cvdBreakoutDirection = null;
      this.cvdBreakoutStreak = 0;
    }

    const position = this.positions.get("cvd_breakout");
    if (!position) return;
    if (position.previousCvd !== null && Math.abs(cvd) < Math.abs(position.previousCvd)) {
      position.cvdSlowCount += 1;
    } else {
      position.cvdSlowCount = 0;
    }
    position.previousCvd = cvd;
  }
}

/** 把事件轉成 DB 一列所需的 JSON 字串（conditions sort_keys） */
export function eventTriggerJson(event: StrategyOrderEvent): string {
  return sortedJson(event.conditions);
}

/** 事件單行原因：ENTRY 用 entry_reason，EXIT 用 exit_reason */
export function eventReason(event: StrategyOrderEvent): string {
  const cond = event.conditions;
  const reason = event.action === "EXIT" ? cond.exit_reason : cond.entry_reason;
  return typeof reason === "string" ? reason : "";
}
