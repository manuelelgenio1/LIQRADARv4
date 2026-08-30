import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MarketState } from "../lib/market";
import { CANDLE_COUNT, HEAT_BINS } from "../lib/market";
import {
  adxThrOf,
  mtfAdjust,
  type IndicatorBundle,
  type IndicatorCfg,
  type TrendDir,
} from "../lib/indicators";
import {
  computeSessions,
  computeVoids,
  computeVwap,
  computeVolProfile,
  computeLiqRegime,
  type LiqRegime,
} from "../lib/overlays";
import { fmtAxisTime, fmtCompact, fmtHM, fmtPct, fmtPrice, fmtUsd } from "../lib/format";

type Osc = "cvd" | "macd" | "rsi" | "adx" | "vol";

interface Props {
  state: MarketState;
  tfKey: string;
  setTfKey: (k: string) => void;
  timeframes: { key: string; minutes: number }[];
  realCvd?: boolean;
  ind: IndicatorBundle;   // calculado UNA vez en el Dashboard (hook compartido)
  cfg: IndicatorCfg;
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
}

const H = 540;
const SCALE_W = 86;
const SUB_H = 96;
const TIME_H = 22;
const PAD_T = 16;
const MIN_VIS = 24;

const ZOOM_KEY = "liqradar:zoom:v1";
const LEV_KEY = "liqradar:lev:v2";
const LOG_KEY = "liqradar:log:v1";

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
const LAYER_META: { id: LayerId; label: string; tip: string }[] = [
  { id: "clusters", label: "Clústeres", tip: "Líneas de los clústeres de liquidación detectados" },
  { id: "lev", label: "Apalancamiento", tip: "Escalera de liquidación (x5–x100)" },
  { id: "sessions", label: "PDH / PDL", tip: "Alto/Bajo/Apertura del día anterior + sesión actual" },
  { id: "vp", label: "V. Profile", tip: "Perfil de volumen: POC + Área de Valor (VAH/VAL)" },
  { id: "vwap", label: "VWAP", tip: "Precio medio ponderado por volumen (referencia institucional)" },
  { id: "ema", label: "EMAs", tip: "Medias móviles exponenciales" },
  { id: "st", label: "Supertrend", tip: "Línea ATR de tendencia" },
  { id: "cvdOv", label: "CVD sobre precio", tip: "Delta acumulado superpuesto (divergencias)" },
  { id: "voids", label: "Huecos", tip: "Huecos de liquidez (bandas frías)" },
];
const LAYER_DOT: Record<LayerId, string> = {
  clusters: "bg-short-400",
  lev: "bg-flare-400",
  sessions: "bg-long-400",
  ema: "bg-long-300",
  st: "bg-long-400",
  cvdOv: "bg-flare-300",
  voids: "bg-flare-400",
  vwap: "bg-mist-200",
  vp: "bg-mist-400",
};
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

// ---------- rampas térmicas (LUT) ----------
const LONG_STOPS: [number, number, number, number][] = [
  [13, 42, 64, 0], [20, 90, 86, 90], [24, 145, 130, 150], [45, 224, 192, 205], [150, 255, 226, 240], [235, 255, 250, 255],
];
const SHORT_STOPS: [number, number, number, number][] = [
  [62, 16, 34, 0], [110, 22, 48, 90], [175, 30, 70, 150], [240, 70, 110, 205], [255, 150, 170, 240], [255, 232, 238, 255],
];
function sampleRamp(t: number, stops: [number, number, number, number][]): [number, number, number, number] {
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f,
  ];
}

const LEVS = [5, 10, 20, 50, 100];
const LEV_ALPHA: Record<number, number> = { 5: 0.34, 10: 0.38, 20: 0.44, 50: 0.55, 100: 0.68 };

function loadLevOn(): Record<number, boolean> {
  const d: Record<number, boolean> = { 5: false, 10: true, 20: true, 50: true, 100: true };
  try {
    const raw = localStorage.getItem(LEV_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, boolean>;
      for (const lv of LEVS) if (typeof p[String(lv)] === "boolean") d[lv] = p[String(lv)];
    }
  } catch {
    /* valores por defecto */
  }
  return d;
}

// soporte de ctx.filter (Safari < 17 no lo tiene)
const CAN_FILTER = (() => {
  try {
    const c = document.createElement("canvas").getContext("2d");
    return !!c && "filter" in c;
  } catch {
    return false;
  }
})();

const TREND_META: Record<TrendDir, { label: string; c: string; bar: string }> = {
  alcista: { label: "Alcista", c: "border-long-500/50 bg-long-900/40 text-long-300", bar: "#2de0c0" },
  bajista: { label: "Bajista", c: "border-short-500/50 bg-short-900/40 text-short-300", bar: "#ff5d7e" },
  lateral: { label: "Lateral", c: "border-flare-400/50 bg-flare-400/10 text-flare-300", bar: "#ffb224" },
};

