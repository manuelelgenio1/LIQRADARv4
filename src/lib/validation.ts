// ============================================================
// Laboratorio de validación: track record de los pools detectados.
// Registra cada pool con timestamp y mide si el precio lo barre y
// qué ocurre después (reversión vs continuación), comparando contra
// niveles de control al azar para distinguir señal real de ruido.
// ============================================================
import type { Candle, LiqCluster } from "./market";

export type PoolStatus = "pendiente" | "barrido" | "expirado";
export type PoolOutcome = "reversion" | "continuacion" | "neutral";

export interface PoolRecord {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;          // nivel del pool
  detectedAt: number;
  detectedPrice: number;  // precio en el momento de la detección
  sizeUsd: number;
  isControl: boolean;     // nivel al azar (línea base estadística)
  status: PoolStatus;
  sweptAt?: number;
  sweptPrice?: number;
  outcome?: PoolOutcome | null;
  resolvedAt?: number;
}

const LS_KEY = "liqradar:poolog:v1";
const MAX_RECORDS = 240;
const SWEEP_TOL = 0.0012;   // ±0,12 % — tolerancia MÁXIMA de barrido
const RESOLVE_MS = 15 * 60_000;  // 15 min para clasificar el resultado
const EXPIRE_MS = 6 * 3600_000;  // 6 h sin barrer → expirado
const MOVE_PCT = 0.4;       // rebote MÁXIMO (%) para clasificar reversión

// ---------- umbrales ADAPTATIVOS (sin sesgo por temporalidad) ----------
// Los pools están a distancias muy distintas según el timeframe (0,05 % en 1m,
// 2 % en 1D). Usar tolerancias absolutas sesga las métricas: en 1m un pool nace
// ya "barrido" (tolerancia > distancia) y nunca "revierte" (umbral inalcanzable).
// Cada umbral escala con la distancia propia del pool, con un piso/suelo sensato.

// Distancia inicial del pool respecto al precio de detección (fracción).
const initDist = (r: PoolRecord): number =>
  r.detectedPrice > 0 ? Math.abs(r.price - r.detectedPrice) / r.detectedPrice : 0;

// Tolerancia de barrido: nunca mayor que la distancia del pool (evita el
// "barrido instantáneo"), acotada al máximo global.
const sweepTolFor = (r: PoolRecord): number =>
  Math.min(SWEEP_TOL, Math.max(SWEEP_TOL * 0.15, initDist(r) * 0.45));

// Umbral de reversión (%): escala con la distancia del pool, piso de 0,15 %.
const moveThrFor = (r: PoolRecord): number =>
  Math.min(MOVE_PCT, Math.max(0.15, initDist(r) * 100 * 0.5));

export function loadPoolLog(): PoolRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as PoolRecord[];
    if (!Array.isArray(p)) return [];
    // saneamiento: registros corruptos de versiones previas
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
 * Sincroniza el laboratorio con el estado actual del mercado.
 * Opera sobre el log que ya está en memoria (React state) — nunca relee
 * localStorage en caliente, así varias pestañas no se pisan en cada tick.
 * Solo persiste cuando hubo cambios reales.
 */
