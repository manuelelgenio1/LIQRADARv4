// ============================================================
// Laboratorio de validación de pools de liquidación
// ------------------------------------------------------------
// Verifica la hipótesis conductual de los niveles detectados:
//   1. ¿el precio viaja a barrer el pool?      → tasa de barrido
//   2. ¿reacciona al tocarlo?                  → reversión vs continuación
//   3. ¿lo hace más que el azar?               → niveles de control al azar
// El historial persiste entre sesiones: la evidencia se acumula.
// ============================================================
import type { LiqCluster } from "./market";

export type PoolStatus = "pendiente" | "barrido" | "expirado";
export type PoolOutcome = "reversion" | "continuacion" | "neutral" | null;

export interface PoolRecord {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;          // nivel del pool
  detectedAt: number;
  detectedPrice: number;  // precio del mercado al detectarse
  sizeUsd: number;        // 0 en niveles de control
  isControl: boolean;     // nivel al azar (línea base)
  status: PoolStatus;
  sweptAt?: number;
  sweptPrice?: number;
  resolvedAt?: number;
  outcome: PoolOutcome;
}

export interface PoolStats {
  total: number;
  pending: number;
  swept: number;
  expired: number;
  hitRate: number;        // NaN si aún no hay resueltos
  controlHitRate: number;
  reversals: number;
  continuations: number;
  reversalRate: number;   // NaN si aún no hay barridos resueltos
  avgSweepMin: number;    // NaN si aún no hay barridos
}

const LS_KEY = "liqradar:poolog:v1";
const MAX_RECORDS = 240;

export const SWEEP_TOL = 0.0012;          // toque del nivel (±0,12 %)
export const EXPIRE_MS = 6 * 3600_000;    // pool sin barrer en 6 h → expira
export const RESOLVE_MS = 15 * 60_000;    // ventana para clasificar el resultado
export const MOVE_PCT = 0.004;            // 0,4 % define reversión/continuación

export function loadPoolLog(): PoolRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PoolRecord[];
      // saneamiento: descartar registros corruptos de versiones anteriores
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (r) =>
            r &&
            typeof r.price === "number" &&
            Number.isFinite(r.price) &&
            typeof r.detectedAt === "number" &&
            (r.status === "pendiente" || r.status === "barrido" || r.status === "expirado")
        );
      }
    }
  } catch {
    /* sin almacenamiento */
  }
  return [];
}

function save(log: PoolRecord[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(log.slice(0, MAX_RECORDS)));
  } catch {
    /* sin almacenamiento */
  }
}

/**
 * Sincroniza el laboratorio con el estado actual del mercado:
 * actualiza estados (barrido/expirado/resultado) y registra pools nuevos.
 */
export function syncPools(
  symbol: string,
  clusters: LiqCluster[],
  price: number,
  now: number
): PoolRecord[] {
  if (!Number.isFinite(price) || price <= 0) return loadPoolLog();
  const log = loadPoolLog();
  let dirty = false;

  // ---- 1 · actualizar registros existentes de este símbolo ----
  for (const r of log) {
    if (r.symbol !== symbol) continue;
    if (r.status === "pendiente") {
      const touched =
        r.side === "long"
          ? price <= r.price * (1 + SWEEP_TOL)
          : price >= r.price * (1 - SWEEP_TOL);
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
      const sp = r.sweptPrice ?? r.price;
      const rel = (price - sp) / sp;
      // pool de longs: el precio cayó hasta el nivel.
      //   reversion    = rebotó hacia arriba (el pool actuó de soporte/liquidez)
      //   continuacion = atravesó el nivel y siguió cayendo
      if (r.side === "long") {
        r.outcome = rel > MOVE_PCT ? "reversion" : rel < -MOVE_PCT ? "continuacion" : "neutral";
      } else {
        r.outcome = rel < -MOVE_PCT ? "reversion" : rel > MOVE_PCT ? "continuacion" : "neutral";
      }
      r.resolvedAt = now;
      dirty = true;
    }
  }

  // ---- 2 · registrar pools nuevos detectados por el radar ----
  const cands = [...clusters]
    .sort((a, b) => b.sizeUsd - a.sizeUsd)
    .filter((c) => {
      const dist = Math.abs(c.price - price) / price;
      return dist > 0.0015 && dist < 0.045;
    })
    .slice(0, 6);

  let registered = 0;
  for (const c of cands) {
    // un nivel ya cuenta si está pendiente, o si fue barrido hace menos de 1 h
    // (evita re-registrar el mismo pool y duplicar estadísticas)
    const dup = log.some(
      (r) =>
        r.symbol === symbol &&
        r.side === c.side &&
        Math.abs(r.price - c.price) / c.price < 0.003 &&
        (r.status === "pendiente" ||
          (r.status === "barrido" && r.sweptAt != null && now - r.sweptAt < 3600_000))
    );
    if (dup) continue;
    log.unshift({
      id: `p${now}-${Math.floor(Math.random() * 1e7)}`,
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

  // ---- 3 · niveles de control al azar (línea base estadística) ----
  const poolsPending = log.filter(
    (r) => r.symbol === symbol && !r.isControl && r.status === "pendiente"
  ).length;
  const controlsPending = log.filter(
    (r) => r.symbol === symbol && r.isControl && r.status === "pendiente"
  ).length;
  if ((registered > 0 || controlsPending < Math.min(4, poolsPending)) && controlsPending < 4) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const dist = 0.004 + Math.random() * 0.028;
    log.unshift({
      id: `c${now}-${Math.floor(Math.random() * 1e7)}`,
      symbol,
      side: sign < 0 ? "long" : "short",
      price: price * (1 + sign * dist),
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
  if (dirty) save(log);
  return log.slice(0, MAX_RECORDS);
}

/** Estadísticas del track record para un símbolo. */
export function computeStats(log: PoolRecord[], symbol: string): PoolStats {
  const rs = log.filter((r) => r.symbol === symbol);
  const real = rs.filter((r) => !r.isControl);
  const ctrl = rs.filter((r) => r.isControl);

  const hitOf = (arr: PoolRecord[]) => {
    const sw = arr.filter((r) => r.status === "barrido").length;
    const ex = arr.filter((r) => r.status === "expirado").length;
    return { sw, ex, rate: sw + ex > 0 ? sw / (sw + ex) : NaN };
  };
  const rh = hitOf(real);
  const ch = hitOf(ctrl);

  const reversals = real.filter((r) => r.outcome === "reversion").length;
  const continuations = real.filter((r) => r.outcome === "continuacion").length;
  const resolved = reversals + continuations;

  const sweepTimes = real
    .filter((r) => r.sweptAt != null)
    .map((r) => (r.sweptAt! - r.detectedAt) / 60000);
  const avgSweepMin = sweepTimes.length
    ? sweepTimes.reduce((a, b) => a + b, 0) / sweepTimes.length
    : NaN;

  return {
    total: rs.length,
    pending: real.filter((r) => r.status === "pendiente").length,
    swept: rh.sw,
    expired: rh.ex,
    hitRate: rh.rate,
    controlHitRate: ch.rate,
    reversals,
    continuations,
    reversalRate: resolved > 0 ? reversals / resolved : NaN,
    avgSweepMin,
  };
}

/** "hace 3 min" / "hace 2 h" / "12 may" */
export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.floor(s / 86400)} d`;
}