function TrendIcon({ dir }: { dir: TrendDir }) {
  if (dir === "lateral")
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M4 12 H20" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      {dir === "alcista" ? <path d="M12 4 L21 18 H3 Z" /> : <path d="M12 20 L3 6 H21 Z" />}
    </svg>
  );
}

// ---------- menú desplegable de capas ----------
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
        <div className="anim-feed-in absolute right-0 top-full z-40 mt-2 w-60 border border-ink-600 bg-ink-900/95 py-1 shadow-2xl backdrop-blur-md">
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

// ---------- grupos de la barra de herramientas ----------
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

interface Hover { x: number; y: number; idx: number; price: number; heat: number; }

const REGIME_TONE: Record<LiqRegime["tone"], string> = {
  long: "border-long-500/50 bg-long-900/40 text-long-300",
  short: "border-short-500/50 bg-short-900/40 text-short-300",
  warn: "border-flare-400/50 bg-flare-400/10 text-flare-300",
  flat: "border-ink-600 bg-ink-800 text-mist-400",
};

export default function HeatmapChart({ state, tfKey, setTfKey, timeframes, realCvd, ind, cfg, confluence }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(900);
  const [chartH, setChartH] = useState(H);
  const [hover, setHover] = useState<Hover | null>(null);
  const [osc, setOsc] = useState<Osc>("cvd");
  const [visibleCount, setVisibleCount] = useState(() => loadZoom(tfKey));
  const [levOn, setLevOn] = useState<Record<number, boolean>>(loadLevOn);
  const [layers, setLayers] = useState<Layers>(loadLayers);
  const [layersOpen, setLayersOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [logScale, setLogScale] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LOG_KEY) === "1";
    } catch {
      return false;
    }
  });

  const meta = state.meta;
  const tfMin = timeframes.find((t) => t.key === tfKey)?.minutes ?? 5;

  // ---- mapeo precio↔píxel (lineal o logarítmico) compartido por canvas y tooltip ----
  const view = useMemo(() => {
    const start = CANDLE_COUNT - visibleCount;
    let yMin = Infinity, yMax = -Infinity;
    for (let i = start; i < CANDLE_COUNT; i++) {
      yMin = Math.min(yMin, state.candles[i].l);
      yMax = Math.max(yMax, state.candles[i].h);
    }
    const pad = (yMax - yMin) * 0.06 || 1;
    return { start, yMin: yMin - pad, yMax: yMax + pad };
  }, [state.candles, visibleCount]);

  // memoizadas: son dependencias del efecto de dibujo y no deben recrearse en
  // cada render (evita redibujos innecesarios y referencias inestables)
  const scaleY = useMemo(
    () => (p: number, plotTop: number, plotH: number) => {
      if (logScale && view.yMin > 0 && p > 0) {
        const lmin = Math.log(view.yMin), lmax = Math.log(view.yMax);
        return plotTop + ((lmax - Math.log(p)) / (lmax - lmin)) * plotH;
      }
      return plotTop + ((view.yMax - p) / (view.yMax - view.yMin)) * plotH;
    },
    [logScale, view]
  );
  const scalePrice = useMemo(
    () => (py: number, plotTop: number, plotH: number) => {
      if (logScale && view.yMin > 0) {
        const lmin = Math.log(view.yMin), lmax = Math.log(view.yMax);
        return Math.exp(lmax - ((py - plotTop) / plotH) * (lmax - lmin));
      }
      return view.yMax - ((py - plotTop) / plotH) * (view.yMax - view.yMin);
    },
    [logScale, view]
  );

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
  }, [visibleCount, tfKey]);

  useEffect(() => {
    try {
      localStorage.setItem(LEV_KEY, JSON.stringify(levOn));
    } catch {
      /* sin almacenamiento */
    }
  }, [levOn]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYER_KEY, JSON.stringify(layers));
    } catch {
      /* sin almacenamiento */
    }
  }, [layers]);

  useEffect(() => {
    try {
      localStorage.setItem(LOG_KEY, logScale ? "1" : "0");
    } catch {
      /* sin almacenamiento */
    }
  }, [logScale]);

  // Medición robusta del área del gráfico (normal y pantalla completa):
  // ResizeObserver + reintentos tras cambiar de modo + listener de ventana +
  // respaldo basado en la ventana. El canvas usa SIEMPRE píxeles (chartH).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || el.getBoundingClientRect().width;
      let h: number;
      if (fullscreen) {
        h = el.clientHeight || el.getBoundingClientRect().height;
        // Respaldo: si el flex aún no dio altura útil, deducir de la ventana
        // (cabecera + barra de herramientas + barra de estado ≈ 190 px).
        if (h < 320) h = Math.max(320, window.innerHeight - 190);
      } else {
        h = H;
      }
      setWidth((prev) => (prev === w ? prev : w));
      setChartH((prev) => (prev === h ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    // tras el cambio de modo el layout se asienta unos frames después: re-medir
    const t1 = window.setTimeout(measure, 60);
    const t2 = window.setTimeout(measure, 320);
    const raf1 = requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(measure))
    );
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      cancelAnimationFrame(raf1);
    };
  }, [fullscreen]);

  // ESC cierra la pantalla completa + bloquea el scroll del fondo + atajos
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
      else if (e.key === "+" || e.key === "=") zoomBy(-1);
      else if (e.key === "-") zoomBy(1);
      else if (e.key.toLowerCase() === "l") setLogScale((v) => !v);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const idx = timeframes.findIndex((t) => t.key === tfKey);
        const next = e.key === "ArrowRight" ? Math.min(timeframes.length - 1, idx + 1) : Math.max(0, idx - 1);
        setTfKey(timeframes[next].key);
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, tfKey]);

  // ---------- overlays derivados ----------
  // sesiones: usa la serie warm (hasta 500 velas) para que PDH/PDL sean
  // fiables incluso en 1m/5m, donde 128 velas no cubren el día anterior.
  const sessions = useMemo(
    () =>
      computeSessions(
        state.warm && state.warm.length >= CANDLE_COUNT ? state.warm : state.candles,
        tfMin
      ),
    [state.warm, state.candles, tfMin]
  );

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

  const zoomBy = (dir: number) => {
    setVisibleCount((v) => {
      const next = Math.round(v * (dir > 0 ? 1.25 : 0.8));
      return Math.max(MIN_VIS, Math.min(CANDLE_COUNT, next));
    });
  };

  // wheel NATIVO no pasivo: React registra onWheel como pasivo y
  // preventDefault lanzaba error en consola; así el zoom no desplaza la página
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomByRef.current(e.deltaY > 0 ? 1 : -1);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ================= dibujo =================
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

    const { candles, heat, pMin, pMax, clusters, cvd } = state;
    const plotW = width - SCALE_W;
    const plotTop = PAD_T;
    const plotBottom = chartH - TIME_H - SUB_H - 12;
    const plotH = plotBottom - plotTop;
    const subTop = plotBottom + 12;
    const subBottom = chartH - TIME_H - 4;
    const lastC = candles[CANDLE_COUNT - 1].c;
    const cellW = plotW / visibleCount;
    const y = (p: number) => scaleY(p, plotTop, plotH);
    const priceAt = (py: number) => scalePrice(py, plotTop, plotH);

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

    // ---- render térmico suavizado (offscreen + interpolación + bloom) ----
    let heatVisMax = 0;
    for (let i = view.start; i < CANDLE_COUNT; i++)
      for (let b = 0; b < HEAT_BINS; b++) heatVisMax = Math.max(heatVisMax, heat[i * HEAT_BINS + b]);
    if (heatVisMax <= 0) heatVisMax = state.heatMax || 1;

    if (!offRef.current) offRef.current = document.createElement("canvas");
    const off = offRef.current;
    const HEAT_ROWS = 160;
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
        // curva suave (exponente bajo) para que las zonas de intensidad media
        // sean visibles también en temporalidades bajas con calor más disperso
        const t = Math.min(1, Math.pow(v / heatVisMax, 1.05));
        if (t < 0.02) {
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
    // bloom: segunda pasada para resaltar las zonas calientes
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.3;
    if (CAN_FILTER) {
      ctx.filter = "blur(5px)";
      ctx.drawImage(off, 0, plotTop, plotW, plotH);
      ctx.filter = "none";
    } else {
      ctx.drawImage(off, -plotW * 0.004, plotTop - plotH * 0.01, plotW * 1.008, plotH * 1.02);
      ctx.globalAlpha = 0.16;
      ctx.drawImage(off, -plotW * 0.012, plotTop - plotH * 0.028, plotW * 1.024, plotH * 1.056);
    }
    ctx.restore();

    // ---- huecos de liquidez ----
    if (layers.voids) {
      for (const vd of liqVoids) {
        const vy0 = y(vd.yMax);
        const vy1 = y(vd.yMin);
        if (vy1 < plotTop || vy0 > plotBottom) continue;
        const top = Math.max(plotTop, vy0);
        const bot = Math.min(plotBottom, vy1);
        if (bot - top < 4) continue;
        ctx.fillStyle = "rgba(255,178,36,0.05)";
        ctx.fillRect(0, top, plotW, bot - top);
        ctx.strokeStyle = "rgba(255,178,36,0.4)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(0, top); ctx.lineTo(plotW, top);
        ctx.moveTo(0, bot); ctx.lineTo(plotW, bot);
        ctx.stroke();
        ctx.setLineDash([]);
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

    // ---- Volume Profile: histograma lateral + POC + Área de Valor ----
    if (layers.vp && volProfile) {
      const span = state.pMax - state.pMin;
      if (span > 0) {
        const vol = volProfile.rows;
        const rowH = volProfile.rowH;
        let maxV = 0;
        for (let r = 0; r < vol.length; r++) maxV = Math.max(maxV, vol[r]);
        const maxBarW = plotW * 0.16;
        for (let r = 0; r < vol.length; r++) {
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
        const pxx = (i - view.start) * cellW + cellW / 2;
        const pyy = y(v);
        if (!started) { ctx.moveTo(pxx, pyy); started = true; }
        else ctx.lineTo(pxx, pyy);
      }
      ctx.strokeStyle = "rgba(219,230,247,0.55)";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      const lastV = vwap[CANDLE_COUNT - 1];
      if (Number.isFinite(lastV)) {
        const pyy = y(lastV);
        if (pyy > plotTop && pyy < plotBottom) {
          ctx.fillStyle = "#dbe6f7";
          ctx.beginPath();
          ctx.arc(plotW - 3, pyy, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ---- marcadores de clústeres (línea reforzada + halo) ----
    if (layers.clusters) for (const cl of clusters.slice(0, 6)) {
      const cy = y(cl.price);
      if (cy < plotTop || cy > plotBottom) continue;
      const col = cl.side === "long" ? "45,224,192" : "255,93,126";
      ctx.strokeStyle = `rgba(${col},0.16)`;
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(plotW, cy);
      ctx.stroke();
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
    if (layers.lev) {
      const rightX = plotW - 128; // columna alineada de etiquetas
      const placed: { y: number }[] = [];
      const items: { price: number; col: string; tag: string }[] = [];
      for (const lev of LEVS) {
        if (!levOn[lev]) continue;
        const pctDist = 100 / lev;
        items.push({ price: lastC * (1 - 1 / lev), col: "45,224,192", tag: `x${lev} ${pctDist < 10 ? pctDist.toFixed(1) : pctDist.toFixed(0)}% L` });
        items.push({ price: lastC * (1 + 1 / lev), col: "255,93,126", tag: `x${lev} ${pctDist < 10 ? pctDist.toFixed(1) : pctDist.toFixed(0)}% S` });
      }
      items.sort((a, b) => b.price - a.price);

      // Los niveles de liquidación están a distancias fijas del precio (x100=±1%,
      // x10=±10%, x5=±20%). En temporalidades intradiarias la ventana visible es
      // muy estrecha, así que varios niveles quedan FUERA del canvas. En vez de
      // descartarlos en silencio, se anclan al borde superior/inferior para que
      // el usuario siempre sepa dónde están (como hace TradingView/Bookmap).
      let topN = 0;
      let bottomN = 0;
      for (const it of items) {
        const ly = y(it.price);
        const alpha = LEV_ALPHA[Number(it.tag.match(/x(\d+)/)?.[1] ?? 20)] ?? 0.4;
        const aboveView = ly < plotTop + 3; // nivel por encima de la ventana
        const belowView = ly > plotBottom - 3; // nivel por debajo de la ventana

        if (!aboveView && !belowView) {
          // ---- DENTRO de la ventana: línea + etiqueta (comportamiento original) ----
          ctx.strokeStyle = `rgba(${it.col},${alpha})`;
          ctx.lineWidth = 1.1;
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.moveTo(0, ly);
          ctx.lineTo(plotW, ly);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          let ey = ly;
          for (const p of placed) {
            if (Math.abs(ey - p.y) < 15) ey = p.y + 15;
          }
          if (ey > plotBottom - 8) ey = plotBottom - 8;
          placed.push({ y: ey });
          ctx.font = "600 9px 'IBM Plex Mono', monospace";
          const tw = ctx.measureText(it.tag).width;
          if (Math.abs(ey - ly) > 2) {
            ctx.strokeStyle = `rgba(${it.col},0.35)`;
            ctx.beginPath();
            ctx.moveTo(rightX + tw + 14, ey);
            ctx.lineTo(plotW - 4, ly);
            ctx.stroke();
          }
          ctx.fillStyle = "rgba(7,12,22,0.92)";
          ctx.fillRect(rightX, ey - 8, tw + 14, 15);
          ctx.strokeStyle = `rgba(${it.col},${Math.min(1, alpha + 0.2)})`;
          ctx.strokeRect(rightX + 0.5, ey - 7.5, tw + 13, 14);
          ctx.fillStyle = `rgba(${it.col},${Math.min(1, alpha + 0.25)})`;
          ctx.textAlign = "left";
          ctx.fillText(it.tag, rightX + 7, ey + 0.5);
          ctx.font = "10px 'IBM Plex Mono', monospace";
        } else {
          // ---- FUERA de la ventana: marcador anclado al borde ----
          // shorts (arriba del precio) se apilan desde el borde superior;
          // longs (abajo del precio) desde el borde inferior.
          const isTop = aboveView;
          let ey = isTop ? plotTop + 8 + topN * 17 : plotBottom - 8 - bottomN * 17;
          if (isTop) topN++;
          else bottomN++;
          // no dejar que la pila se salga del área de dibujo
          ey = Math.max(plotTop + 8, Math.min(plotBottom - 8, ey));
          const label = `${isTop ? "▲" : "▼"} ${it.tag}`;
          ctx.font = "600 9px 'IBM Plex Mono', monospace";
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(7,12,22,0.88)";
          ctx.fillRect(rightX, ey - 8, tw + 14, 15);
          ctx.strokeStyle = `rgba(${it.col},${Math.min(1, alpha + 0.15)})`;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(rightX + 0.5, ey - 7.5, tw + 13, 14);
          ctx.setLineDash([]);
          ctx.fillStyle = `rgba(${it.col},${Math.min(1, alpha + 0.2)})`;
          ctx.textAlign = "left";
          ctx.fillText(label, rightX + 7, ey + 0.5);
          ctx.font = "10px 'IBM Plex Mono', monospace";
        }
      }
    }

    // ---- líneas de sesión (PDH/PDL/PDO + sesión actual) ----
    if (layers.sessions) {
      const drawSess = (price: number, col: string, label: string, dash?: number[]) => {
        if (!Number.isFinite(price)) return;
        const ly = y(price);
        if (ly < plotTop + 4 || ly > plotBottom - 4) return;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.1;
        ctx.setLineDash(dash ?? []);
        ctx.beginPath();
        ctx.moveTo(0, ly); ctx.lineTo(plotW, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "600 8.5px 'IBM Plex Mono', monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(7,12,22,0.9)";
        ctx.fillRect(plotW - tw - 20, ly - 7, tw + 14, 13);
        ctx.strokeStyle = col;
        ctx.strokeRect(plotW - tw - 19.5, ly - 6.5, tw + 13, 12);
        ctx.fillStyle = col;
        ctx.textAlign = "left";
        ctx.fillText(label, plotW - tw - 13, ly + 0.5);
        ctx.font = "10px 'IBM Plex Mono', monospace";
      };
      drawSess(sessions.pdh, "rgba(45,224,192,0.7)", `PDH ${fmtPrice(sessions.pdh, meta.decimals)}`, [5, 4]);
      drawSess(sessions.pdl, "rgba(255,93,126,0.7)", `PDL ${fmtPrice(sessions.pdl, meta.decimals)}`, [5, 4]);
      drawSess(sessions.pdo, "rgba(143,163,196,0.6)", `PDO ${fmtPrice(sessions.pdo, meta.decimals)}`, [2, 4]);
      drawSess(sessions.sdh, "rgba(45,224,192,0.38)", "H hoy", [1, 4]);
      drawSess(sessions.sdl, "rgba(255,93,126,0.38)", "L hoy", [1, 4]);
    }

    // ---- velas ----
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

    // ---- Supertrend + marcadores de giro CONFIRMADO ----
    if (layers.st) {
      ctx.lineWidth = 1.6;
      for (let i = view.start + 1; i < CANDLE_COUNT; i++) {
        const px0 = (i - 1 - view.start) * cellW + cellW / 2;
        const px1 = (i - view.start) * cellW + cellW / 2;
        ctx.strokeStyle = ind.stUp[i] ? "rgba(45,224,192,0.85)" : "rgba(255,93,126,0.85)";
        ctx.beginPath();
        ctx.moveTo(px0, y(ind.st[i - 1]));
        ctx.lineTo(px1, y(ind.st[i]));
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      for (let i = Math.max(1, view.start); i < CANDLE_COUNT; i++) {
        if (ind.stUpConf[i] !== ind.stUpConf[i - 1]) {
          const cx = (i - view.start) * cellW + cellW / 2;
          const cy = y(ind.st[i]);
          ctx.beginPath();
          ctx.arc(cx, cy, 3.4, 0, Math.PI * 2);
          ctx.fillStyle = ind.stUpConf[i] ? "#2de0c0" : "#ff5d7e";
          ctx.fill();
          ctx.strokeStyle = "#070c16";
          ctx.stroke();
        }
      }
    }

    // ---- EMAs ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, plotTop, plotW, plotH);
    ctx.clip();
    if (layers.ema) {
      const drawEma = (arr: number[], col: string, w: number, dash?: number[]) => {
        ctx.beginPath();
        ctx.setLineDash(dash ?? []);
        for (let i = view.start; i < CANDLE_COUNT; i++) {
          const pxx = (i - view.start) * cellW + cellW / 2;
          const pyy = y(arr[i]);
          if (i === view.start) ctx.moveTo(pxx, pyy);
          else ctx.lineTo(pxx, pyy);
        }
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.setLineDash([]);
      };
      drawEma(ind.emaTrend, "rgba(143,163,196,0.75)", 1.2, [4, 4]);
      drawEma(ind.emaSlow, "#ffb224", 1.5);
      drawEma(ind.emaFast, "#7df0da", 1.5);
    }

    // ---- CVD superpuesto al precio (divergencias) ----
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
        const pxx = (i - view.start) * cellW + cellW / 2;
        if (i === view.start) ctx.moveTo(pxx, cyv(cvd[i]));
        else ctx.lineTo(pxx, cyv(cvd[i]));
      }
      ctx.strokeStyle = "rgba(255,211,122,0.62)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([7, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // ---- línea de precio actual ----
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

    // ---- eje temporal ----
    ctx.fillStyle = "#48597a";
    ctx.textAlign = "center";
    const step = Math.max(1, Math.round(visibleCount / 5));
    for (let i = view.start; i < CANDLE_COUNT; i += step) {
      ctx.fillText(
        fmtAxisTime(candles[i].t, tfMin),
        (i - view.start) * cellW + cellW / 2,
        chartH - TIME_H / 2 - 4
      );
    }

    // ================= sub-panel de osciladores =================
    ctx.strokeStyle = "rgba(37,54,80,0.55)";
    ctx.beginPath();
    ctx.moveTo(0, subTop - 6);
    ctx.lineTo(width, subTop - 6);
    ctx.stroke();
    const slice = (arr: number[]) => arr.slice(view.start);
    const sliceB = (arr: boolean[]) => arr.slice(view.start);
    const pxOf = (i: number) => i * cellW + cellW / 2;

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
      for (let i = 0; i < cv.length; i++) ctx.lineTo(pxOf(i) , cy2(cv[i]));
      ctx.lineTo(plotW, subBottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < cv.length; i++) {
        if (i === 0) ctx.moveTo(pxOf(i), cy2(cv[i]));
        else ctx.lineTo(pxOf(i), cy2(cv[i]));
      }
      ctx.strokeStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(realCvd ? "CVD · delta real (aggTrade)" : "CVD · delta acumulado", 8, subTop + 1);
      ctx.fillStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
      ctx.fillText(fmtCompact(cv[cv.length - 1]), realCvd ? 172 : 146, subTop + 1);
    } else if (osc === "macd") {
      const hS = slice(ind.hist), mS = slice(ind.macd), sS = slice(ind.signal);
      let mx = 1e-9;
      for (let i = 0; i < hS.length; i++) mx = Math.max(mx, Math.abs(hS[i]), Math.abs(mS[i]), Math.abs(sS[i]));
      const my = (v: number) => subTop + (1 - (v / mx + 1) / 2) * (subBottom - subTop);
      const zeroY = my(0);
      for (let i = 0; i < hS.length; i++) {
        const hh = my(hS[i]);
        ctx.fillStyle = hS[i] >= 0 ? "rgba(45,224,192,0.5)" : "rgba(255,93,126,0.5)";
        ctx.fillRect(pxOf(i) - cellW * 0.3, Math.min(hh, zeroY), cellW * 0.6, Math.max(1, Math.abs(hh - zeroY)));
      }
      ctx.strokeStyle = "rgba(95,115,150,0.35)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(plotW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
      const line = (arr: number[], col: string) => {
        ctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
          if (i === 0) ctx.moveTo(pxOf(i), my(arr[i]));
          else ctx.lineTo(pxOf(i), my(arr[i]));
        }
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.lineWidth = 1;
      };
      line(mS, "#7df0da");
      line(sS, "#ffb224");
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(`MACD ${cfg.macd[0]},${cfg.macd[1]},${cfg.macd[2]}`, 8, subTop + 1);
      ctx.fillStyle = "#7df0da";
      ctx.fillText(mS[mS.length - 1].toFixed(2), 118, subTop + 1);
      ctx.fillStyle = "#ffb224";
      ctx.fillText(sS[sS.length - 1].toFixed(2), 176, subTop + 1);
    } else if (osc === "rsi") {
      const rS = slice(ind.rsi);
      const ry = (v: number) => subTop + (1 - v / 100) * (subBottom - subTop);
      ctx.fillStyle = "rgba(255,93,126,0.05)";
      ctx.fillRect(0, ry(100), plotW, ry(70) - ry(100));
      ctx.fillStyle = "rgba(45,224,192,0.05)";
      ctx.fillRect(0, ry(30), plotW, ry(0) - ry(30));
      for (const lvl of [70, 50, 30]) {
        ctx.strokeStyle = lvl === 50 ? "rgba(95,115,150,0.4)" : "rgba(95,115,150,0.25)";
        ctx.setLineDash(lvl === 50 ? [3, 4] : [2, 5]);
        ctx.beginPath();
        ctx.moveTo(0, ry(lvl));
        ctx.lineTo(plotW, ry(lvl));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#48597a";
        ctx.textAlign = "right";
        ctx.fillText(String(lvl), plotW - 4, ry(lvl));
      }
      ctx.beginPath();
      for (let i = 0; i < rS.length; i++) {
        if (i === 0) ctx.moveTo(pxOf(i), ry(rS[i]));
        else ctx.lineTo(pxOf(i), ry(rS[i]));
      }
      ctx.strokeStyle = "#b7c7e2";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
      const rv = rS[rS.length - 1];
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(`RSI ${cfg.rsi}`, 8, subTop + 1);
      ctx.fillStyle = rv > 70 ? "#ff5d7e" : rv < 30 ? "#2de0c0" : "#b7c7e2";
      ctx.fillText(rv.toFixed(1), 66, subTop + 1);
    } else if (osc === "adx") {
      const aS = slice(ind.adx), pS = slice(ind.pdi), mS = slice(ind.mdi);
      const thr = adxThrOf(cfg);
      let mx = 40;
      for (let i = 0; i < aS.length; i++) mx = Math.max(mx, aS[i], pS[i], mS[i]);
      const ay = (v: number) => subTop + (1 - Math.min(1, v / mx)) * (subBottom - subTop);
      ctx.fillStyle = "rgba(255,178,36,0.06)";
      ctx.fillRect(0, ay(mx), plotW, ay(thr) - ay(mx));
      ctx.strokeStyle = "rgba(95,115,150,0.35)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, ay(thr));
      ctx.lineTo(plotW, ay(thr));
      ctx.stroke();
      ctx.setLineDash([]);
      const line = (arr: number[], col: string, w: number) => {
        ctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
          if (i === 0) ctx.moveTo(pxOf(i), ay(arr[i]));
          else ctx.lineTo(pxOf(i), ay(arr[i]));
        }
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.lineWidth = 1;
      };
      line(pS, "rgba(45,224,192,0.8)", 1.2);
      line(mS, "rgba(255,93,126,0.8)", 1.2);
      line(aS, "#dbe6f7", 1.8);
      const av = aS[aS.length - 1];
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText(`ADX ${cfg.adx} · fuerza de tendencia`, 8, subTop + 1);
      ctx.fillStyle = av >= thr ? "#ffb224" : "#8fa3c4";
      ctx.fillText(av.toFixed(1), 196, subTop + 1);
      ctx.fillStyle = "#48597a";
      ctx.fillText(`fuerte ≥ ${thr}`, 236, subTop + 1);
    } else {
      // VOL: volumen por vela coloreado por delta
      const vS = candles.slice(view.start).map((k) => k.v);
      const dS = candles.slice(view.start).map((k) => k.delta);
      let mx = 1e-9;
      for (const v of vS) mx = Math.max(mx, v);
      for (let i = 0; i < vS.length; i++) {
        const hh = (vS[i] / mx) * (subBottom - subTop - 6);
        ctx.fillStyle = dS[i] >= 0 ? "rgba(45,224,192,0.5)" : "rgba(255,93,126,0.5)";
        ctx.fillRect(pxOf(i) - cellW * 0.32, subBottom - hh, cellW * 0.64, hh);
      }
      // línea de delta
      let dMin = Infinity, dMax = -Infinity;
      for (const d of dS) { dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); }
      const dSpan = Math.max(1e-9, dMax - dMin);
      const dy = (v: number) => subTop + ((dMax - v) / dSpan) * (subBottom - subTop);
      ctx.beginPath();
      for (let i = 0; i < dS.length; i++) {
        if (i === 0) ctx.moveTo(pxOf(i), dy(dS[i]));
        else ctx.lineTo(pxOf(i), dy(dS[i]));
      }
      ctx.strokeStyle = "rgba(219,230,247,0.65)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText("VOL · barras = volumen · línea = delta", 8, subTop + 1);
    }

    // ---- crosshair ----
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
  }, [state, width, chartH, hover, ind, cfg, osc, tfMin, view, visibleCount, levOn, realCvd, logScale, layers, liqVoids, sessions, vwap, volProfile, scaleY, scalePrice, meta]);

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
    // mismo máximo de ventana que usa el canvas
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
  const mtf = mtfAdjust(cons, confluence);
  const regime = computeLiqRegime(state.funding, state.oiDelta1h);
  const lastStUp = ind.stUpConf[ind.stUpConf.length - 1];
  const zoomed = visibleCount < CANDLE_COUNT;

  return (
    <section
      className={`panel panel-corner ${fullscreen ? "" : "anim-reveal"} ${
        fullscreen ? "z-50 flex flex-col overflow-hidden rounded-none border-0" : ""
      }`}
      // position/inset van en style inline: ".panel { position: relative }" es CSS
      // sin capa y en la cascada vence a la utilidad ".fixed" de Tailwind, por lo
      // que solo un inline style garantiza que el panel pase a pantalla completa.
      style={
        fullscreen
          ? { position: "fixed", inset: 0, width: "100vw", height: "100vh" }
          : { animationDelay: "0.05s" }
      }
    >
      {/* cabecera: identidad + tendencia + régimen + acciones */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-700/50 px-4 py-2.5">
        <div className="flex items-center gap-2.5 leading-none">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="2" y="12" width="3.5" height="8" fill="#2de0c0" opacity="0.9" />
            <rect x="7" y="7" width="3.5" height="13" fill="#2de0c0" opacity="0.6" />
            <rect x="12" y="10" width="3.5" height="10" fill="#ff5d7e" opacity="0.6" />
            <rect x="17" y="4" width="3.5" height="16" fill="#ff5d7e" opacity="0.9" />
          </svg>
          <div>
            <h2 className="font-display text-[15px] font-bold uppercase tracking-[0.14em] text-mist-100">
              Heatmap de liquidaciones
              {fullscreen && <span className="ml-2 text-long-400">· pantalla completa</span>}
            </h2>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
              <b className="text-mist-300">{state.meta.symbol}</b> · perp · energía por nivel
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
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M12 2v20M5 8l7-6 7 6M5 16l7 6 7-6" strokeLinecap="round" strokeLinejoin="round" />
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
      <div className="scroll-slim flex items-center gap-x-4 gap-y-2 overflow-x-auto border-b border-ink-700/50 bg-ink-900/60 px-4 py-2">
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
          title="Líneas de liquidación por apalancamiento: distancia ≈ 1/apalancamiento desde el precio actual (margen aislado)"
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

        {/* leyenda flotante minimal */}
        <div className="pointer-events-none absolute left-2 top-2 z-10">
          <div className="flex items-center gap-2.5 border border-ink-700/70 bg-ink-900/80 px-2.5 py-1 font-mono text-[8px] uppercase tracking-wider text-mist-500 backdrop-blur-[2px]">
            {layers.clusters && (
              <>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 bg-long-400/90" /> longs ↓
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 bg-short-400/90" /> shorts ↑
                </span>
              </>
            )}
            <span className="flex items-center gap-1">
              <span
                className="h-1.5 w-6"
                style={{ background: "linear-gradient(90deg, rgba(45,224,192,0.1), #ffd37a, #fff)" }}
              />
              energía
            </span>
            {layers.st && (
              <span className={`flex items-center gap-1 font-bold ${lastStUp ? "text-long-300" : "text-short-300"}`}>
                ST {lastStUp ? "▲" : "▼"}
              </span>
            )}
          </div>
        </div>

        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: chartH, display: "block", cursor: "crosshair" }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onDoubleClick={() => setVisibleCount(CANDLE_COUNT)}
        />
        {hover && k && (
          <div
            className="pointer-events-none absolute z-20 border border-ink-600 bg-ink-900/95 px-3 py-2 font-mono text-[10px] shadow-xl"
            style={{
              left: Math.min(hover.x + 16, width - 230),
              top: Math.min(hover.y + 14, chartH - 190),
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
              <span className="text-mist-600">EMA {cfg.fast}</span>
              <span className="tick-num text-right text-long-300">{fmtPrice(ind.emaFast[hover.idx], state.meta.decimals)}</span>
              <span className="text-mist-600">EMA {cfg.slow}</span>
              <span className="tick-num text-right text-flare-300">{fmtPrice(ind.emaSlow[hover.idx], state.meta.decimals)}</span>
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
