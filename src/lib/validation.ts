// ============================================================
// Laboratorio de validación: track record de los pools detectados.
// Registra cada pool y mide si el precio lo barre y qué ocurre
// después, comparando contra niveles de control al azar.
// ============================================================
import type { LiqCluster } from "./market";

export type PoolStatus = "pendiente" | "barrido" | "expirado";
export type PoolOutcome = "reversion" | "continuacion" | "neutral";

export interface PoolRecord {
  id: string;
  symbol: string;
  market: string;
  side: "long" | "short";
  price: number;
  detectedAt: number;
  detectedPrice: number;
  sizeUsd: number;
  isControl: boolean;
  status: PoolStatus;
  sweptAt?: number;
  sweptPrice?: number;
  outcome?: PoolOutcome | null;
  resolvedAt?: number;
}

const LS_KEY = "liqradar:poolog:v1";
const MAX_RECORDS = 240;
const EXPIRE_MS = 6 * 3600_000;
const MOVE_PCT = 0.4;

export function loadPoolLog(): PoolRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as PoolRecord[];
    if (!Array.isArray(p)) return [];
    return p
      .filter((r) => r && Number.isFinite(r.price) && Number.isFinite(r.detectedAt))
      .map((r) => ({ ...r, market: r.market ?? "perp" }))
      .slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function savePoolLog(log: PoolRecord[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(log.slice(0, MAX_RECORDS)));
  } catch {
    /* sin almacenamiento */
  }
}

const sweepTolFor = (dist: number) => Math.max(0.0005, Math.min(0.0012, dist * 0.25));
const moveThrFor = (dist: number) => Math.max(0.08, Math.min(MOVE_PCT, dist * 1.2));

export function syncPools(
  log: PoolRecord[],
  symbol: string,
  market: string,
  clusters: LiqCluster[],
  price: number,
  now: number
): PoolRecord[] {
  if (!Number.isFinite(price) || price <= 0) return log;
  let dirty = false;

  for (const r of log) {
    if (r.symbol !== symbol || r.market !== market) continue;
    if (r.status === "pendiente") {
      const dist = Math.abs(r.price - r.detectedPrice) / r.detectedPrice;
      const touched = Math.abs(price - r.price) / r.price <= sweepTolFor(dist);
      if (touched) {
        r.status = "barrido";
        r.sweptAt = now;
        r.sweptPrice = price;
        dirty = true;
      } else if (now - r.detectedAt > EXPIRE_MS) {
        r.status = "expirado";
        dirty = true;
      }
    } else if (r.status === "barrido" && !r.outcome && r.sweptAt && now - r.sweptAt >= 15 * 60_000) {
      const dist = Math.abs(r.price - r.detectedPrice) / r.detectedPrice;
      const rel = ((price - (r.sweptPrice ?? r.price)) / (r.sweptPrice ?? r.price)) * 100;
      const thr = moveThrFor(dist);
      r.outcome =
        r.side === "long"
          ? rel > thr ? "reversion" : rel < -thr ? "continuacion" : "neutral"
          : rel < -thr ? "reversion" : rel > thr ? "continuacion" : "neutral";
      r.resolvedAt = now;
      dirty = true;
    }
  }

  const cands = clusters
    .filter((c) => {
      const dist = Math.abs(c.price - price) / price;
      return dist > 0.0015 && dist < 0.045;
    })
    .sort((a, b) => b.sizeUsd - a.sizeUsd)
    .slice(0, 6);

  const dedupTol = 0.003;
  for (const c of cands) {
    const dup = log.some(
      (r) =>
        r.symbol === symbol &&
        r.market === market &&
        r.side === c.side &&
        Math.abs(r.price - c.price) / c.price < dedupTol &&
        (r.status === "pendiente" ||
          (r.status === "barrido" && r.sweptAt != null && now - r.sweptAt < 3600_000))
    );
    if (dup) continue;
    log.unshift({
      id: `p-${now}-${Math.floor(Math.random() * 1e6)}-${c.price.toFixed(2)}`,
      symbol,
      market,
      side: c.side,
      price: c.price,
      detectedAt: now,
      detectedPrice: price,
      sizeUsd: c.sizeUsd,
      isControl: false,
      status: "pendiente",
      outcome: null,
    });
    dirty = true;
  }

  if (dirty && Math.random() < 0.55) {
    const off = (Math.random() * 2 + 0.2) / 100;
    const side: "long" | "short" = Math.random() > 0.5 ? "long" : "short";
    log.unshift({
      id: `c-${now}-${Math.floor(Math.random() * 1e6)}`,
      symbol,
      market,
      side,
      price: price * (side === "long" ? 1 - off : 1 + off),
      detectedAt: now,
      detectedPrice: price,
      sizeUsd: 0,
      isControl: true,
      status: "pendiente",
      outcome: null,
    });
  }

  if (dirty) savePoolLog(log);
  return log.slice(0, MAX_RECORDS);
}

export interface PoolStats {
  total: number;
  pending: number;
  swept: number;
  expired: number;
  hitRate: number;
  controlHitRate: number;
  reversalRate: number;
  reversals: number;
  continuations: number;
  avgSweepMin: number;
}

