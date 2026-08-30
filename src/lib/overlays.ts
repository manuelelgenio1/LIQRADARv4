// ============================================================
// Overlays del heatmap: funciones puras de análisis que se
// dibujan sobre el gráfico (sesiones, huecos, VWAP, Volume
// Profile, régimen de liquidez).
// ============================================================
import { HEAT_BINS } from "./market";

const DAY_MS = 86_400_000;

// ---------- líneas de sesión: PDH/PDL/PDO + sesión actual (días UTC) ----------
export interface Sessions {
  pdh: number; pdl: number; pdo: number;      // día anterior
  sdh: number; sdl: number; sdo: number;      // sesión (día) actual
  hasPrev: boolean;                           // false → no hay día anterior real
}

export function computeSessions(
  candles: { t: number; o: number; h: number; l: number }[],
  tfMin: number
): Sessions {
  const empty: Sessions = { pdh: NaN, pdl: NaN, pdo: NaN, sdh: NaN, sdl: NaN, sdo: NaN, hasPrev: false };
  if (!candles.length) return empty;
  const last = candles[candles.length - 1];
  if (tfMin >= 1440) {
    // velas diarias/semanales: la vela previa es "ayer"
    const prev = candles.length > 1 ? candles[candles.length - 2] : last;
    return { pdh: prev.h, pdl: prev.l, pdo: prev.o, sdh: last.h, sdl: last.l, sdo: last.o, hasPrev: candles.length > 1 };
  }
  const lastDay = Math.floor(last.t / DAY_MS);
  let pdh = -Infinity, pdl = Infinity, pdo = NaN;
  let sdh = -Infinity, sdl = Infinity, sdo = NaN;
  let hasPrev = false;
  for (const c of candles) {
    const d = Math.floor(c.t / DAY_MS);
    if (d === lastDay) {
      sdh = Math.max(sdh, c.h);
      sdl = Math.min(sdl, c.l);
      if (!Number.isFinite(sdo) || c.t < (sdo as unknown as number)) sdo = c.o;
    } else if (d === lastDay - 1) {
      hasPrev = true;
      pdh = Math.max(pdh, c.h);
      pdl = Math.min(pdl, c.l);
      if (!Number.isFinite(pdo)) pdo = c.o;
    }
  }
  return {
    pdh: hasPrev ? pdh : NaN,
    pdl: hasPrev ? pdl : NaN,
    pdo: hasPrev ? pdo : NaN,
    sdh: Number.isFinite(sdh) ? sdh : last.h,
    sdl: Number.isFinite(sdl) ? sdl : last.l,
    sdo: Number.isFinite(sdo) ? sdo : last.o,
    hasPrev,
  };
}

// ---------- detección de huecos de liquidez (bandas frías entre zonas calientes) ----------
export interface LiqVoid { yMin: number; yMax: number; center: number; width: number; }

export function computeVoids(
  candles: { t: number }[],
  heat: Float32Array,
  pMin: number,
  pMax: number,
  start: number
): LiqVoid[] {
  const span = pMax - pMin;
  if (!(span > 0)) return [];
  const BANDS = 48;
  const per = new Float64Array(BANDS);
  const cnt = new Float64Array(BANDS);
  for (let i = start; i < candles.length; i++) {
    for (let b = 0; b < HEAT_BINS; b++) {
      const v = heat[i * HEAT_BINS + b];
      if (v <= 0) continue;
      const price = pMin + ((b + 0.5) / HEAT_BINS) * span;
      const band = Math.min(BANDS - 1, Math.max(0, Math.floor(((price - pMin) / span) * BANDS)));
      per[band] += v;
      cnt[band] += 1;
    }
  }
  const avg = new Float64Array(BANDS);
  let maxAvg = 0;
  for (let b = 0; b < BANDS; b++) {
    avg[b] = cnt[b] > 0 ? per[b] / cnt[b] : 0;
    maxAvg = Math.max(maxAvg, avg[b]);
  }
  if (maxAvg <= 0) return [];
  const COLD = maxAvg * 0.06;   // una banda es "fría" si su calor medio es <6% del pico
  const HOT = maxAvg * 0.22;    // ...y debe estar flanqueada por bandas calientes
  const bandH = span / BANDS;
  const voids: LiqVoid[] = [];
  let b = 0;
  while (b < BANDS) {
    if (avg[b] < COLD) {
      let e = b;
      while (e + 1 < BANDS && avg[e + 1] < COLD) e++;
      const width = (e - b + 1) * bandH;
      const hasHotLeft = b > 0 && avg[b - 1] > HOT;
      const hasHotRight = e + 1 < BANDS && avg[e + 1] > HOT;
      // hueco válido: ancho mínimo, flanqueado por calor a ambos lados
      if (width >= span * 0.012 && hasHotLeft && hasHotRight) {
        const yMin = pMin + b * bandH;
        const yMax = pMin + (e + 1) * bandH;
        voids.push({ yMin, yMax, center: (yMin + yMax) / 2, width });
      }
      b = e + 1;
    } else {
      b++;
    }
  }
  // los 3 más anchos, ordenados por tamaño
  return voids.sort((a, z) => z.width - a.width).slice(0, 3);
}

