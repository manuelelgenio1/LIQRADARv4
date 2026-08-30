// ============================================================
// Laboratorio de validación: track record de los pools detectados.
// Registra cada pool con timestamp y mide si el precio lo barre y
// qué ocurre después (reversión vs continuación), comparando contra
// niveles de control al azar para distinguir señal real de ruido.
// ============================================================
import type { LiqCluster } from "./market";

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
const SWEEP_TOL = 0.0012;   // ±0,12 % para considerar un nivel "tocado"
const RESOLVE_MS = 15 * 60_000;  // 15 min para clasificar el resultado
const EXPIRE_MS = 6 * 3600_000;  // 6 h sin barrer → expirado
const MOVE_PCT = 0.4;       // rebote mínimo (%) para clasificar reversión

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
      const touched = Math.abs(price - r.price) / r.price <= SWEEP_TOL;
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
  const cands = clusters
    .filter((c) => {
      const dist = Math.abs(c.price - price) / price;
      return dist > 0.0015 && dist < 0.045;
    })
    .sort((a, b) => b.sizeUsd - a.sizeUsd)
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