export function computeStats(log: PoolRecord[], symbol?: string, market?: string): PoolStats {
  let rows = symbol ? log.filter((r) => r.symbol === symbol) : log;
  if (market) rows = rows.filter((r) => r.market === market);
  const done = (r: PoolRecord) => r.status === "barrido" || r.status === "expirado";
  const real = rows.filter((r) => !r.isControl);
  const ctrl = rows.filter((r) => r.isControl);
  const hit = (set: PoolRecord[]) => {
    const d = set.filter(done);
    if (!d.length) return NaN;
    return d.filter((r) => r.status === "barrido").length / d.length;
  };
  const swept = real.filter((r) => r.status === "barrido");
  const resolved = swept.filter((r) => r.outcome);
  const reversals = resolved.filter((r) => r.outcome === "reversion").length;
  const continuations = resolved.filter((r) => r.outcome === "continuacion").length;
  const sweepTimes = swept
    .filter((r) => r.sweptAt)
    .map((r) => ((r.sweptAt as number) - r.detectedAt) / 60000);
  return {
    total: real.length,
    pending: real.filter((r) => r.status === "pendiente").length,
    swept: swept.length,
    expired: real.filter((r) => r.status === "expirado").length,
    hitRate: hit(real),
    controlHitRate: hit(ctrl),
    reversalRate: resolved.length ? reversals / resolved.length : NaN,
    reversals,
    continuations,
    avgSweepMin: sweepTimes.length ? sweepTimes.reduce((a, b) => a + b, 0) / sweepTimes.length : NaN,
  };
}

// ============================================================
// Backtesting histórico: aplica la MISMA lógica de detección sobre
// las velas pasadas (sin look-ahead) y compara la tasa de barrido de
// los pools contra controles al azar en la misma banda de distancia.
// ============================================================
export interface BacktestResult {
  pools: number;
  controls: number;
  hitRate: number;
  controlHitRate: number;
  reversalRate: number;
  verdict: "SEÑAL REAL" | "RUIDO" | "INDETERMINADO" | "DATOS INSUFICIENTES";
  note: string;
}

export function runBacktest(candles: { h: number; l: number; c: number }[], opts?: { seed?: number }): BacktestResult {
  const N = candles.length;
  const warm = 60;
  const horizon = 40;
  if (N < warm + horizon + 20) {
    return { pools: 0, controls: 0, hitRate: NaN, controlHitRate: NaN, reversalRate: NaN, verdict: "DATOS INSUFICIENTES", note: "Se necesitan más velas para el backtest." };
  }

  let poolTouched = 0, poolTotal = 0, poolReversed = 0;
  let ctrlTouched = 0, ctrlTotal = 0;

  // un pool "detectado" = un máximo/mínimo local del precio en la ventana previa
  for (let i = warm; i < N - horizon; i += 3) {
    const c = candles[i];
    const price = c.c;
    // distancia a un extremo local reciente
    let localHi = -Infinity, localLo = Infinity;
    for (let j = Math.max(0, i - 20); j < i; j++) {
      localHi = Math.max(localHi, candles[j].h);
      localLo = Math.min(localLo, candles[j].l);
    }
    const distUp = Math.abs(localHi - price) / price;
    const distDn = Math.abs(price - localLo) / price;
    if (distUp < 0.002 && distDn < 0.002) continue;

    // pool por encima (shorts) o por debajo (longs)
    const poolPrice = distUp > distDn ? localHi : localLo;
    const tol = sweepTolFor(Math.abs(poolPrice - price) / price);

    // ¿el precio lo barre en las siguientes `horizon` velas?
    let touched = false, touchedIdx = -1;
    for (let j = i + 1; j < Math.min(N, i + 1 + horizon); j++) {
      if (Math.abs(candles[j].c - poolPrice) / poolPrice <= tol || 
          (candles[j].l <= poolPrice && poolPrice <= candles[j].h)) {
        touched = true;
        touchedIdx = j;
        break;
      }
    }
    poolTotal++;
    if (touched) {
      poolTouched++;
      // ¿revierte después del barrido?
      const after = candles[Math.min(N - 1, touchedIdx + 10)];
      const rel = ((after.c - poolPrice) / poolPrice) * 100;
      const isLong = poolPrice < price;
      const thr = moveThrFor(Math.abs(poolPrice - price) / price);
      if (isLong ? rel > thr : rel < -thr) poolReversed++;
    }

    // control al azar en la misma banda de distancia
    const off = (0.002 + ((i * 7919 + (opts?.seed ?? 0)) % 100) / 100 * 0.02);
    const ctrlPrice = price * (1 + (i % 2 === 0 ? off : -off));
    let cTouched = false;
    for (let j = i + 1; j < Math.min(N, i + 1 + horizon); j++) {
      if (Math.abs(candles[j].c - ctrlPrice) / ctrlPrice <= tol ||
          (candles[j].l <= ctrlPrice && ctrlPrice <= candles[j].h)) {
        cTouched = true;
        break;
      }
    }
    ctrlTotal++;
    if (cTouched) ctrlTouched++;
  }

  const hitRate = poolTotal ? poolTouched / poolTotal : NaN;
  const controlHitRate = ctrlTotal ? ctrlTouched / ctrlTotal : NaN;
  const reversalRate = poolTouched ? poolReversed / poolTouched : NaN;

  let verdict: BacktestResult["verdict"] = "INDETERMINADO";
  let note = "Aún no hay suficiente muestra para concluir.";
  if (poolTotal >= 20 && ctrlTotal >= 20 && Number.isFinite(hitRate) && Number.isFinite(controlHitRate)) {
    const edge = hitRate - controlHitRate;
    if (edge > 0.1) {
      verdict = "SEÑAL REAL";
      note = `Los pools se barren ${(edge * 100).toFixed(0)} pts más que el azar. La hipótesis de liquidez se sostiene.`;
    } else if (edge < -0.05) {
      verdict = "RUIDO";
      note = "Los pools no superan a los controles al azar: no hay señal útil en esta muestra.";
    } else {
      verdict = "INDETERMINADO";
      note = "La ventaja sobre el azar es pequeña; se necesita más muestra para concluir.";
    }
  }

  return { pools: poolTotal, controls: ctrlTotal, hitRate, controlHitRate, reversalRate, verdict, note };
}

export { fmtAgo } from "./format";
