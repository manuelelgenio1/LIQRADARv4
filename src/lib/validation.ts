// ============================================================
// Laboratorio de validación: track record de pools + backtest.
// ============================================================
import { mulberry32 } from "./market";
import type { Candle, LiqCluster } from "./market";

export type PoolStatus = "pendiente" | "barrido" | "expirado";
export type PoolOutcome = "reversion" | "continuacion" | "neutral";

export interface PoolRecord {
  id: string;
  symbol: string;
  market?: "perp" | "spot"; // registros antiguos sin campo se tratan como "perp"
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
const SWEEP_TOL = 0.0012;   // tolerancia MÁXIMA de barrido
const RESOLVE_MS = 15 * 60_000;
const EXPIRE_MS = 6 * 3600_000;
const MOVE_PCT = 0.4;       // rebote MÁXIMO (%) para clasificar reversión

// ---------- umbrales ADAPTATIVOS (sin sesgo por temporalidad) ----------
const initDist = (r: PoolRecord): number =>
  r.detectedPrice > 0 ? Math.abs(r.price - r.detectedPrice) / r.detectedPrice : 0;

const sweepTolFor = (r: PoolRecord): number =>
  Math.min(SWEEP_TOL, Math.max(SWEEP_TOL * 0.15, initDist(r) * 0.45));

const moveThrFor = (r: PoolRecord): number =>
  Math.min(MOVE_PCT, Math.max(0.15, initDist(r) * 100 * 0.5));

export function loadPoolLog(): PoolRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as PoolRecord[];
    if (!Array.isArray(p)) return [];
    return p
      .filter((r) => r && Number.isFinite(r.price) && Number.isFinite(r.detectedAt))
      .slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function savePoolLog(log: PoolRecord[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(log.slice(0, MAX_RECORDS)));
  } catch {
    /* almacenamiento no disponible */
  }
}

/**
 * Sincroniza el laboratorio con el mercado actual, por (símbolo, mercado).
 * Opera sobre el log en memoria; persiste solo si hubo cambios.
 */
