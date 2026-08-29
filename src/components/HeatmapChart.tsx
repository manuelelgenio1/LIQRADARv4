import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MarketState } from "../lib/market";
import { CANDLE_COUNT, HEAT_BINS } from "../lib/market";
import {
  computeIndicators,
  getIndicatorCfg,
  sliceIndicators,
  mtfAdjust,
  adxThrOf,
  type TrendDir,
} from "../lib/indicators";
import { fmtAxisTime, fmtCompact, fmtHM, fmtPct, fmtPrice, fmtUsd } from "../lib/format";

type Osc = "cvd" | "macd" | "rsi" | "adx" | "vol";

interface Props {
  state: MarketState;
  tfKey: string;
  setTfKey: (k: string) => void;
  timeframes: { key: string; minutes: number }[];
  realCvd?: boolean;
  calibration?: { stAdj: number; adxThr: number };
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
}

const H = 540;
const SCALE_W = 86;
const SUB_H = 96;
const TIME_H = 22;
const PAD_T = 16;
const MIN_VIS = 24;
const ZOOM_KEY = "liqradar:zoom:v1";
const LEV_KEY = "liqradar:lev:v1";

// Escalera de apalancamiento: distancia de liquidación ≈ 1/apalancamiento
const LEVS = [5, 10, 20, 50, 100];
const LEV_ALPHA: Record<number, number> = { 5: 0.4, 10: 0.48, 20: 0.58, 50: 0.72, 100: 0.9 };

function loadLevOn(): Record<number, boolean> {
  const def: Record<number, boolean> = { 5: true, 10: true, 20: true, 50: true, 100: true };
  try {
    const raw = localStorage.getItem(LEV_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, boolean>;
      for (const k of Object.keys(def)) {
        if (typeof p[k] === "boolean") def[Number(k)] = p[k];
      }
    }
  } catch {
    /* sin almacenamiento */
  }
  return def;
}

function loadZoom(tf: string): number {
  try {
    const m = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "{}") as Record<string, number>;
    const v = m[tf];
    if (Number.isFinite(v)) return Math.max(MIN_VIS, Math.min(CANDLE_COUNT, Math.round(v)));
  } catch {
    /* sin almacenamiento */
  }
  return CANDLE_COUNT;
}

// ---------- sistema de capas (overlays conmutables) ----------
type LayerId = "clusters" | "lev" | "sessions" | "ema" | "st" | "cvdOv" | "voids" | "vwap" | "vp";
type Layers = Record<LayerId, boolean>;
const LAYER_KEY = "liqradar:layers:v1";
const DEFAULT_LAYERS: Layers = {
  clusters: true, lev: true, sessions: true, ema: true, st: true, cvdOv: false, voids: true, vwap: true, vp: true,
};
const LAYER_META: { id: LayerId; label: string; on: string; tip: string }[] = [
  { id: "clusters", label: "Clúster", on: "text-short-300", tip: "Líneas de los clústeres de liquidación detectados" },
  { id: "lev", label: "Lev", on: "text-flare-300", tip: "Escalera de apalancamiento (x5–x100)" },
  { id: "sessions", label: "PDH/PDL", on: "text-long-300", tip: "Alto/Bajo/Apertura del día anterior + sesión actual" },
  { id: "ema", label: "EMA", on: "text-long-300", tip: "Medias móviles exponenciales" },
  { id: "st", label: "ST", on: "text-long-300", tip: "Supertrend (línea ATR)" },
  { id: "cvdOv", label: "CVD↑", on: "text-flare-300", tip: "CVD superpuesto al precio (divergencias)" },
  { id: "voids", label: "Huecos", on: "text-flare-300", tip: "Huecos de liquidez (bandas frías)" },
  { id: "vwap", label: "VWAP", on: "text-mist-200", tip: "Precio medio ponderado por volumen (referencia institucional)" },
  { id: "vp", label: "V. Profile", on: "text-mist-300", tip: "Perfil de volumen: POC + Área de Valor (VAH/VAL)" },
];
function loadLayers(): Layers {
  const out = { ...DEFAULT_LAYERS };
  try {
    const raw = localStorage.getItem(LAYER_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Layers>;
      for (const k of Object.keys(out) as LayerId[]) {
        if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
      }
    }
  } catch {
    /* valores por defecto */
  }
  return out;
}

// ---------- líneas de sesión: PDH/PDL/PDO + sesión actual (días UTC) ----------
export interface Sessions {
  pdh: number; pdl: number; pdo: number;      // día anterior
  sdh: number; sdl: number; sdo: number;      // sesión (día) actual
}
const DAY_MS = 86_400_000;
export function computeSessions(candles: { t: number; o: number; h: number; l: number }[], tfMin: number): Sessions {
  const last = candles[candles.length - 1];
  const lastDay = Math.floor(last.t / DAY_MS);
  if (tfMin >= 1440) {
    // velas diarias/semanales: la vela previa es "ayer"
    const prev = candles.length > 1 ? candles[candles.length - 2] : last;
    return { pdh: prev.h, pdl: prev.l, pdo: prev.o, sdh: last.h, sdl: last.l, sdo: last.o };
  }
  let pdh = -Infinity, pdl = Infinity, pdo = NaN;
  let sdh = -Infinity, sdl = Infinity, sdo = NaN;
  for (const c of candles) {
    const d = Math.floor(c.t / DAY_MS);
    if (d === lastDay - 1) {
      pdh = Math.max(pdh, c.h);
      pdl = Math.min(pdl, c.l);
      if (Number.isNaN(pdo)) pdo = c.o;
    } else if (d === lastDay) {
      sdh = Math.max(sdh, c.h);
      sdl = Math.min(sdl, c.l);
      if (Number.isNaN(sdo)) sdo = c.o;
    }
  }
  if (!Number.isFinite(pdh)) { pdh = last.h; pdl = last.l; pdo = last.o; }
  if (!Number.isFinite(sdh)) { sdh = last.h; sdl = last.l; sdo = last.o; }
  return { pdh, pdl, pdo, sdh, sdl, sdo };
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
export interface VolProfile { poc: number; vah: number; val: number; total: number; }
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
  return { poc, vah, val, total };
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
  return { label: "Equilibrado", tone: "flat", note: "Funding neutro y OI estable: sin aglomeración clara de liquidez" };
}

const TREND_META: Record<TrendDir, { label: string; c: string; bar: string }> = {
  alcista: { label: "Alcista", c: "border-long-500/50 bg-long-900/40 text-long-300", bar: "#2de0c0" },
  bajista: { label: "Bajista", c: "border-short-500/50 bg-short-900/50 text-short-300", bar: "#ff5d7e" },
  lateral: { label: "Lateral", c: "border-flare-400/40 bg-flare-400/10 text-flare-300", bar: "#ffb224" },
};

function TrendIcon({ dir }: { dir: TrendDir }) {
  if (dir === "alcista")
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M4 17 L10 11 L14 15 L20 7 M20 7 H15 M20 7 V12" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (dir === "bajista")
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M4 7 L10 13 L14 9 L20 17 M20 17 H15 M20 17 V12" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
      <path d="M4 12 H20 M16 8 L20 12 L16 16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- rampa térmica de alta calidad (estilo mapa de liquidaciones profesional) ----
type Stop = [number, number, number, number, number]; // pos, r, g, b, a
const LONG_STOPS: Stop[] = [
  [0.0, 6, 14, 30, 0],
  [0.16, 10, 44, 60, 55],
  [0.38, 13, 104, 110, 118],
  [0.6, 24, 172, 158, 172],
  [0.8, 84, 226, 206, 220],
  [1.0, 214, 255, 245, 250],
];
const SHORT_STOPS: Stop[] = [
  [0.0, 30, 8, 18, 0],
  [0.16, 62, 16, 34, 55],
  [0.38, 124, 26, 56, 118],
  [0.6, 202, 48, 90, 172],
  [0.8, 250, 102, 136, 220],
  [1.0, 255, 218, 227, 250],
];
function sampleRamp(t: number, stops: Stop[]): [number, number, number, number] {
  if (t <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3], 0];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, r0, g0, b0, a0] = stops[i - 1];
      const [p1, r1, g1, b1, a1] = stops[i];
      const k = (t - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k, a0 + (a1 - a0) * k];
    }
  }
  const L = stops[stops.length - 1];
  return [L[1], L[2], L[3], L[4]];
}
const HEAT_ROWS = 160; // resolución vertical del render térmico (suavizado por interpolación)

