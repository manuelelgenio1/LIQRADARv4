import type { LiqCluster, Candle } from "./market";

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

  for (const c of cands) {
    const dup = log.some(
      (r) =>
        r.symbol === symbol &&
        r.market === market &&
        r.side === c.side &&
        Math.abs(r.price - c.price) / c.price < 0.003 &&
        (r.status === "pendiente" || (r.status === "barrido" && r.sweptAt != null && now - r.sweptAt < 3600_000))
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
  const sweepTimes = swept.filter((r) => r.sweptAt).map((r) => ((r.sweptAt as number) - r.detectedAt) / 60000);
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

export interface BacktestResult {
  pools: number;
  controls: number;
  poolHitRate: number;
  controlHitRate: number;
  edge: number;
  verdict: "senal" | "ruido" | "indeterminado" | "insuficiente";
}

export function runBacktest(candles: Candle[], opts: { seed: number }): BacktestResult {
  const n = candles.length;
  if (n < 90) return { pools: 0, controls: 0, poolHitRate: NaN, controlHitRate: NaN, edge: NaN, verdict: "insuficiente" };

  let poolHit = 0, poolTested = 0, ctrlHit = 0, ctrlTested = 0;
  const rand = (() => {
    let a = opts.seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  for (let i = 40; i < n - 20; i += 7) {
    const price = candles[i].c;
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, i - 30); j <= i; j++) { lo = Math.min(lo, candles[j].l); hi = Math.max(hi, candles[j].h); }
    const span = hi - lo || 1;

    const testLevel = (lev: number, isPool: boolean) => {
      const tol = Math.max(0.0005, Math.abs(lev - price) / price * 0.25);
      let swept = false;
      for (let j = i + 1; j < Math.min(n, i + 21); j++) {
        if (Math.abs(candles[j].c - lev) / lev <= tol || candles[j].l <= lev && lev <= candles[j].h) { swept = true; break; }
      }
      if (isPool) { poolTested++; if (swept) poolHit++; }
      else { ctrlTested++; if (swept) ctrlHit++; }
    };

    const poolLev = price * (1 + (rand() > 0.5 ? 1 : -1) * (0.004 + rand() * 0.02));
    testLevel(poolLev, true);

    const ctrlLev = price * (1 + (rand() > 0.5 ? 1 : -1) * (0.004 + rand() * 0.02));
    testLevel(ctrlLev, false);
    void span;
  }

  const poolHitRate = poolTested ? poolHit / poolTested : NaN;
  const controlHitRate = ctrlTested ? ctrlHit / ctrlTested : NaN;
  const edge = poolHitRate - controlHitRate;

  let verdict: BacktestResult["verdict"] = "indeterminado";
  if (poolTested >= 20 && ctrlTested >= 20) {
    if (Number.isFinite(edge)) verdict = edge >= 0.1 ? "senal" : edge <= -0.05 ? "ruido" : "indeterminado";
  } else {
    verdict = "insuficiente";
  }

  return { pools: poolTested, controls: ctrlTested, poolHitRate, controlHitRate, edge, verdict };
}