export function syncPools(
  log: PoolRecord[],
  symbol: string,
  market: "perp" | "spot",
  clusters: LiqCluster[],
  price: number,
  now: number
): PoolRecord[] {
  if (!Number.isFinite(price) || price <= 0) return log;
  let dirty = false;
  const sameMkt = (r: PoolRecord) => (r.market ?? "perp") === market;

  // ---- 1 · actualizar registros existentes ----
  for (const r of log) {
    if (r.symbol !== symbol || !sameMkt(r)) continue;
    if (r.status === "pendiente") {
      const touched = Math.abs(price - r.price) / r.price <= sweepTolFor(r);
      if (touched) {
        r.status = "barrido";
        r.sweptAt = now;
        r.sweptPrice = price;
        dirty = true;
      } else if (now - r.detectedAt > EXPIRE_MS) {
        r.status = "expirado";
        dirty = true;
      }
    } else if (r.status === "barrido" && !r.outcome && r.sweptAt && now - r.sweptAt >= RESOLVE_MS) {
      const rel = ((price - (r.sweptPrice ?? r.price)) / (r.sweptPrice ?? r.price)) * 100;
      const thr = moveThrFor(r);
      if (r.side === "long") {
        r.outcome = rel > thr ? "reversion" : rel < -thr ? "continuacion" : "neutral";
      } else {
        r.outcome = rel < -thr ? "reversion" : rel > thr ? "continuacion" : "neutral";
      }
      r.resolvedAt = now;
      dirty = true;
    }
  }

  // ---- 2 · registrar pools nuevos ----
  const withDist = clusters.map((c) => ({ c, dist: Math.abs(c.price - price) / price }));
  const sortedDists = withDist.map((d) => d.dist).sort((a, b) => a - b);
  const median = sortedDists[Math.floor(sortedDists.length / 2)] || 0.003;
  const minDist = Math.max(SWEEP_TOL / 3, Math.min(0.0015, median * 0.25));
  const maxDist = Math.max(0.045, median * 4);
  const dedupTol = Math.min(0.003, Math.max(0.0004, median * 0.5));
  const cands = withDist
    .filter((d) => d.dist > minDist && d.dist < maxDist)
    .sort((a, b) => b.c.sizeUsd - a.c.sizeUsd)
    .slice(0, 6)
    .map((d) => d.c);

  let registered = 0;
  for (const c of cands) {
    const dup = log.some(
      (r) =>
        r.symbol === symbol &&
        sameMkt(r) &&
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
    registered++;
    dirty = true;
  }

  // ---- 3 · controles al azar (línea base) ----
  if (registered > 0 && Math.random() < 0.55) {
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
    dirty = true;
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

export function computeStats(log: PoolRecord[], symbol?: string, market?: "perp" | "spot"): PoolStats {
  const rows = log.filter(
    (r) =>
      (!symbol || r.symbol === symbol) &&
      (!market || (r.market ?? "perp") === market)
  );
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

export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ============================================================
// Backtest histórico: reproduce la detección del radar sobre velas
// pasadas (sin look-ahead) y compara contra niveles al azar.
// ============================================================
const BT_BINS = 40;

export interface BacktestResult {
  tested: number;
  swept: number;
  hitRate: number;
  controls: number;
  controlSwept: number;
  controlHitRate: number;
  margin: number;
  reversals: number;
  continuations: number;
  neutrals: number;
  reversalRate: number;
  signal: "real" | "ruido" | "neutral" | "insuficiente";
  steps: number;
  candles: number;
}

export function runBacktest(
  candles: Candle[],
  opts?: { warmup?: number; step?: number; lookahead?: number; resolveAfter?: number; controlsPerStep?: number; seed?: number }
): BacktestResult {
  const n = candles.length;
  const warmup = opts?.warmup ?? 60;
  const step = opts?.step ?? 8;
  const lookahead = opts?.lookahead ?? 40;
  const resolveAfter = opts?.resolveAfter ?? 12;
  const controlsPerStep = opts?.controlsPerStep ?? 2;
  const profileW = 14;
  const rangeBack = 40;
  const rand = mulberry32(opts?.seed ?? 1234);

  const empty: BacktestResult = {
    tested: 0, swept: 0, hitRate: NaN, controls: 0, controlSwept: 0,
    controlHitRate: NaN, margin: NaN, reversals: 0, continuations: 0,
    neutrals: 0, reversalRate: NaN, signal: "insuficiente", steps: 0, candles: n,
  };
  if (n < warmup + lookahead + resolveAfter + 10) return empty;

  // Umbral de reversión (%): escala con el rango medio y √t
  let rangeSum = 0;
  for (const k of candles) rangeSum += (k.h - k.l) / k.c;
  const avgRangePct = (rangeSum / n) * 100;
  const movePct = Math.max(0.12, avgRangePct * Math.sqrt(resolveAfter) * 0.7);

  let tested = 0, swept = 0, reversals = 0, continuations = 0, neutrals = 0;
  let controls = 0, controlSwept = 0;
  let steps = 0;

  const testLevel = (price: number, side: "long" | "short", startIdx: number, isControl: boolean) => {
    const limit = Math.min(n - 1, startIdx + lookahead);
    for (let j = startIdx + 1; j <= limit; j++) {
      const k = candles[j];
      const hit = side === "long" ? k.l <= price : k.h >= price;
      if (!hit) continue;
      if (isControl) {
        controlSwept++;
      } else {
        swept++;
        const future = candles[Math.min(n - 1, j + resolveAfter)].c;
        const rel = ((future - price) / price) * 100;
        if (side === "long") {
          if (rel > movePct) reversals++;
          else if (rel < -movePct) continuations++;
          else neutrals++;
        } else {
          if (rel < -movePct) reversals++;
          else if (rel > movePct) continuations++;
          else neutrals++;
        }
      }
      return;
    }
  };

  for (let i = warmup; i <= n - lookahead - resolveAfter; i += step) {
    steps++;
    const cur = candles[i].c;

    let rMin = Infinity, rMax = -Infinity;
    for (let r = Math.max(0, i - rangeBack); r <= i; r++) {
      rMin = Math.min(rMin, candles[r].l);
      rMax = Math.max(rMax, candles[r].h);
    }
    const localRange = rMax - rMin || cur * 0.001;

    // perfil SOLO con velas anteriores (sin look-ahead)
    const prof = new Float64Array(BT_BINS);
    for (let r = Math.max(0, i - profileW + 1); r <= i; r++) {
      const k = candles[r];
      const w = Math.max(1e-9, k.v);
      for (const px of [k.h, k.l]) {
        const bin = Math.round(((px - rMin) / localRange) * (BT_BINS - 1));
        for (let db = -2; db <= 2; db++) {
          const b = bin + db;
          if (b >= 0 && b < BT_BINS) prof[b] += w * Math.exp(-(db * db) / 2);
        }
      }
    }
    let maxProf = 0;
    for (let b = 0; b < BT_BINS; b++) maxProf = Math.max(maxProf, prof[b]);
    if (maxProf <= 0) continue;

    const used: number[] = [];
    const peaks: number[] = [];
    for (let b = 2; b < BT_BINS - 2; b++) {
      const v = prof[b];
      if (v > maxProf * 0.42 && v >= prof[b - 1] && v >= prof[b + 1] && v > prof[b - 2] && v > prof[b + 2]) {
        if (used.some((u) => Math.abs(u - b) < 4)) continue;
        used.push(b);
        peaks.push(b);
        if (peaks.length >= 6) break;
      }
    }
    for (const b of peaks) {
      const price = rMin + ((b + 0.5) / BT_BINS) * localRange;
      const frac = Math.abs(price - cur) / localRange;
      if (frac < 0.05 || frac > 0.5) continue;
      tested++;
      testLevel(price, price < cur ? "long" : "short", i, false);
    }

    for (let c = 0; c < controlsPerStep; c++) {
      const frac = 0.05 + rand() * 0.45;
      const sideIsLong = rand() > 0.5;
      const price = sideIsLong ? cur - frac * localRange : cur + frac * localRange;
      controls++;
      testLevel(price, sideIsLong ? "long" : "short", i, true);
    }
  }

  const hitRate = tested ? swept / tested : NaN;
  const controlHitRate = controls ? controlSwept / controls : NaN;
  const margin =
    Number.isFinite(hitRate) && Number.isFinite(controlHitRate) ? (hitRate - controlHitRate) * 100 : NaN;
  const resolvable = reversals + continuations;
  const reversalRate = resolvable ? reversals / resolvable : NaN;

  let signal: BacktestResult["signal"] = "insuficiente";
  if (tested >= 20 && controls >= 20 && Number.isFinite(margin)) {
    if (margin >= 8) signal = "real";
    else if (margin <= -5) signal = "ruido";
    else signal = "neutral";
  }

  return {
    tested, swept, hitRate, controls, controlSwept, controlHitRate, margin,
    reversals, continuations, neutrals, reversalRate, signal, steps, candles: n,
  };
}