// Safari < 17 no soporta ctx.filter: se detecta una sola vez y se usa un
// glow aproximado (doble pasada ampliada) cuando no está disponible.
const CAN_FILTER = (() => {
  try {
    const c = document.createElement("canvas").getContext("2d");
    if (!c) return false;
    c.filter = "blur(2px)";
    return c.filter === "blur(2px)";
  } catch {
    return false;
  }
})();

// grupo de controles con etiqueta (barra de herramientas del heatmap)
function ToolGroup({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex shrink-0 flex-col gap-1" title={title}>
      <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.18em] text-mist-600">
        {label}
      </span>
      <div className="flex items-stretch border border-ink-700 bg-ink-850/80">{children}</div>
    </div>
  );
}

function ToolDivider() {
  return <span className="h-8 w-px shrink-0 self-center bg-ink-700/60" />;
}

// colores de punto para cada capa (en el menú desplegable)
const LAYER_DOT: Record<LayerId, string> = {
  clusters: "bg-short-400",
  lev: "bg-flare-400",
  sessions: "bg-long-400",
  ema: "bg-long-300",
  st: "bg-long-400",
  cvdOv: "bg-flare-300",
  voids: "bg-flare-300",
  vwap: "bg-mist-200",
  vp: "bg-mist-400",
};

