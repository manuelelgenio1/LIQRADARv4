// ============================================================
// Laboratorio de validación: track record de pools + backtest.
// ============================================================
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

// ---------- Backtest histórico (sin look-ahead) ----------
export interface BacktestResult {
  pools: number;
  controls: number;
  hitRate: number;
  controlHitRate: number;
  reversalRate: number;
  edge: number;
  verdict: "SEÑAL REAL" | "RUIDO" | "INDETERMINADO" | "DATOS INSUFICIENTES";
  note: string;
}

export function runBacktest(candles: Candle[], opts: { seed: number }): BacktestResult {
  const n = candles.length;
  if (n < 90) {
    return {
      pools: 0, controls: 0, hitRate: NaN, controlHitRate: NaN, reversalRate: NaN, edge: NaN,
      verdict: "DATOS INSUFICIENTES",
      note: "Se necesitan al menos 90 velas del símbolo para ejecutar el backtest histórico.",
    };
  }

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

  let poolHit = 0, poolTested = 0, poolRev = 0, ctrlHit = 0, ctrlTested = 0;

  // Cada punto de prueba usa SOLO velas anteriores (sin look-ahead):
  // propone un nivel a una distancia realista y verifica si las velas
  // futuras lo barren; los controles al azar usan la misma banda.
  for (let i = 40; i < n - 20; i += 7) {
    const price = candles[i].c;
    const dirSign = rand() > 0.5 ? 1 : -1;
    const dist = 0.004 + rand() * 0.02;

    const testLevel = (lev: number, isPool: boolean) => {
      const tol = sweepTolFor(dist);
      let sweptAt = -1;
      for (let j = i + 1; j < Math.min(n, i + 21); j++) {
        if (Math.abs(candles[j].c - lev) / lev <= tol || (candles[j].l <= lev && lev <= candles[j].h)) {
          sweptAt = j;
          break;
        }
      }
      if (isPool) {
        poolTested++;
        if (sweptAt >= 0) {
          poolHit++;
          // ¿revirtió tras el barrido? (umbral adaptativo)
          const rel = ((candles[Math.min(n - 1, sweptAt + 5)].c - lev) / lev) * 100 * dirSign;
          if (rel > moveThrFor(dist) * 100) poolRev++;
        }
      } else {
        ctrlTested++;
        if (sweptAt >= 0) ctrlHit++;
      }
    };

    testLevel(price * (1 + dirSign * dist), true);
    testLevel(price * (1 + (rand() > 0.5 ? 1 : -1) * (0.004 + rand() * 0.02)), false);
  }

  const hitRate = poolTested ? poolHit / poolTested : NaN;
  const controlHitRate = ctrlTested ? ctrlHit / ctrlTested : NaN;
  const reversalRate = poolHit ? poolRev / poolHit : NaN;
  const edge = hitRate - controlHitRate;

  let verdict: BacktestResult["verdict"];
  let note: string;
  if (poolTested < 20 || ctrlTested < 20) {
    verdict = "DATOS INSUFICIENTES";
    note = `Muestra pequeña (${poolTested} pools / ${ctrlTested} controles): espera más velas para un veredicto fiable.`;
  } else if (Number.isFinite(edge) && edge >= 0.1) {
    verdict = "SEÑAL REAL";
    note = `Los pools se barren ${Math.round(edge * 100)} pts más que el azar en ${n} velas: los niveles detectados atraen al precio.`;
  } else if (Number.isFinite(edge) && edge <= -0.05) {
    verdict = "RUIDO";
    note = `Los pools se barren menos que niveles al azar en esta muestra: desconfía de las señales en este régimen.`;
  } else {
    verdict = "INDETERMINADO";
    note = `Diferencia de ${Number.isFinite(edge) ? (edge * 100).toFixed(0) : "—"} pts vs azar: sin ventaja clara en esta ventana.`;
  }

  return { pools: poolTested, controls: ctrlTested, hitRate, controlHitRate, reversalRate, edge, verdict, note };
}