export function syncPools(
  log: PoolRecord[],
  symbol: string,
  clusters: LiqCluster[],
  price: number,
  now: number
): PoolRecord[] {
  if (!Number.isFinite(price) || price <= 0) return log;
  let dirty = false;

  // ---- 1 · actualizar registros existentes de este símbolo ----
  for (const r of log) {
    if (r.symbol !== symbol) continue;
    if (r.status === "pendiente") {
      // tolerancia adaptativa: nunca mayor que la distancia propia del pool
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
      // umbral de reversión adaptativo: escala con la distancia del pool
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

  // ---- 2 · registrar pools nuevos detectados por el radar ----
  // Umbrales ADAPTATIVOS: los clústeres ya vienen distribuidos relativos al
  // rango de la temporalidad, así que la "distancia significativa" mínima debe
  // escalar con ellos (en 1m los pools legítimos están mucho más cerca en %
  // absoluto que en 1D). Se toma la mediana de distancias como referencia.
  const withDist = clusters.map((c) => ({ c, dist: Math.abs(c.price - price) / price }));
  const sortedDists = withDist.map((d) => d.dist).sort((a, b) => a - b);
  const median = sortedDists[Math.floor(sortedDists.length / 2)] || 0.003;
  const minDist = Math.max(SWEEP_TOL / 3, Math.min(0.0015, median * 0.25));
  const maxDist = Math.max(0.045, median * 4);
  // dedup relativo al espaciado real de los clústeres: en 1m los pools legítimos
  // están a ~0,05 % entre sí, así que una ventana absoluta de 0,3 % los
  // deduplicaría a todos. Se acota a la mitad de la distancia mediana.
  const dedupTol = Math.min(0.003, Math.max(0.0004, median * 0.5));
  const cands = withDist
    .filter((d) => d.dist > minDist && d.dist < maxDist)
    .sort((a, b) => b.c.sizeUsd - a.c.sizeUsd)
    .slice(0, 6)
    .map((d) => d.c);

  let registered = 0;
  for (const c of cands) {
    // un nivel ya cuenta si está pendiente, o si fue barrido hace menos de 1 h
    // (evita re-registrar el mismo pool y duplicar estadísticas)
    const dup = log.some(
      (r) =>
        r.symbol === symbol &&
        r.side === c.side &&
        Math.abs(r.price - c.price) / c.price < dedupTol &&
        (r.status === "pendiente" ||
          (r.status === "barrido" && r.sweptAt != null && now - r.sweptAt < 3600_000))
    );
    if (dup) continue;
    log.unshift({
      id: `p-${now}-${Math.floor(Math.random() * 1e6)}-${c.price.toFixed(2)}`,
      symbol,
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

  // ---- 3 · sembrar controles al azar (línea base contra el azar) ----
  if (registered > 0 && Math.random() < 0.55) {
    const off = (Math.random() * 2 + 0.2) / 100; // 0,2 % – 2,2 %
    const side: "long" | "short" = Math.random() > 0.5 ? "long" : "short";
    log.unshift({
      id: `c-${now}-${Math.floor(Math.random() * 1e6)}`,
      symbol,
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

  // persistir solo cuando hubo cambios reales (evita escribir cada 3 s)
  if (dirty) savePoolLog(log);
  return log.slice(0, MAX_RECORDS);
}

export interface PoolStats {
  total: number;
  pending: number;
  swept: number;
  expired: number;
  hitRate: number;        // barridos / (barridos + expirados)
  controlHitRate: number; // lo mismo para los controles al azar
  reversalRate: number;   // reversiones / resueltos
  reversals: number;
  continuations: number;
  avgSweepMin: number;    // minutos medios hasta el barrido
}

export function computeStats(log: PoolRecord[], symbol?: string): PoolStats {
  const rows = symbol ? log.filter((r) => r.symbol === symbol) : log;
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
// Backtesting histórico: valida la hipótesis del radar contra el
// pasado SIN look-ahead. Recorre la serie de velas (la semilla warm,
// hasta 500 velas reales); en cada punto reconstruye el perfil de
// liquidez con las velas ANTERIORES (igual que el radar), detecta los
// clústeres con la misma lógica de picos, y comprueba hacia ADELANTE
// si el precio los barre y revierte. Compara contra niveles de control
// al azar para separar señal real de ruido.
// ============================================================
export interface BacktestResult {
  tested: number;          // pools del radar evaluados
  swept: number;           // pools barridos por el precio
  hitRate: number;         // swept / tested
  controls: number;        // niveles de control al azar evaluados
  controlSwept: number;
  controlHitRate: number;
  margin: number;          // (hitRate - controlHitRate) en puntos (0-100)
  reversals: number;
  continuations: number;
  neutrals: number;
  reversalRate: number;    // reversiones / (reversiones + continuidades)
  signal: "real" | "ruido" | "neutral" | "insuficiente";
  steps: number;           // puntos de detección recorridos
  candles: number;         // velas de la serie usada
}

// PRNG determinista (resultados reproducibles para la misma serie)
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BT_BINS = 92; // misma resolución que el heatmap (HEAT_BINS)

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
  const profileW = 14;  // velas recientes para el perfil (igual que el radar)
  const rangeBack = 40; // velas para el rango local
  const rand = mulberry32(opts?.seed ?? 1234);

  const empty: BacktestResult = {
    tested: 0, swept: 0, hitRate: NaN, controls: 0, controlSwept: 0,
    controlHitRate: NaN, margin: NaN, reversals: 0, continuations: 0,
    neutrals: 0, reversalRate: NaN, signal: "insuficiente", steps: 0, candles: n,
  };
  if (n < warmup + lookahead + resolveAfter + 10) return empty;

  // Umbral de reversión (%): escala con el rango medio de vela y la ventana de
  // resolución (el movimiento esperado crece con ~√t). Unidades consistentes: %.
  let rangeSum = 0;
  for (const k of candles) rangeSum += (k.h - k.l) / k.c;
  const avgRangePct = (rangeSum / n) * 100;
  const movePct = Math.max(0.12, avgRangePct * Math.sqrt(resolveAfter) * 0.7);

  let tested = 0, swept = 0, reversals = 0, continuations = 0, neutrals = 0;
  let controls = 0, controlSwept = 0;
  let steps = 0;

  // Prueba un nivel: ¿el precio lo barre en las próximas `lookahead` velas?
  // Si lo barre, mide qué pasa `resolveAfter` velas después (reversión/continuación).
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
      return; // solo cuenta el primer barrido
    }
  };

  for (let i = warmup; i <= n - lookahead - resolveAfter; i += step) {
    steps++;
    const cur = candles[i].c;

    // Rango local de las últimas `rangeBack` velas (para bins y distancias)
    let rMin = Infinity, rMax = -Infinity;
    for (let r = Math.max(0, i - rangeBack); r <= i; r++) {
      rMin = Math.min(rMin, candles[r].l);
      rMax = Math.max(rMax, candles[r].h);
    }
    const localRange = rMax - rMin || cur * 0.001;

    // Perfil de liquidez SOLO con velas anteriores (sin look-ahead):
    // deposita liquidez en los máximos/mínimos (donde se acumulan stops),
    // ponderada por volumen — el mismo método que usa el radar.
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

    // Picos = clústeres (misma lógica del radar: máximo local genuino, dedup)
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

    // Controles al azar en la misma banda de distancia (línea base)
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
    signal = margin >= 8 ? "real" : margin <= -8 ? "ruido" : "neutral";
  }

  return {
    tested, swept, hitRate, controls, controlSwept, controlHitRate,
    margin, reversals, continuations, neutrals, reversalRate, signal, steps, candles: n,
  };
}