// menú desplegable de capas: agrupa los 7 overlays en un solo control compacto
function LayersMenu({
  layers,
  onToggle,
  open,
  setOpen,
}: {
  layers: Layers;
  onToggle: (id: LayerId) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, setOpen]);

  const ids = Object.keys(layers) as LayerId[];
  const activeCount = ids.filter((k) => layers[k]).length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest transition-all ${
          open
            ? "border-long-500/50 bg-long-900/40 text-long-300"
            : "border-ink-700 bg-ink-850/80 text-mist-400 hover:border-ink-600 hover:text-mist-200"
        }`}
        title="Mostrar u ocultar las capas del gráfico"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Capas
        <span className={`tick-num ${activeCount === ids.length ? "text-long-300" : "text-flare-300"}`}>
          {activeCount}/{ids.length}
        </span>
        <svg
          width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="anim-feed-in absolute right-0 top-full z-40 mt-2 w-56 border border-ink-600 bg-ink-900/98 py-1 shadow-2xl backdrop-blur-md">
          <div className="px-3 py-1.5 font-mono text-[8px] font-bold uppercase tracking-[0.2em] text-mist-600">
            Capas del gráfico
          </div>
          {LAYER_META.map((l) => (
            <button
              key={l.id}
              onClick={() => onToggle(l.id)}
              className="group flex w-full items-center gap-2.5 px-3 py-[7px] text-left transition-colors hover:bg-ink-750/70"
              title={l.tip}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full transition-all ${
                  layers[l.id] ? LAYER_DOT[l.id] : "bg-ink-600"
                }`}
              />
              <span
                className={`flex-1 font-mono text-[10.5px] font-medium transition-colors ${
                  layers[l.id] ? "text-mist-200" : "text-mist-600"
                }`}
              >
                {l.label}
              </span>
              <span
                className={`relative h-[14px] w-[26px] rounded-full transition-colors ${
                  layers[l.id] ? "bg-long-500/60" : "bg-ink-700"
                }`}
              >
                <span
                  className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-mist-100 transition-all ${
                    layers[l.id] ? "left-[14px]" : "left-[2px]"
                  }`}
                />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Hover { x: number; y: number; idx: number; price: number; heat: number; }

export default function HeatmapChart({ state, tfKey, setTfKey, timeframes, realCvd, calibration, confluence }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<Hover | null>(null);
  const [osc, setOsc] = useState<Osc>("cvd");
  const [visibleCount, setVisibleCount] = useState(() => loadZoom(tfKey));
  const [levOn, setLevOn] = useState<Record<number, boolean>>(loadLevOn);
  const [fullscreen, setFullscreen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [chartH, setChartH] = useState(H);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const [logScale, setLogScale] = useState<boolean>(() => {
    try {
      return localStorage.getItem("liqradar:logscale:v1") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("liqradar:logscale:v1", logScale ? "1" : "0");
    } catch {
      /* sin almacenamiento */
    }
  }, [logScale]);

  // preferencia de escalera de apalancamiento persistida
  useEffect(() => {
    try {
      localStorage.setItem(LEV_KEY, JSON.stringify(levOn));
    } catch {
      /* sin almacenamiento */
    }
  }, [levOn]);

  const [layers, setLayers] = useState<Layers>(loadLayers);
  useEffect(() => {
    try {
      localStorage.setItem(LAYER_KEY, JSON.stringify(layers));
    } catch {
      /* sin almacenamiento */
    }
  }, [layers]);

  const tfMin = timeframes.find((t) => t.key === tfKey)?.minutes ?? 5;
  // configuración efectiva con la calibración del usuario aplicada
  const cfg = useMemo(() => {
    const base = getIndicatorCfg(tfKey);
    const stAdj = calibration?.stAdj ?? 0;
    return {
      ...base,
      stMult: +(base.stMult * (1 + stAdj)).toFixed(2),
      adxThr: calibration?.adxThr ?? adxThrOf(base),
    };
  }, [tfKey, calibration]);

  // semilla extendida: indicadores sobre la serie warm (hasta 500 velas reales)
  // y recorte a las últimas CANDLE_COUNT para alinear con el gráfico.
  const ind = useMemo(() => {
    const src = state.warm && state.warm.length >= CANDLE_COUNT ? state.warm : state.candles;
    const full = computeIndicators(src, cfg, tfMin);
    return src.length > CANDLE_COUNT ? sliceIndicators(full, CANDLE_COUNT) : full;
  }, [state.warm, state.candles, cfg, tfMin]);

  // líneas de sesión (PDH/PDL/PDO + sesión actual)
  const sessions = useMemo(() => computeSessions(state.candles, tfMin), [state.candles, tfMin]);

  // zoom por timeframe, persistido
  useEffect(() => {
    setVisibleCount(loadZoom(tfKey));
  }, [tfKey]);
  useEffect(() => {
    try {
      const m = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "{}") as Record<string, number>;
      m[tfKey] = visibleCount;
      localStorage.setItem(ZOOM_KEY, JSON.stringify(m));
    } catch {
      /* sin almacenamiento */
    }
  }, [tfKey, visibleCount]);

  // rueda del ratón = zoom (listener no pasivo para poder prevenir el scroll)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dirn = e.deltaY > 0 ? 1 : -1; // +1 alejar, −1 acercar
      setVisibleCount((v) => {
        const step = Math.max(1, Math.round(v * 0.12));
        return Math.max(MIN_VIS, Math.min(CANDLE_COUNT, v + dirn * step));
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (dirn: 1 | -1) =>
    setVisibleCount((v) => {
      const step = Math.max(2, Math.round(v * 0.18));
      return Math.max(MIN_VIS, Math.min(CANDLE_COUNT, v + dirn * step));
    });

  // ventana visible + rango de precios auto-ajustado a las velas visibles
  const view = useMemo(() => {
    const start = CANDLE_COUNT - visibleCount;
    let vLo = Infinity;
    let vHi = -Infinity;
    for (let i = start; i < CANDLE_COUNT; i++) {
      vLo = Math.min(vLo, state.candles[i].l);
      vHi = Math.max(vHi, state.candles[i].h);
    }
    const pad = (vHi - vLo) * 0.05 || Math.abs(vHi) * 0.001 || 1;
    return { start, yMin: vLo - pad, yMax: vHi + pad };
  }, [state.candles, visibleCount]);

  // huecos de liquidez sobre la ventana visible
  const liqVoids = useMemo(
    () => computeVoids(state.candles, state.heat, state.pMin, state.pMax, view.start),
    [state.candles, state.heat, state.pMin, state.pMax, view.start]
  );

  // VWAP (reiniciado por sesión UTC) y Perfil de Volumen (POC + Área de Valor)
  const vwap = useMemo(() => computeVwap(state.candles), [state.candles]);
  const volProfile = useMemo(
    () => computeVolProfile(state.candles, state.pMin, state.pMax, view.start),
    [state.candles, state.pMin, state.pMax, view.start]
  );

  // exportar el gráfico como PNG
  const exportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const a = document.createElement("a");
      a.download = `liqradar_${state.meta.symbol}_${tfKey}_${Date.now()}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    } catch {
      /* sin exportación */
    }
  };

  // ---- mapeo precio↔píxel (lineal o logarítmico) compartido por canvas y tooltip ----
  const scaleY = (p: number, plotTop: number, plotH: number) => {
    if (logScale && view.yMin > 0 && p > 0) {
      const lmin = Math.log(view.yMin), lmax = Math.log(view.yMax);
      return plotTop + ((lmax - Math.log(p)) / (lmax - lmin)) * plotH;
    }
    return plotTop + ((view.yMax - p) / (view.yMax - view.yMin)) * plotH;
  };
  const scalePrice = (py: number, plotTop: number, plotH: number) => {
    if (logScale && view.yMin > 0) {
      const lmin = Math.log(view.yMin), lmax = Math.log(view.yMax);
      return Math.exp(lmax - ((py - plotTop) / plotH) * (lmax - lmin));
    }
    return view.yMax - ((py - plotTop) / plotH) * (view.yMax - view.yMin);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setChartH(el.clientHeight);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setChartH(el.clientHeight || H);
    return () => ro.disconnect();
  }, [fullscreen]);

  // Atajos en pantalla completa: ESC sale · +/− zoom · ←/→ timeframe · L escala log
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
      else if (e.key === "+" || e.key === "=")
        setVisibleCount((v) => Math.max(MIN_VIS, v - Math.max(1, Math.round(v * 0.15))));
      else if (e.key === "-" || e.key === "_")
        setVisibleCount((v) => Math.min(CANDLE_COUNT, v + Math.max(1, Math.round(v * 0.15))));
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = timeframes.findIndex((t) => t.key === tfKey);
        const n = timeframes[(i + (e.key === "ArrowRight" ? 1 : -1) + timeframes.length) % timeframes.length];
        if (n) setTfKey(n.key);
      } else if (e.key === "l" || e.key === "L") setLogScale((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [fullscreen, timeframes, tfKey, setTfKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = chartH * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, chartH);

    const { candles, heat, pMin, pMax, meta, cvd, clusters } = state;
    const plotW = width - SCALE_W;
    const plotTop = PAD_T;
    const plotBottom = chartH - TIME_H - SUB_H - 12;
    const plotH = plotBottom - plotTop;
    const lastC = candles[CANDLE_COUNT - 1].c;
    const y = (p: number) => scaleY(p, plotTop, plotH);
    const priceAt = (py: number) => scalePrice(py, plotTop, plotH);
    const cellW = plotW / visibleCount;

    // tinte de fondo según el consenso de tendencia
    const tint = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    if (ind.consensus.dir === "alcista") {
      tint.addColorStop(0, "rgba(45,224,192,0)");
      tint.addColorStop(1, `rgba(45,224,192,${0.028 + ind.consensus.strength * 0.03})`);
    } else if (ind.consensus.dir === "bajista") {
      tint.addColorStop(0, `rgba(255,93,126,${0.028 + ind.consensus.strength * 0.03})`);
      tint.addColorStop(1, "rgba(255,93,126,0)");
    }
    ctx.fillStyle = tint;
    ctx.fillRect(0, plotTop, plotW, plotH);

    // rejilla horizontal + escala de precios (espaciado uniforme en pantalla;
    // en escala log los precios resultan logarítmicos)
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    for (let g = 0; g <= 6; g++) {
      const gy = plotTop + (plotH * g) / 6;
      const p = priceAt(gy);
      ctx.strokeStyle = "rgba(37,54,80,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(plotW, gy);
      ctx.stroke();
      ctx.fillStyle = "#5f7396";
      ctx.textAlign = "left";
      ctx.fillText(fmtPrice(p, meta.decimals), plotW + 8, gy);
    }

    // ---- render térmico suavizado (offscreen + interpolación bilineal + bloom) ----
    let heatVisMax = 0;
    for (let i = view.start; i < CANDLE_COUNT; i++)
      for (let b = 0; b < HEAT_BINS; b++) heatVisMax = Math.max(heatVisMax, heat[i * HEAT_BINS + b]);
    if (heatVisMax <= 0) heatVisMax = state.heatMax || 1;

    if (!offRef.current) {
      offRef.current = document.createElement("canvas");
    }
    const off = offRef.current;
    off.width = visibleCount;
    off.height = HEAT_ROWS;
    const octx = off.getContext("2d")!;
    const img = octx.createImageData(visibleCount, HEAT_ROWS);
    const px = img.data;
    const spanFull = pMax - pMin || 1;
    for (let r = 0; r < HEAT_ROWS; r++) {
      // cada fila de píxeles se mapea a su precio (respeta la escala log)
      const price = priceAt(plotTop + ((r + 0.5) / HEAT_ROWS) * plotH);
      const fb = ((price - pMin) / spanFull) * (HEAT_BINS - 1);
      const b0 = Math.max(0, Math.min(HEAT_BINS - 1, Math.floor(fb)));
      const b1 = Math.max(0, Math.min(HEAT_BINS - 1, Math.ceil(fb)));
      const frac = Math.max(0, Math.min(1, fb - b0));
      const isLongSide = price < lastC;
      const stops = isLongSide ? LONG_STOPS : SHORT_STOPS;
      for (let c = 0; c < visibleCount; c++) {
        const i = view.start + c;
        const idx4 = (r * visibleCount + c) * 4;
        const v = heat[i * HEAT_BINS + b0] * (1 - frac) + heat[i * HEAT_BINS + b1] * frac;
        const t = Math.min(1, Math.pow(v / heatVisMax, 1.25));
        if (t < 0.045) {
          px[idx4 + 3] = 0;
          continue;
        }
        const [cr, cg, cb, ca] = sampleRamp(t, stops);
        px[idx4] = cr;
        px[idx4 + 1] = cg;
        px[idx4 + 2] = cb;
        px[idx4 + 3] = ca;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 0, plotTop, plotW, plotH);
    // bloom: segunda pasada desenfocada aditiva para resaltar las zonas calientes
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.3;
    if (CAN_FILTER) {
      ctx.filter = "blur(5px)";
      ctx.drawImage(off, 0, plotTop, plotW, plotH);
      ctx.filter = "none";
    } else {
      // fallback sin ctx.filter: doble pasada ligeramente ampliada
      ctx.drawImage(off, -plotW * 0.004, plotTop - plotH * 0.01, plotW * 1.008, plotH * 1.02);
      ctx.globalAlpha = 0.16;
      ctx.drawImage(off, -plotW * 0.012, plotTop - plotH * 0.028, plotW * 1.024, plotH * 1.056);
    }
    ctx.restore();

    // ---- huecos de liquidez (bandas frías donde el precio acelera) ----
    if (layers.voids) {
      for (const vd of liqVoids) {
        const vy0 = y(vd.yMax);
        const vy1 = y(vd.yMin);
        if (vy1 < plotTop || vy0 > plotBottom) continue;
        const top = Math.max(plotTop, vy0);
        const bot = Math.min(plotBottom, vy1);
        if (bot - top < 4) continue;
        // banda sombreada
        ctx.fillStyle = "rgba(255,178,36,0.05)";
        ctx.fillRect(0, top, plotW, bot - top);
        // bordes punteados
        ctx.strokeStyle = "rgba(255,178,36,0.4)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(0, top); ctx.lineTo(plotW, top);
        ctx.moveTo(0, bot); ctx.lineTo(plotW, bot);
        ctx.stroke();
        ctx.setLineDash([]);
        // etiqueta (ancho del hueco como % del precio, sin signo)
        const tag = `HUECO ${((vd.width / lastC) * 100).toFixed(2)}%`;
        ctx.font = "600 8.5px 'IBM Plex Mono', monospace";
        const tw = ctx.measureText(tag).width;
        ctx.fillStyle = "rgba(7,12,22,0.9)";
        ctx.fillRect(6, top + 2, tw + 12, 13);
        ctx.strokeStyle = "rgba(255,178,36,0.55)";
        ctx.strokeRect(6.5, top + 2.5, tw + 11, 12);
        ctx.fillStyle = "rgba(255,211,122,0.9)";
        ctx.textAlign = "left";
        ctx.fillText(tag, 12, top + 8.5);
        ctx.font = "10px 'IBM Plex Mono', monospace";
      }
    }

    // ---- Volume Profile: histograma lateral + POC + Área de Valor (VAH/VAL) ----
    if (layers.vp && volProfile) {
      const span = state.pMax - state.pMin;
      if (span > 0) {
        const ROWS = 60;
        const rowH = span / ROWS;
        const vol = new Float64Array(ROWS);
        let maxV = 0;
        for (let i = view.start; i < CANDLE_COUNT; i++) {
          const k = candles[i];
          const v = Math.max(0, k.v);
          if (v <= 0) continue;
          const rLo = Math.max(0, Math.floor(((k.l - state.pMin) / span) * ROWS));
          const rHi = Math.min(ROWS - 1, Math.floor(((k.h - state.pMin) / span) * ROWS));
          const rows = Math.max(1, rHi - rLo + 1);
          for (let r = rLo; r <= rHi; r++) vol[r] += v / rows;
        }
        for (let r = 0; r < ROWS; r++) maxV = Math.max(maxV, vol[r]);
        const maxBarW = plotW * 0.16;
        // barras del histograma (desde la izquierda)
        for (let r = 0; r < ROWS; r++) {
          if (vol[r] <= 0) continue;
          const pTop = state.pMin + (r + 1) * rowH;
          const pBot = state.pMin + r * rowH;
          const by0 = y(pTop), by1 = y(pBot);
          if (by1 < plotTop || by0 > plotBottom) continue;
          const inVA = pBot >= volProfile.val && pTop <= volProfile.vah;
          const w = (vol[r] / maxV) * maxBarW;
          ctx.fillStyle = inVA ? "rgba(143,163,196,0.20)" : "rgba(143,163,196,0.10)";
          ctx.fillRect(0, Math.max(plotTop, by0), w, Math.max(1, Math.min(plotBottom, by1) - Math.max(plotTop, by0)));
        }
        // línea POC (punto de control, el nivel con más volumen)
        const drawVpLine = (price: number, col: string, label: string, dash?: number[]) => {
          const ly = y(price);
          if (ly < plotTop + 4 || ly > plotBottom - 4) return;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.setLineDash(dash ?? []);
          ctx.beginPath();
          ctx.moveTo(0, ly); ctx.lineTo(plotW, ly);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "600 8.5px 'IBM Plex Mono', monospace";
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(7,12,22,0.9)";
          ctx.fillRect(6, ly - 7, tw + 10, 13);
          ctx.strokeStyle = col;
          ctx.strokeRect(6.5, ly - 6.5, tw + 9, 12);
          ctx.fillStyle = col;
          ctx.textAlign = "left";
          ctx.fillText(label, 11, ly + 0.5);
          ctx.font = "10px 'IBM Plex Mono', monospace";
        };
        drawVpLine(volProfile.poc, "rgba(219,230,247,0.85)", `POC ${fmtPrice(volProfile.poc, meta.decimals)}`);
        drawVpLine(volProfile.vah, "rgba(143,163,196,0.6)", "VAH", [4, 4]);
        drawVpLine(volProfile.val, "rgba(143,163,196,0.6)", "VAL", [4, 4]);
      }
    }

    // ---- VWAP (referencia institucional, reiniciado por sesión) ----
    if (layers.vwap) {
      ctx.beginPath();
      let started = false;
      for (let i = view.start; i < CANDLE_COUNT; i++) {
        const v = vwap[i];
        if (!Number.isFinite(v)) continue;
        const px = (i - view.start) * cellW + cellW / 2;
        const py = y(v);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = "rgba(219,230,247,0.55)";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // punto en el VWAP actual
      const lastV = vwap[CANDLE_COUNT - 1];
      if (Number.isFinite(lastV)) {
        const py = y(lastV);
        if (py > plotTop && py < plotBottom) {
          ctx.fillStyle = "#dbe6f7";
          ctx.beginPath();
          ctx.arc(plotW - 3, py, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // marcadores de clústeres (línea reforzada + halo para destacar sobre el calor)
    if (layers.clusters) for (const cl of clusters.slice(0, 6)) {
      const cy = y(cl.price);
      if (cy < plotTop || cy > plotBottom) continue;
      const col = cl.side === "long" ? "45,224,192" : "255,93,126";
      // halo
      ctx.strokeStyle = `rgba(${col},0.16)`;
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(plotW, cy);
      ctx.stroke();
      // línea principal
      ctx.strokeStyle = `rgba(${col},0.9)`;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(plotW, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      const label = `${fmtUsd(cl.sizeUsd)} ${cl.side === "long" ? "LONG" : "SHORT"}`;
      ctx.font = "600 10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "rgba(7,12,22,0.95)";
      ctx.fillRect(6, cy - 9, 104, 17);
      ctx.strokeStyle = `rgba(${col},0.85)`;
      ctx.strokeRect(6.5, cy - 8.5, 103, 16);
      ctx.fillStyle = `rgb(${col})`;
      ctx.textAlign = "left";
      ctx.fillText(label, 12, cy + 0.5);
      ctx.font = "10px 'IBM Plex Mono', monospace";
    }

    // ---- escalera de apalancamiento (liq. ≈ precio × (1 ± 1/lev)) ----
    // Cada lado dibuja su línea en el precio real y apila las etiquetas en una
    // columna alineada a la derecha, resolviendo solapes para que nunca se pisen.
    if (layers.lev) {
      const TAG_W = 84, TAG_H = 15, GAP = 2;
      const colX = plotW - TAG_W - 6;
      type LevTag = { lineY: number; tagY: number; col: string; tag: string; alpha: number };
      const buildSide = (sign: 1 | -1, col: string, suffix: string): LevTag[] => {
        const out: LevTag[] = [];
        for (const lev of LEVS) {
          if (!levOn[lev]) continue;
          const lineY = y(lastC * (1 + sign / lev));
          if (lineY < plotTop + 6 || lineY > plotBottom - 6) continue;
          const pd = 100 / lev;
          const pdStr = pd < 10 ? pd.toFixed(1) : pd.toFixed(0);
          out.push({ lineY, tagY: lineY, col, alpha: LEV_ALPHA[lev], tag: `x${lev} · ${pdStr}%${suffix}` });
        }
        out.sort((a, b) => a.lineY - b.lineY);
        for (let i = 1; i < out.length; i++) {
          if (out[i].tagY - out[i - 1].tagY < TAG_H + GAP) out[i].tagY = out[i - 1].tagY + TAG_H + GAP;
        }
        return out;
      };
      const drawSide = (tags: LevTag[]) => {
        for (const t of tags) {
          // línea de liquidación (posición real)
          ctx.strokeStyle = `rgba(${t.col},${t.alpha})`;
          ctx.lineWidth = 1.1;
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.moveTo(0, t.lineY);
          ctx.lineTo(plotW, t.lineY);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          // conector desde la línea hasta la etiqueta (si fue desplazada)
          ctx.strokeStyle = `rgba(${t.col},${t.alpha * 0.7})`;
          ctx.beginPath();
          ctx.moveTo(plotW - 2, t.lineY);
          ctx.lineTo(colX + TAG_W, t.tagY);
          ctx.stroke();
          // etiqueta en columna alineada
          ctx.fillStyle = "rgba(7,12,22,0.92)";
          ctx.fillRect(colX, t.tagY - TAG_H / 2, TAG_W, TAG_H);
          ctx.strokeStyle = `rgba(${t.col},${Math.min(1, t.alpha + 0.2)})`;
          ctx.strokeRect(colX + 0.5, t.tagY - TAG_H / 2 + 0.5, TAG_W - 1, TAG_H - 1);
          ctx.fillStyle = `rgba(${t.col},${Math.min(1, t.alpha + 0.3)})`;
          ctx.textAlign = "left";
          ctx.fillText(t.tag, colX + 7, t.tagY + 0.5);
        }
      };
      ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
      drawSide(buildSide(-1, "45,224,192", " L"));
      drawSide(buildSide(1, "255,93,126", " S"));
      ctx.font = "10px 'IBM Plex Mono', monospace";
    }

    // ---- líneas de sesión: PDH/PDL/PDO (día anterior) + sesión actual ----
    if (layers.sessions) {
      const drawLevel = (price: number, label: string, col: string, dash?: number[]) => {
        const ly = y(price);
        if (ly < plotTop + 4 || ly > plotBottom - 4) return;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.setLineDash(dash ?? []);
        ctx.beginPath();
        ctx.moveTo(0, ly);
        ctx.lineTo(plotW, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "600 8.5px 'IBM Plex Mono', monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(7,12,22,0.88)";
        ctx.fillRect(6, ly - 15, tw + 12, 12);
        ctx.fillStyle = col;
        ctx.textAlign = "left";
        ctx.fillText(label, 12, ly - 6.5);
        ctx.font = "10px 'IBM Plex Mono', monospace";
      };
      // día anterior (referencias clave)
      drawLevel(sessions.pdh, `PDH ${fmtPrice(sessions.pdh, meta.decimals)}`, "rgba(125,240,218,0.75)", [5, 4]);
      drawLevel(sessions.pdl, `PDL ${fmtPrice(sessions.pdl, meta.decimals)}`, "rgba(255,147,169,0.75)", [5, 4]);
      drawLevel(sessions.pdo, `PDO ${fmtPrice(sessions.pdo, meta.decimals)}`, "rgba(143,163,196,0.6)", [2, 4]);
      // sesión actual
      drawLevel(sessions.sdh, `SDH`, "rgba(45,224,192,0.45)", [2, 3]);
      drawLevel(sessions.sdl, `SDL`, "rgba(255,93,126,0.45)", [2, 3]);
    }

    // velas (solo visibles)
    for (let i = view.start; i < CANDLE_COUNT; i++) {
      const k = candles[i];
      const cx = (i - view.start) * cellW + cellW / 2;
      const up = k.c >= k.o;
      const col = up ? "#2de0c0" : "#ff5d7e";
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, y(k.h));
      ctx.lineTo(cx, y(k.l));
      ctx.stroke();
      const bw = Math.max(1.6, cellW * 0.52);
      const yo = y(k.o), yc = y(k.c);
      ctx.fillStyle = up ? "rgba(45,224,192,0.92)" : "rgba(255,93,126,0.92)";
      ctx.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1.2, Math.abs(yc - yo)));
    }

    // ---- Supertrend (línea ATR sobre el precio) ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, plotTop, plotW, plotH);
    ctx.clip();
    if (layers.st) for (let i = Math.max(1, view.start); i < CANDLE_COUNT; i++) {
      const x0 = (i - 1 - view.start) * cellW + cellW / 2;
      const x1 = (i - view.start) * cellW + cellW / 2;
      const col = ind.stUp[i] ? "#2de0c0" : "#ff5d7e";
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(x0, y(ind.st[i - 1]));
      ctx.lineTo(x1, y(ind.st[i]));
      ctx.stroke();
      // marcador solo en giros CONFIRMADOS (persisten ≥1 vela): menos ruido
      if (ind.stUpConf[i] !== ind.stUpConf[i - 1]) {
        ctx.beginPath();
        ctx.arc(x1, y(ind.st[i]), 3.2, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = "#070c16";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // ---- EMAs ----
    const drawEma = (arr: number[], color: string, w: number, dash?: number[]) => {
      ctx.beginPath();
      ctx.setLineDash(dash ?? []);
      for (let i = view.start; i < CANDLE_COUNT; i++) {
        const px = (i - view.start) * cellW + cellW / 2;
        const py = y(arr[i]);
        if (i === view.start) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (layers.ema) {
      drawEma(ind.emaTrend, "rgba(143,163,196,0.75)", 1.2, [4, 4]);
      drawEma(ind.emaSlow, "#ffb224", 1.5);
      drawEma(ind.emaFast, "#7df0da", 1.5);
    }

    // ---- CVD superpuesto al precio (para detectar divergencias) ----
    if (layers.cvdOv) {
      let cMin = Infinity, cMax = -Infinity;
      for (let i = view.start; i < CANDLE_COUNT; i++) {
        cMin = Math.min(cMin, cvd[i]);
        cMax = Math.max(cMax, cvd[i]);
      }
      const cSpan = cMax - cMin || 1;
      const cyv = (v: number) => plotTop + ((cMax - v) / cSpan) * plotH;
      ctx.beginPath();
      for (let i = view.start; i < CANDLE_COUNT; i++) {
        const px = (i - view.start) * cellW + cellW / 2;
        if (i === view.start) ctx.moveTo(px, cyv(cvd[i]));
        else ctx.lineTo(px, cyv(cvd[i]));
      }
      ctx.strokeStyle = "rgba(255,211,122,0.62)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([7, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // puntos de lectura en la última vela
    const dotAt = (v: number, color: string) => {
      const py = y(v);
      if (py < plotTop || py > plotBottom) return;
      ctx.beginPath();
      ctx.arc(plotW - cellW / 2, py, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#070c16";
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    dotAt(ind.emaFast[ind.emaFast.length - 1], "#7df0da");
    dotAt(ind.emaSlow[ind.emaSlow.length - 1], "#ffb224");

    // línea de precio actual
    const ly = y(lastC);
    ctx.strokeStyle = "rgba(219,230,247,0.75)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(plotW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#dbe6f7";
    ctx.fillRect(plotW, ly - 9, SCALE_W, 18);
    ctx.fillStyle = "#070c16";
    ctx.font = "600 10px 'IBM Plex Mono', monospace";
    ctx.fillText(fmtPrice(lastC, meta.decimals), plotW + 8, ly + 0.5);
    ctx.font = "10px 'IBM Plex Mono', monospace";

    // eje de tiempo (formato según temporalidad)
    ctx.fillStyle = "#48597a";
    ctx.textAlign = "center";
    const step = Math.max(4, Math.round(visibleCount / 6));
    for (let i = view.start + Math.floor(step / 2); i < CANDLE_COUNT; i += step) {
      ctx.fillText(fmtAxisTime(candles[i].t, tfMin), (i - view.start) * cellW + cellW / 2, chartH - TIME_H / 2 - 4);
    }

    // --- sub-panel de oscilador (CVD / MACD / RSI / ADX) ---
    const subTop = plotBottom + 14;
    const subBottom = chartH - TIME_H - 4;
    ctx.strokeStyle = "rgba(37,54,80,0.55)";
    ctx.beginPath();
    ctx.moveTo(0, subTop - 7);
    ctx.lineTo(width, subTop - 7);
    ctx.stroke();

    const subMid = (subTop + subBottom) / 2;
    const subHalf = (subBottom - subTop) / 2 - 4;
    const slice = (a: number[]) => a.slice(view.start);

    if (osc === "cvd") {
      const cv = slice(cvd);
      let cMin = Infinity, cMax = -Infinity;
      for (const v of cv) { cMin = Math.min(cMin, v); cMax = Math.max(cMax, v); }
      const cSpan = Math.max(1e-9, cMax - cMin);
      const cy2 = (v: number) => subTop + ((cMax - v) / cSpan) * (subBottom - subTop);
      const zeroY = cy2(0);
      ctx.strokeStyle = "rgba(95,115,150,0.35)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(plotW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
      const cvdUp = cv[cv.length - 1] >= 0;
      const grad = ctx.createLinearGradient(0, subTop, 0, subBottom);
      if (cvdUp) {
        grad.addColorStop(0, "rgba(45,224,192,0.30)");
        grad.addColorStop(1, "rgba(45,224,192,0.02)");
      } else {
        grad.addColorStop(0, "rgba(255,93,126,0.30)");
        grad.addColorStop(1, "rgba(255,93,126,0.02)");
      }
      ctx.beginPath();
      ctx.moveTo(0, subBottom);
      for (let i = 0; i < cv.length; i++) ctx.lineTo(i * cellW + cellW / 2, cy2(cv[i]));
      ctx.lineTo(plotW, subBottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < cv.length; i++) {
        const px = i * cellW + cellW / 2;
        if (i === 0) ctx.moveTo(px, cy2(cv[i]));
        else ctx.lineTo(px, cy2(cv[i]));
      }
      ctx.strokeStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(realCvd ? "CVD · delta real (aggTrade)" : "CVD · delta acumulado", 8, subTop + 1);
      if (realCvd) {
        ctx.fillStyle = "#14c4a6";
        ctx.fillRect(8 + ctx.measureText("CVD · delta real (aggTrade)").width + 6, subTop - 6, 5, 5);
      }
      ctx.fillStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
      ctx.fillText(fmtCompact(cv[cv.length - 1]), realCvd ? 216 : 146, subTop + 1);
    } else if (osc === "macd") {
      const hs = slice(ind.hist), ms = slice(ind.macd), ss = slice(ind.signal);
      let mMax = 1e-9;
      for (let i = 0; i < hs.length; i++) {
        mMax = Math.max(mMax, Math.abs(hs[i]), Math.abs(ms[i]), Math.abs(ss[i]));
      }
      const my = (v: number) => subMid - (v / mMax) * subHalf;
      for (let i = 0; i < hs.length; i++) {
        const v = hs[i];
        const px = i * cellW + cellW / 2;
        ctx.fillStyle = v >= 0 ? "rgba(45,224,192,0.45)" : "rgba(255,93,126,0.45)";
        const y0 = my(0), y1 = my(v);
        ctx.fillRect(px - Math.max(1, cellW * 0.28), Math.min(y0, y1), Math.max(1.4, cellW * 0.56), Math.abs(y1 - y0) || 1);
      }
      const line = (arr: number[], color: string) => {
        ctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
          const px = i * cellW + cellW / 2;
          if (i === 0) ctx.moveTo(px, my(arr[i]));
          else ctx.lineTo(px, my(arr[i]));
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      };
      line(ms, "#2de0c0");
      line(ss, "#ffb224");
      ctx.strokeStyle = "rgba(95,115,150,0.35)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, subMid);
      ctx.lineTo(plotW, subMid);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(`MACD (${cfg.macd[0]},${cfg.macd[1]},${cfg.macd[2]})`, 8, subTop + 1);
      const hv = hs[hs.length - 1];
      ctx.fillStyle = hv >= 0 ? "#2de0c0" : "#ff5d7e";
      ctx.fillText(`hist ${fmtCompact(hv)}`, 138, subTop + 1);
    } else if (osc === "adx") {
      const aS = slice(ind.adx), pS = slice(ind.pdi), mS = slice(ind.mdi);
      const thr = adxThrOf(cfg);
      let mx = 40;
      for (let i = 0; i < aS.length; i++) mx = Math.max(mx, aS[i], pS[i], mS[i]);
      const ay = (v: number) => subTop + (1 - Math.min(1, v / mx)) * (subBottom - subTop);
      // zona de tendencia fuerte (≥ umbral calibrado)
      ctx.fillStyle = "rgba(255,178,36,0.06)";
      ctx.fillRect(0, ay(mx), plotW, ay(thr) - ay(mx));
      ctx.strokeStyle = "rgba(95,115,150,0.35)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, ay(thr));
      ctx.lineTo(plotW, ay(thr));
      ctx.stroke();
      ctx.setLineDash([]);
      const line = (arr: number[], color: string, w: number) => {
        ctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
          const px = i * cellW + cellW / 2;
          if (i === 0) ctx.moveTo(px, ay(arr[i]));
          else ctx.lineTo(px, ay(arr[i]));
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = w;
        ctx.stroke();
      };
      line(pS, "#2de0c0", 1.2);
      line(mS, "#ff5d7e", 1.2);
      line(aS, "#dbe6f7", 1.8);
      const av = aS[aS.length - 1];
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(`ADX ${cfg.adx} · fuerza de tendencia`, 8, subTop + 1);
      ctx.fillStyle = av >= thr ? "#ffb224" : "#8fa3c4";
      ctx.fillText(av.toFixed(1), 196, subTop + 1);
      ctx.fillStyle = "#48597a";
      ctx.fillText(`fuerte ≥ ${thr}`, 236, subTop + 1);
    } else if (osc === "vol") {
      // barras de volumen coloreadas por el signo del delta + línea de delta
      const vols = slice(candles.map((c) => c.v));
      const dlts = slice(candles.map((c) => c.delta));
      let vMax = 1e-9;
      for (const v of vols) vMax = Math.max(vMax, v);
      let dMax = 1e-9;
      for (const d of dlts) dMax = Math.max(dMax, Math.abs(d));
      const bw = Math.max(1.6, cellW * 0.6);
      const zeroY = subTop + (subBottom - subTop) * 0.62;
      // barras de volumen (desde la base)
      for (let i = 0; i < vols.length; i++) {
        const px = i * cellW + cellW / 2;
        const h = (vols[i] / vMax) * (subBottom - zeroY - 2);
        const buy = dlts[i] >= 0;
        ctx.fillStyle = buy ? "rgba(45,224,192,0.5)" : "rgba(255,93,126,0.5)";
        ctx.fillRect(px - bw / 2, subBottom - h, bw, h);
      }
      // línea de delta (reescaleada al tercio superior)
      const dy = (d: number) => subTop + 4 + ((dMax - d) / (2 * dMax)) * (zeroY - subTop - 8);
      ctx.strokeStyle = "rgba(95,115,150,0.5)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, dy(0));
      ctx.lineTo(plotW, dy(0));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i < dlts.length; i++) {
        const px = i * cellW + cellW / 2;
        if (i === 0) ctx.moveTo(px, dy(dlts[i]));
        else ctx.lineTo(px, dy(dlts[i]));
      }
      ctx.strokeStyle = "#ffd37a";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText("VOL · volumen + delta", 8, subTop + 1);
      const dv = dlts[dlts.length - 1];
      ctx.fillStyle = dv >= 0 ? "#2de0c0" : "#ff5d7e";
      ctx.fillText(`Δ ${fmtCompact(dv)}`, 150, subTop + 1);
    } else {
      const rs = slice(ind.rsi);
      const ry = (v: number) => subTop + ((100 - v) / 100) * (subBottom - subTop);
      ctx.fillStyle = "rgba(255,93,126,0.07)";
      ctx.fillRect(0, ry(100), plotW, ry(70) - ry(100));
      ctx.fillStyle = "rgba(45,224,192,0.07)";
      ctx.fillRect(0, ry(30), plotW, ry(0) - ry(30));
      ctx.strokeStyle = "rgba(95,115,150,0.35)";
      ctx.setLineDash([3, 4]);
      for (const g of [30, 50, 70]) {
        ctx.beginPath();
        ctx.moveTo(0, ry(g));
        ctx.lineTo(plotW, ry(g));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i < rs.length; i++) {
        const px = i * cellW + cellW / 2;
        if (i === 0) ctx.moveTo(px, ry(rs[i]));
        else ctx.lineTo(px, ry(rs[i]));
      }
      ctx.strokeStyle = "#b7c7e2";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const rv = rs[rs.length - 1];
      ctx.beginPath();
      ctx.arc(plotW - cellW / 2, ry(rv), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = rv > 70 ? "#ff5d7e" : rv < 30 ? "#2de0c0" : "#b7c7e2";
      ctx.fill();
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(`RSI ${cfg.rsi}`, 8, subTop + 1);
      ctx.fillStyle = rv > 70 ? "#ff5d7e" : rv < 30 ? "#2de0c0" : "#b7c7e2";
      ctx.fillText(rv.toFixed(1), 60, subTop + 1);
      ctx.fillStyle = "#48597a";
      ctx.fillText("sobrecompra >70 · sobreventa <30", 104, subTop + 1);
    }

    // crosshair
    if (hover && hover.x < plotW) {
      ctx.strokeStyle = "rgba(183,199,226,0.4)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, plotTop);
      ctx.lineTo(hover.x, subBottom);
      ctx.moveTo(0, hover.y);
      ctx.lineTo(plotW, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hover.y >= plotTop && hover.y <= plotBottom) {
        ctx.fillStyle = "#131e33";
        ctx.fillRect(plotW, hover.y - 9, SCALE_W, 18);
        ctx.strokeStyle = "rgba(143,163,196,0.6)";
        ctx.strokeRect(plotW + 0.5, hover.y - 8.5, SCALE_W - 1, 17);
        ctx.fillStyle = "#dbe6f7";
        ctx.fillText(fmtPrice(hover.price, meta.decimals), plotW + 8, hover.y + 0.5);
      }
    }
  }, [state, width, chartH, hover, ind, osc, tfMin, cfg, view, visibleCount, levOn, realCvd, logScale, layers, liqVoids, sessions, vwap, volProfile, scaleY, scalePrice]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yy = e.clientY - rect.top;
    const plotW = width - SCALE_W;
    const plotBottom = chartH - TIME_H - SUB_H - 12;
    const vIdx = Math.min(visibleCount - 1, Math.max(0, Math.floor((x / plotW) * visibleCount)));
    const idx = view.start + vIdx;
    const price = scalePrice(yy, PAD_T, plotBottom - PAD_T);
    const bin = Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((price - state.pMin) / (state.pMax - state.pMin)) * (HEAT_BINS - 1))));
    // mismo máximo de ventana que usa el canvas, para que el % del tooltip
    // coincida con la intensidad realmente dibujada al hacer zoom
    let heatVisMax = 0;
    for (let i = view.start; i < CANDLE_COUNT; i++)
      for (let b = 0; b < HEAT_BINS; b++) heatVisMax = Math.max(heatVisMax, state.heat[i * HEAT_BINS + b]);
    if (heatVisMax <= 0) heatVisMax = state.heatMax || 1;
    const heat = state.heat[idx * HEAT_BINS + bin] / heatVisMax;
    setHover({ x, y: yy, idx, price, heat });
  };

  const k = hover ? state.candles[hover.idx] : null;
  const cons = ind.consensus;
  const tm = TREND_META[cons.dir];
  // convicción ajustada por la confluencia multi-timeframe
  const mtf = mtfAdjust(cons, confluence);
  const regime = computeLiqRegime(state.funding, state.oiDelta1h);
  const lastStUp = ind.stUpConf[ind.stUpConf.length - 1];
  const zoomed = visibleCount < CANDLE_COUNT;

  const REGIME_TONE: Record<LiqRegime["tone"], string> = {
    long: "border-long-500/40 bg-long-900/40 text-long-300",
    short: "border-short-500/40 bg-short-900/40 text-short-300",
    warn: "border-flare-400/40 bg-flare-400/10 text-flare-300",
    flat: "border-ink-600 bg-ink-800/60 text-mist-400",
  };

  return (
    <section
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-ink-950"
          : "panel panel-corner anim-reveal"
      }
      style={fullscreen ? undefined : { animationDelay: "0.05s" }}
    >
      {/* cabecera: identidad + tendencia + acciones */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-ink-700/50 px-5 py-3.5">
        <div className="flex items-center gap-3 leading-none">
          <span className="flex h-9 w-9 items-center justify-center border border-long-500/30 bg-long-900/30">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="3" y="13" width="3.4" height="8" fill="#2de0c0" opacity="0.5" />
              <rect x="8.2" y="8" width="3.4" height="13" fill="#2de0c0" opacity="0.8" />
              <rect x="13.4" y="10" width="3.4" height="11" fill="#ff5d7e" opacity="0.7" />
              <rect x="18.6" y="4" width="3.4" height="17" fill="#ff5d7e" />
            </svg>
          </span>
          <div>
            <h2 className="font-display text-[15px] font-bold uppercase tracking-[0.14em] text-mist-100">
              Heatmap de liquidaciones
              {fullscreen && <span className="ml-2 text-[11px] font-semibold text-long-400">· pantalla completa</span>}
            </h2>
            <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-mist-500">
              <span className="text-mist-300">{state.meta.symbol}</span> · perp · energía de liquidación por nivel
            </p>
          </div>
        </div>

        {/* insignia de tendencia (consenso 5 ind. ajustado por confluencia MTF) */}
        <span
          className={`flex items-center gap-2 border px-2.5 py-1.5 ${tm.c}`}
          title={
            mtf.total != null
              ? `Consenso: cruce EMA + MACD + RSI + Supertrend + ADX · Confluencia MTF ${mtf.agree}/${mtf.total}`
              : "Consenso: cruce EMA + MACD + RSI + Supertrend + ADX"
          }
        >
          <TrendIcon dir={cons.dir} />
          <span className="font-mono text-[9.5px] font-bold uppercase tracking-widest">{tm.label}</span>
          <span className="h-1 w-12 overflow-hidden bg-ink-700/80">
            <span
              className="block h-full transition-all duration-700"
              style={{ width: `${Math.round(mtf.strength * 100)}%`, background: tm.bar }}
            />
          </span>
          <span className="tick-num font-mono text-[9.5px] font-bold">{Math.round(mtf.strength * 100)}%</span>
          {mtf.total != null && (
            <span className="border-l border-current/30 pl-2 font-mono text-[8.5px] font-semibold uppercase tracking-wider opacity-80">
              MTF {mtf.agree}/{mtf.total}
            </span>
          )}
        </span>

        {/* régimen de liquidez (funding + OI) */}
        <span
          className={`hidden items-center gap-1.5 border px-2.5 py-1.5 lg:flex ${REGIME_TONE[regime.tone]}`}
          title={`${regime.note} · Funding ${fmtPct(state.funding, 3)} · OI ${fmtPct(state.oiDelta1h, 2)} 1h`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 2v6M12 22v-6M4.9 4.9l4.2 4.2M19.1 19.1l-4.2-4.2M2 12h6M22 12h-6M4.9 19.1l4.2-4.2M19.1 4.9l-4.2 4.2" />
          </svg>
          <span className="font-mono text-[8.5px] font-bold uppercase tracking-widest">{regime.label}</span>
        </span>

        {/* acciones: capas (menú) · exportar PNG · pantalla completa */}
        <div className="ml-auto flex items-center gap-2">
          <LayersMenu layers={layers} onToggle={(id) => setLayers((p) => ({ ...p, [id]: !p[id] }))} open={layersOpen} setOpen={setLayersOpen} />

          <button
            onClick={exportPng}
            className="flex items-center gap-1.5 border border-ink-700 bg-ink-850/80 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-mist-400 transition-all hover:border-long-500/40 hover:text-long-300"
            title="Descargar el gráfico como imagen PNG"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            PNG
          </button>

          <button
            onClick={() => setFullscreen((f) => !f)}
            className={`flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest transition-all ${
              fullscreen
                ? "border-short-500/50 bg-short-900/50 text-short-300 hover:bg-short-900/80"
                : "border-long-500/40 bg-long-900/30 text-long-300 hover:bg-long-900/60"
            }`}
            title={fullscreen ? "Salir de pantalla completa (ESC)" : "Ver en pantalla completa"}
          >
            {fullscreen ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {fullscreen ? "Salir" : "Ampliar"}
          </button>
        </div>
      </header>

      {/* barra de herramientas: controles agrupados por función */}
      <div className="scroll-slim flex items-center gap-x-4 gap-y-2 overflow-x-auto border-b border-ink-700/50 bg-ink-900/60 px-5 py-2.5">
        <ToolGroup label="Temporalidad">
          {timeframes.map((t) => (
            <button
              key={t.key}
              onClick={() => setTfKey(t.key)}
              className={`px-2 py-1 font-mono text-[10px] font-semibold transition-colors ${
                t.key === tfKey
                  ? "bg-long-500/20 text-long-300"
                  : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"
              }`}
            >
              {t.key}
            </button>
          ))}
        </ToolGroup>

        <ToolDivider />

        <ToolGroup label="Zoom" title="Nivel de zoom sobre la ventana de velas (rueda del ratón)">
          <button
            onClick={() => zoomBy(1)}
            className="px-2 font-mono text-[12px] font-bold text-mist-400 transition-colors hover:bg-ink-750 hover:text-mist-100"
            title="Alejar (rueda hacia abajo)"
          >
            −
          </button>
          <button
            onClick={() => setVisibleCount(CANDLE_COUNT)}
            className={`tick-num border-x border-ink-700 px-2 py-1 font-mono text-[10px] font-semibold transition-colors hover:bg-ink-750 ${
              zoomed ? "text-flare-300" : "text-mist-400"
            }`}
            title="Restablecer zoom (doble clic en el gráfico)"
          >
            ×{(CANDLE_COUNT / visibleCount).toFixed(1)}
          </button>
          <button
            onClick={() => zoomBy(-1)}
            className="px-2 font-mono text-[12px] font-bold text-mist-400 transition-colors hover:bg-ink-750 hover:text-mist-100"
            title="Acercar (rueda hacia arriba)"
          >
            +
          </button>
        </ToolGroup>

        <ToolGroup label="Escala" title="Escala del eje de precios (log útil en 1D/1W)">
          {(["lin", "log"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setLogScale(s === "log")}
              className={`px-2 py-1 font-mono text-[10px] font-semibold uppercase transition-colors ${
                (s === "log") === logScale
                  ? "bg-mist-200/15 text-mist-100"
                  : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"
              }`}
            >
              {s}
            </button>
          ))}
        </ToolGroup>

        <ToolDivider />

        <ToolGroup label="Oscilador" title="Sub-panel inferior del gráfico">
          {(["cvd", "macd", "rsi", "adx", "vol"] as Osc[]).map((o) => (
            <button
              key={o}
              onClick={() => setOsc(o)}
              className={`px-2.5 py-1 font-mono text-[10px] font-semibold uppercase transition-colors ${
                osc === o ? "bg-flare-400/15 text-flare-300" : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"
              }`}
            >
              {o}
            </button>
          ))}
        </ToolGroup>

        <ToolDivider />

        <ToolGroup
          label="Apalancamiento"
          title="Líneas de liquidación: distancia ≈ 1/apalancamiento desde el precio actual (margen aislado)"
        >
          {LEVS.map((lv) => (
            <button
              key={lv}
              onClick={() => setLevOn((p) => ({ ...p, [lv]: !p[lv] }))}
              className={`px-2 py-1 font-mono text-[10px] font-semibold transition-all duration-150 ${
                levOn[lv]
                  ? "bg-flare-400/15 text-flare-300 shadow-[inset_0_-2px_0_rgba(255,178,36,0.55)]"
                  : "text-mist-600 hover:bg-ink-750 hover:text-mist-400"
              }`}
            >
              {lv}×
            </button>
          ))}
        </ToolGroup>
      </div>

      <div ref={wrapRef} className={fullscreen ? "relative min-h-0 flex-1" : "relative"}>
        {fullscreen && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 border border-ink-700 bg-ink-900/90 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-mist-500 backdrop-blur-sm">
            <span><b className="text-mist-300">rueda</b> zoom</span>
            <span className="text-ink-600">·</span>
            <span><b className="text-mist-300">← →</b> timeframe</span>
            <span className="text-ink-600">·</span>
            <span><b className="text-mist-300">L</b> escala log</span>
            <span className="text-ink-600">·</span>
            <span><b className="text-mist-300">ESC</b> salir</span>
          </div>
        )}

        {/* leyenda flotante: una sola lámina sutil con la clave de colores */}
        <div className="pointer-events-none absolute left-2.5 top-2.5 z-10">
          <div className="flex items-center gap-3 border border-ink-700/45 bg-ink-950/50 px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.14em] text-mist-500 backdrop-blur-[3px]">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-long-400" /> longs
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-short-400" /> shorts
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="h-[3px] w-7 rounded-full"
                style={{ background: "linear-gradient(90deg, rgba(45,224,192,0.15), #ffd37a, #fff)" }}
              />
              energía
            </span>
            {layers.st && (
              <span
                className={`flex items-center gap-1 border-l border-ink-700/60 pl-3 font-bold ${
                  lastStUp ? "text-long-300" : "text-short-300"
                }`}
              >
                ST {lastStUp ? "▲" : "▼"}
              </span>
            )}
          </div>
        </div>

        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: fullscreen ? "100%" : H, display: "block", cursor: "crosshair" }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onDoubleClick={() => setVisibleCount(CANDLE_COUNT)}
        />
        {hover && k && (
          <div
            className="pointer-events-none absolute z-20 border border-ink-600 bg-ink-900/95 px-3 py-2 font-mono text-[10px] shadow-xl"
            style={{
              left: Math.min(hover.x + 16, width - 220),
              top: Math.min(hover.y + 14, chartH - 170),
            }}
          >
            <div className="mb-1 text-[9px] uppercase tracking-widest text-mist-500">
              {tfMin >= 1440 ? new Date(k.t).toUTCString().slice(5, 16) : fmtHM(k.t)} UTC
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-mist-300">
              <span className="text-mist-600">O</span><span className="tick-num text-right">{fmtPrice(k.o, state.meta.decimals)}</span>
              <span className="text-mist-600">H</span><span className="tick-num text-right text-long-300">{fmtPrice(k.h, state.meta.decimals)}</span>
              <span className="text-mist-600">L</span><span className="tick-num text-right text-short-300">{fmtPrice(k.l, state.meta.decimals)}</span>
              <span className="text-mist-600">C</span><span className="tick-num text-right">{fmtPrice(k.c, state.meta.decimals)}</span>
              <span className="text-mist-600">Calor</span>
              <span className={`tick-num text-right ${hover.heat > 0.5 ? "text-flare-300" : "text-mist-400"}`}>
                {(hover.heat * 100).toFixed(0)}%
              </span>
              <span className="text-mist-600">EMA {cfg.fast}/{cfg.slow}</span>
              <span className="tick-num text-right">
                <span className="text-long-300">{fmtPrice(ind.emaFast[hover.idx], state.meta.decimals)}</span>
                {" / "}
                <span className="text-flare-400">{fmtPrice(ind.emaSlow[hover.idx], state.meta.decimals)}</span>
              </span>
              <span className="text-mist-600">Supertrend</span>
              <span className={`tick-num text-right ${ind.stUp[hover.idx] ? "text-long-300" : "text-short-300"}`}>
                {fmtPrice(ind.st[hover.idx], state.meta.decimals)} {ind.stUp[hover.idx] ? "▲" : "▼"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* barra de estado: métricas clave con jerarquía clara */}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-700/50 bg-ink-900/70 px-5 py-2.5 font-mono text-[9px] uppercase tracking-wider text-mist-600">
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-long-400" />
            Liq 24h L
          </span>
          <b className="tick-num text-[11px] font-bold tracking-normal text-long-300">{fmtUsd(state.totalLiq24hLong)}</b>
        </span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-short-400" />
            Liq 24h S
          </span>
          <b className="tick-num text-[11px] font-bold tracking-normal text-short-300">{fmtUsd(state.totalLiq24hShort)}</b>
        </span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span>
          OI <b className="tick-num tracking-normal text-mist-200">{fmtUsd(state.oi, 2)}</b>{" "}
          <span className={state.oiDelta1h >= 0 ? "text-long-300" : "text-short-300"}>
            {fmtPct(state.oiDelta1h, 2)} 1h
          </span>
        </span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span>
          Funding{" "}
          <b className={`tick-num tracking-normal ${state.funding >= 0 ? "text-long-300" : "text-short-300"}`}>
            {fmtPct(state.funding, 4)}
          </b>
        </span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span>
          CVD{" "}
          <b className={`tick-num tracking-normal ${state.cvd[state.cvd.length - 1] >= 0 ? "text-long-300" : "text-short-300"}`}>
            {fmtCompact(state.cvd[state.cvd.length - 1])}
          </b>
        </span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span className="flex items-center gap-1.5" title={regime.note}>
          Régimen{" "}
          <b className={`border px-1.5 py-0.5 tracking-normal ${REGIME_TONE[regime.tone]}`}>{regime.label}</b>
        </span>
        <span className="ml-auto hidden items-center gap-2 md:flex">
          <span className="border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-mist-400">{tfKey}</span>
          <span className="border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-mist-400">{logScale ? "LOG" : "LIN"}</span>
          <span className={`border px-1.5 py-0.5 ${zoomed ? "border-flare-400/40 text-flare-300" : "border-ink-700 bg-ink-850 text-mist-400"}`}>
            ×{(CANDLE_COUNT / visibleCount).toFixed(1)}
          </span>
          <span className="text-mist-600">rueda = zoom · doble clic = reset</span>
        </span>
      </footer>
    </section>
  );
}