// ---------- VWAP (precio medio ponderado por volumen, reiniciado por sesión UTC) ----------
export function computeVwap(candles: { t: number; h: number; l: number; c: number; v: number }[]): number[] {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (!n) return out;
  let cumPV = 0, cumV = 0;
  let curDay = Math.floor(candles[0].t / DAY_MS);
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const d = Math.floor(k.t / DAY_MS);
    if (d !== curDay) { cumPV = 0; cumV = 0; curDay = d; } // reset diario
    const typical = (k.h + k.l + k.c) / 3;
    const v = Math.max(0, k.v);
    cumPV += typical * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : k.c;
  }
  return out;
}

// ---------- Volume Profile: POC + Área de Valor (VAH/VAL, 70% del volumen) ----------
export interface VolProfile {
  poc: number; vah: number; val: number; total: number;
  rows: Float64Array; rowH: number; // histograma precalculado (lo reutiliza el dibujo)
}

export function computeVolProfile(
  candles: { h: number; l: number; c: number; v: number }[],
  pMin: number,
  pMax: number,
  start: number
): VolProfile | null {
  const span = pMax - pMin;
  if (!(span > 0)) return null;
  const ROWS = 60;
  const vol = new Float64Array(ROWS);
  let total = 0;
  for (let i = start; i < candles.length; i++) {
    const k = candles[i];
    const v = Math.max(0, k.v);
    if (v <= 0) continue;
    // distribuir el volumen de la vela en las filas que atraviesa
    const rLo = Math.max(0, Math.floor(((k.l - pMin) / span) * ROWS));
    const rHi = Math.min(ROWS - 1, Math.floor(((k.h - pMin) / span) * ROWS));
    const rows = Math.max(1, rHi - rLo + 1);
    const per = v / rows;
    for (let r = rLo; r <= rHi; r++) { vol[r] += per; total += per; }
  }
  if (total <= 0) return null;
  const rowH = span / ROWS;
  // POC: fila con más volumen
  let pocRow = 0;
  for (let r = 1; r < ROWS; r++) if (vol[r] > vol[pocRow]) pocRow = r;
  const poc = pMin + (pocRow + 0.5) * rowH;
  // Área de Valor: expandir desde el POC hasta cubrir el 70% del volumen
  let acc = vol[pocRow];
  const target = total * 0.7;
  let lo = pocRow, hi = pocRow;
  while (acc < target && (lo > 0 || hi < ROWS - 1)) {
    const downV = lo > 0 ? vol[lo - 1] : -1;
    const upV = hi < ROWS - 1 ? vol[hi + 1] : -1;
    if (downV >= upV) { lo--; acc += vol[lo]; }
    else { hi++; acc += vol[hi]; }
  }
  const val = pMin + lo * rowH;
  const vah = pMin + (hi + 1) * rowH;
  return { poc, vah, val, total, rows: vol, rowH };
}

// ---------- Régimen de liquidez (funding + variación de OI) ----------
// Cruza el coste de financiación con el flujo de OI para leer la fragilidad
// del mercado (la señal que usan los proveedores de mapas de liquidación):
//   funding alto + OI subiendo  → largos aglomerados, subida frágil (riesgo long-squeeze)
//   funding bajo + OI subiendo  → cortos aglomerados, bajada frágil (riesgo short-squeeze)
//   OI cayendo con fuerza       → despalancamiento / liquidaciones en curso
export interface LiqRegime { label: string; tone: "long" | "short" | "warn" | "flat"; note: string; }

export function computeLiqRegime(fundingPct: number, oiDeltaPct: number): LiqRegime {
  const f = Number.isFinite(fundingPct) ? fundingPct : 0;
  const d = Number.isFinite(oiDeltaPct) ? oiDeltaPct : 0;
  if (d < -1.2) {
    return { label: "Despalancamiento", tone: "warn", note: "OI cayendo: liquidaciones en curso, el movimiento pierde combustible" };
  }
  if (f > 0.03 && d > 0.4) {
    return { label: "Longs aglomerados", tone: "short", note: "Funding caro + OI subiendo: subida frágil, riesgo de long-squeeze" };
  }
  if (f < -0.03 && d > 0.4) {
    return { label: "Shorts aglomerados", tone: "long", note: "Funding negativo + OI subiendo: bajada frágil, riesgo de short-squeeze" };
  }
  if (f > 0.03) {
    return { label: "Sesgo largo caro", tone: "short", note: "Funding elevado: los largos pagan prima, el lado largo está saturado" };
  }
  if (f < -0.03) {
    return { label: "Sesgo corto caro", tone: "long", note: "Funding negativo: los cortos pagan prima, el lado corto está saturado" };
  }
  if (d > 0.8) {
    return { label: "Apalancamiento en expansión", tone: "flat", note: "OI subiendo con funding neutro: entra dinero nuevo, el movimiento gana combustible" };
  }
  return { label: "Equilibrado", tone: "flat", note: "Sin aglomeración clara: funding neutro y OI estable" };
}
