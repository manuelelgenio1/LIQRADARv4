import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MarketState } from "../lib/market";
import { CANDLE_COUNT, CHART_CLUSTER_LIMIT, HEAT_BINS } from "../lib/market";
import { adxThrOf, mtfAdjust, type IndicatorBundle, type IndicatorCfg, type TrendDir } from "../lib/indicators";
import { computeLiqRegime, computeSessions, computeVoids, computeVolProfile, computeVwap } from "../lib/overlays";
import { fmtAxisTime, fmtCompact, fmtHM, fmtPct, fmtPrice, fmtUsd } from "../lib/format";
import { readFlag, readLS, writeFlag, writeLS } from "../lib/storage";
import type { MarketKind } from "../lib/live";

type Osc = "cvd" | "macd" | "rsi" | "adx" | "vol";
type LayerId = "clusters" | "lev" | "sessions" | "ema" | "st" | "cvdOv" | "voids" | "vwap" | "vp";
type Layers = Record<LayerId, boolean>;

interface Props {
  state: MarketState;
  tfKey: string;
  setTfKey: (k: string) => void;
  timeframes: { key: string; minutes: number }[];
  realCvd?: boolean;
  ind: IndicatorBundle;
  cfg: IndicatorCfg;
  confluence?: { tf: string; dir: TrendDir; strength: number }[] | null;
  market?: MarketKind;
}

const H = 560;
const SCALE_W = 86;
const SUB_H = 96;
const TIME_H = 22;
const PAD_T = 16;
const MINIMAP_H = 44;
const MIN_VIS = 24;
const DEFAULT_VIS = 88;

const ZOOM_KEY = "liqradar:zoom:v1";
const LEV_KEY = "liqradar:lev:v1";
const LAYER_KEY = "liqradar:layers:v1";
const LOG_KEY = "liqradar:log:v1";
const HEAT_KEY = "liqradar:heatint:v1";
const LIQVIEW_KEY = "liqradar:liqview:v1";

const DEFAULT_LAYERS: Layers = {
  clusters: true, lev: true, sessions: true, ema: true, st: true, cvdOv: false, voids: true, vwap: true, vp: true,
};
const LAYER_META: { id: LayerId; label: string; tip: string }[] = [
  { id: "clusters", label: "Clústeres", tip: "Líneas de los clústeres de liquidación" },
  { id: "lev", label: "Apalancamiento", tip: "Escalera de liquidación (x5–x100)" },
  { id: "sessions", label: "PDH / PDL", tip: "Alto/Bajo del día anterior + sesión actual" },
  { id: "vp", label: "V. Profile", tip: "Perfil de volumen: POC + Área de Valor" },
  { id: "vwap", label: "VWAP", tip: "Precio medio ponderado por volumen" },
  { id: "ema", label: "EMAs", tip: "Medias móviles exponenciales" },
  { id: "st", label: "Supertrend", tip: "Línea ATR de tendencia" },
  { id: "cvdOv", label: "CVD sobre precio", tip: "Delta acumulado superpuesto (divergencias)" },
  { id: "voids", label: "Huecos", tip: "Huecos de liquidez (bandas frías)" },
];
const LAYER_DOT: Record<LayerId, string> = {
  clusters: "bg-short-400", lev: "bg-flare-400", sessions: "bg-long-400", ema: "bg-long-300",
  st: "bg-long-400", cvdOv: "bg-flare-300", voids: "bg-flare-400", vwap: "bg-mist-200", vp: "bg-mist-400",
};

const LEVS = [5, 10, 20, 50, 100];
const LEV_ALPHA: Record<number, number> = { 5: 0.34, 10: 0.38, 20: 0.44, 50: 0.55, 100: 0.68 };

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
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

const CAN_FILTER = (() => {
  try {
    const c = document.createElement("canvas").getContext("2d");
    return !!c && "filter" in c;
  } catch {
    return false;
  }
})();

function loadZoom(tf: string): number {
  const m = readLS<Record<string, number>>(ZOOM_KEY, {});
  const v = m[tf];
  return Number.isFinite(v) ? Math.max(MIN_VIS, Math.min(CANDLE_COUNT, Math.round(v))) : DEFAULT_VIS;
}
function loadLayers(): Layers {
  const out = { ...DEFAULT_LAYERS };
  const p = readLS<Partial<Layers>>(LAYER_KEY, {});
  for (const k of Object.keys(out) as LayerId[]) if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
  return out;
}
function loadLevOn(): Record<number, boolean> {
  const d: Record<number, boolean> = { 5: false, 10: true, 20: true, 50: true, 100: true };
  const p = readLS<Record<string, boolean>>(LEV_KEY, {});
  for (const lv of LEVS) if (typeof p[String(lv)] === "boolean") d[lv] = p[String(lv)];
  return d;
}
function loadHeatInt(): number {
  const v = readLS<number>(HEAT_KEY, 1.05);
  return Number.isFinite(v) ? Math.max(0.4, Math.min(2.2, v)) : 1.05;
}

function ToolGroup({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="group/tool flex shrink-0 flex-col gap-1" title={title}>
      <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.18em] text-mist-600 transition-colors duration-200 group-hover/tool:text-mist-400">{label}</span>
      <div className="flex items-stretch border border-ink-700 bg-ink-850/80 transition-colors duration-200 group-hover/tool:border-ink-600">{children}</div>
    </div>
  );
}
function ToolDivider() {
  return <span className="h-8 w-px shrink-0 self-center bg-ink-700/60" />;
}

function candleRemainStr(tfMin: number, now: number): string {
  const stepMs = tfMin * 60_000;
  let start: number;
  if (tfMin >= 10080) {
    const d = new Date(now);
    const day = (d.getUTCDay() + 6) % 7;
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  } else {
    start = Math.floor(now / stepMs) * stepMs;
  }
  const s = Math.max(0, Math.floor((start + stepMs - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (x: number) => String(x).padStart(2, "0");
  return tfMin >= 1440 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
function NextCandleChip({ tfMin }: { tfMin: number }) {
  const [str, setStr] = useState(() => candleRemainStr(tfMin, Date.now()));
  useEffect(() => {
    const id = window.setInterval(() => setStr(candleRemainStr(tfMin, Date.now())), 1000);
    return () => window.clearInterval(id);
  }, [tfMin]);
  return <span className="tick-num px-2.5 py-1 font-mono text-[10px] font-bold text-mist-300">{str}</span>;
}

function LayersMenu({ layers, onToggle, open, setOpen }: {
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
          open ? "border-long-500/50 bg-long-900/40 text-long-300" : "border-ink-700 bg-ink-850/80 text-mist-400 hover:border-ink-600 hover:text-mist-200"
        }`}
        title="Mostrar u ocultar las capas del gráfico"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Capas <span className={`tick-num ${activeCount === ids.length ? "text-long-300" : "text-flare-300"}`}>{activeCount}/{ids.length}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="anim-feed-in absolute right-0 top-full z-40 mt-2 w-60 border border-ink-600 bg-ink-900/95 py-1 shadow-2xl backdrop-blur-md">
          <div className="px-3 py-1.5 font-mono text-[8px] font-bold uppercase tracking-[0.2em] text-mist-600">Capas del gráfico</div>
          {LAYER_META.map((l) => (
            <button key={l.id} onClick={() => onToggle(l.id)} className="group flex w-full items-center gap-2.5 px-3 py-[7px] text-left transition-colors hover:bg-ink-750/70" title={l.tip}>
              <span className={`h-2 w-2 shrink-0 rounded-full transition-all ${layers[l.id] ? LAYER_DOT[l.id] : "bg-ink-600"}`} />
              <span className={`flex-1 font-mono text-[10.5px] font-medium transition-colors ${layers[l.id] ? "text-mist-200" : "text-mist-600"}`}>{l.label}</span>
              <span className={`relative h-[14px] w-[26px] rounded-full transition-colors ${layers[l.id] ? "bg-long-500/60" : "bg-ink-700"}`}>
                <span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-mist-100 transition-all ${layers[l.id] ? "left-[14px]" : "left-[2px]"}`} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Hover { x: number; y: number; idx: number; price: number; heat: number; }

const plotBottomOf = (chartH: number, oscOpen: boolean) => chartH - TIME_H - (oscOpen ? SUB_H : 0) - 12;

const REGIME_TONE: Record<string, string> = {
  long: "border-long-500/50 bg-long-900/40 text-long-300",
  short: "border-short-500/50 bg-short-900/40 text-short-300",
  warn: "border-flare-400/50 bg-flare-400/10 text-flare-300",
  flat: "border-ink-600 bg-ink-800 text-mist-400",
};

export default function HeatmapChart({ state, tfKey, setTfKey, timeframes, realCvd, ind, cfg, confluence, market = "perp" }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);

  const [width, setWidth] = useState(900);
  const [chartH, setChartH] = useState(H);
  const [hover, setHover] = useState<Hover | null>(null);
  const [osc, setOsc] = useState<Osc>("cvd");
  const [oscOpen, setOscOpen] = useState(true);
  const [visibleCount, setVisibleCount] = useState(() => loadZoom(tfKey));
  const [offset, setOffset] = useState(0);
  const [priceOff, setPriceOff] = useState(0);
  const [levOn, setLevOn] = useState<Record<number, boolean>>(loadLevOn);
  const [layers, setLayers] = useState<Layers>(loadLayers);
  const [layersOpen, setLayersOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [heatInt, setHeatInt] = useState<number>(loadHeatInt);
  const [logScale, setLogScale] = useState<boolean>(() => readFlag(LOG_KEY));
  const [liqView, setLiqView] = useState<boolean>(() => readFlag(LIQVIEW_KEY));
  const [grabbing, setGrabbing] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);

  const meta = state.meta;
  const tfMin = timeframes.find((t) => t.key === tfKey)?.minutes ?? 5;
  const dragging = useRef<{ startX: number; startY: number; startOff: number; startPrice: number; span: number } | null>(null);

  // persistencia
  useEffect(() => { setVisibleCount(loadZoom(tfKey)); setOffset(0); setPriceOff(0); }, [tfKey]);
  useEffect(() => {
    const m = readLS<Record<string, number>>(ZOOM_KEY, {});
    m[tfKey] = visibleCount;
    writeLS(ZOOM_KEY, m);
  }, [visibleCount, tfKey]);
  useEffect(() => { writeLS(LEV_KEY, levOn); }, [levOn]);
  useEffect(() => { writeLS(LAYER_KEY, layers); }, [layers]);
  useEffect(() => { writeFlag(LOG_KEY, logScale); }, [logScale]);
  useEffect(() => { writeLS(HEAT_KEY, heatInt); }, [heatInt]);
  useEffect(() => { writeFlag(LIQVIEW_KEY, liqView); }, [liqView]);

  // medición del contenedor
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      const h = fullscreen ? Math.max(220, el.clientHeight) : H;
      setChartH((prev) => (prev === h ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [fullscreen]);

  // ESC cierra pantalla completa
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [fullscreen]);

  // ventana visible [start, end) con offset desde la derecha
  const view = useMemo(() => {
    const end = CANDLE_COUNT - offset;
    const start = Math.max(0, end - visibleCount);
    let yMin = Infinity, yMax = -Infinity;
    for (let i = start; i < end; i++) {
      yMin = Math.min(yMin, state.candles[i].l);
      yMax = Math.max(yMax, state.candles[i].h);
    }
    const pad = (yMax - yMin) * 0.06 || 1;
    let lo = yMin - pad, hi = yMax + pad;
    if (liqView) {
      // expandir para incluir clusters + escalera activa
      const lastC = state.candles[CANDLE_COUNT - 1].c;
      let liqLo = lastC, liqHi = lastC;
      for (const c of state.clusters) {
        liqLo = Math.min(liqLo, c.price);
        liqHi = Math.max(liqHi, c.price);
      }
      const maxLev = LEVS.filter((l) => levOn[l]).reduce((m, l) => Math.max(m, l), 0);
      if (maxLev > 0) {
        liqLo = Math.min(liqLo, lastC * (1 - 1 / maxLev));
        liqHi = Math.max(liqHi, lastC * (1 + 1 / maxLev));
      }
      const extra = (hi - lo) * 0.25;
      lo = Math.min(lo, liqLo - extra);
      hi = Math.max(hi, liqHi + extra);
    }
    // paneo vertical (fracción del span)
    const spanY = hi - lo;
    const shift = priceOff * spanY;
    return { start, end, yMin: lo + shift, yMax: hi + shift };
  }, [state.candles, state.clusters, visibleCount, offset, levOn, liqView, priceOff]);

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

  const zoomAt = (dir: number, anchor?: number) => {
    const next = Math.max(MIN_VIS, Math.min(CANDLE_COUNT, Math.round(visibleCount * (dir > 0 ? 1.25 : 0.8))));
    if (next === visibleCount) return;
    const frac = anchor ?? 1;
    const newStart = Math.max(0, Math.min(CANDLE_COUNT - next, view.start + Math.round((visibleCount - next) * frac)));
    setVisibleCount(next);
    setOffset(CANDLE_COUNT - next - newStart);
  };

  // rueda: zoom al cursor (Shift = paneo vertical)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        setPriceOff((p) => Math.max(-0.9, Math.min(0.9, p + (e.deltaY > 0 ? -0.06 : 0.06))));
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      zoomAt(e.deltaY > 0 ? 1 : -1, frac);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  // paneo con arrastre (horizontal = tiempo, vertical = precios)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const d = dragging.current;
      const plotW = width - SCALE_W;
      const cellW = plotW / visibleCount;
      const dCandles = Math.round((e.clientX - d.startX) / cellW);
      setOffset(Math.max(0, Math.min(CANDLE_COUNT - visibleCount, d.startOff + dCandles)));
      const plotH = plotBottomOf(chartH, oscOpen) - PAD_T;
      const dPrice = ((e.clientY - d.startY) / plotH) * d.span;
      setPriceOff(Math.max(-0.9, Math.min(0.9, d.startPrice + dPrice / (d.span || 1))));
    };
    const onUp = () => {
      dragging.current = null;
      document.body.style.cursor = "";
      setGrabbing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width, visibleCount, chartH, oscOpen]);

  const exportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const a = document.createElement("a");
      a.download = `liqradar_${meta.symbol}_${tfKey}_${Date.now()}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    } catch {
      /* sin exportación */
    }
  };

  // overlays derivados
  const sessions = useMemo(() => computeSessions(state.warm ?? state.candles, tfMin), [state.warm, state.candles, tfMin]);
  const liqVoids = useMemo(() => computeVoids(state.candles, state.heat, state.pMin, state.pMax, view.start), [state.candles, state.heat, state.pMin, state.pMax, view.start]);
  const vwap = useMemo(() => computeVwap(state.candles), [state.candles]);
  const volProfile = useMemo(() => computeVolProfile(state.candles, state.pMin, state.pMax, view.start), [state.candles, state.pMin, state.pMax, view.start]);

  // ================= DIBUJO BASE =================
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

    try {
      const { candles, heat, pMin, pMax, clusters, cvd } = state;
      const plotW = width - SCALE_W;
      const plotTop = PAD_T;
      const plotBottom = plotBottomOf(chartH, oscOpen);
      const plotH = plotBottom - plotTop;
      const subTop = plotBottom + 12;
      const subBottom = chartH - TIME_H - 4;
      const lastC = candles[CANDLE_COUNT - 1].c;
      const cellW = plotW / visibleCount;
      const y = (p: number) => scaleY(p, plotTop, plotH);
      const priceAt = (py: number) => scalePrice(py, plotTop, plotH);

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

      // render térmico
      let heatVisMax = 0;
      for (let i = view.start; i < view.end; i++)
        for (let b = 0; b < HEAT_BINS; b++) heatVisMax = Math.max(heatVisMax, heat[i * HEAT_BINS + b]);
      if (heatVisMax <= 0) heatVisMax = state.heatMax || 1;
      heatVisMax = heatVisMax / heatInt;

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
        const price = priceAt(plotTop + ((r + 0.5) / HEAT_ROWS) * plotH);
        const fb = ((price - pMin) / spanFull) * (HEAT_BINS - 1);
        const b0 = Math.max(0, Math.min(HEAT_BINS - 1, Math.floor(fb)));
        const b1 = Math.max(0, Math.min(HEAT_BINS - 1, Math.ceil(fb)));
        const frac = Math.max(0, Math.min(1, fb - b0));
        const stops = price < lastC ? LONG_STOPS : SHORT_STOPS;
        for (let c = 0; c < visibleCount; c++) {
          const i = view.start + c;
          const idx4 = (r * visibleCount + c) * 4;
          const v = heat[i * HEAT_BINS + b0] * (1 - frac) + heat[i * HEAT_BINS + b1] * frac;
          const t = Math.min(1, Math.pow(v / heatVisMax, 1.05));
          if (t < 0.02) { px[idx4 + 3] = 0; continue; }
          const [cr, cg, cb, ca] = sampleRamp(t, stops);
          px[idx4] = cr; px[idx4 + 1] = cg; px[idx4 + 2] = cb; px[idx4 + 3] = ca;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, 0, plotTop, plotW, plotH);
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

      // huecos de liquidez
      if (layers.voids) for (const vd of liqVoids) {
        const vy0 = y(vd.yMax), vy1 = y(vd.yMin);
        if (vy1 < plotTop || vy0 > plotBottom) continue;
        const top = Math.max(plotTop, vy0), bot = Math.min(plotBottom, vy1);
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

      // volume profile
      if (layers.vp && volProfile) {
        const span = pMax - pMin;
        if (span > 0) {
          const vol = volProfile.rows;
          let maxV = 0;
          for (let r = 0; r < vol.length; r++) maxV = Math.max(maxV, vol[r]);
          const maxBarW = plotW * 0.16;
          for (let r = 0; r < vol.length; r++) {
            if (vol[r] <= 0) continue;
            const pTop = pMin + (r + 1) * volProfile.rowH;
            const pBot = pMin + r * volProfile.rowH;
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

      // VWAP
      if (layers.vwap) {
        ctx.beginPath();
        let started = false;
        for (let i = view.start; i < view.end; i++) {
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
      }

      // clusters
      if (layers.clusters) for (const cl of clusters.slice(0, CHART_CLUSTER_LIMIT)) {
        const cy = y(cl.price);
        if (cy < plotTop || cy > plotBottom) continue;
        const col = cl.side === "long" ? "45,224,192" : "255,93,126";
        ctx.strokeStyle = `rgba(${col},0.16)`;
        ctx.lineWidth = 4;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(plotW, cy); ctx.stroke();
        ctx.strokeStyle = `rgba(${col},0.9)`;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(plotW, cy); ctx.stroke();
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

      // escalera de apalancamiento
      if (layers.lev) {
        const rightX = plotW - 128;
        const placed: { y: number }[] = [];
        const items: { price: number; col: string; tag: string }[] = [];
        for (const lev of LEVS) {
          if (!levOn[lev]) continue;
          const pctDist = 100 / lev;
          items.push({ price: lastC * (1 - 1 / lev), col: "45,224,192", tag: `x${lev} ${pctDist < 10 ? pctDist.toFixed(1) : pctDist.toFixed(0)}% L` });
          items.push({ price: lastC * (1 + 1 / lev), col: "255,93,126", tag: `x${lev} ${pctDist < 10 ? pctDist.toFixed(1) : pctDist.toFixed(0)}% S` });
        }
        items.sort((a, b) => b.price - a.price);
        for (const it of items) {
          const ly = y(it.price);
          if (ly < plotTop + 3 || ly > plotBottom - 3) continue;
          const alpha = LEV_ALPHA[Number(it.tag.match(/x(\d+)/)?.[1] ?? 20)] ?? 0.4;
          ctx.strokeStyle = `rgba(${it.col},${alpha})`;
          ctx.lineWidth = 1.1;
          ctx.setLineDash([2, 4]);
          ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          let ey = ly;
          for (const p of placed) if (Math.abs(ey - p.y) < 15) ey = p.y + 15;
          if (ey > plotBottom - 8) ey = plotBottom - 8;
          placed.push({ y: ey });
          ctx.font = "600 9px 'IBM Plex Mono', monospace";
          const tw = ctx.measureText(it.tag).width;
          if (Math.abs(ey - ly) > 2) {
            ctx.strokeStyle = `rgba(${it.col},0.35)`;
            ctx.beginPath(); ctx.moveTo(rightX + tw + 14, ey); ctx.lineTo(plotW - 4, ly); ctx.stroke();
          }
          ctx.fillStyle = "rgba(7,12,22,0.92)";
          ctx.fillRect(rightX, ey - 8, tw + 14, 15);
          ctx.strokeStyle = `rgba(${it.col},${Math.min(1, alpha + 0.2)})`;
          ctx.strokeRect(rightX + 0.5, ey - 7.5, tw + 13, 14);
          ctx.fillStyle = `rgba(${it.col},${Math.min(1, alpha + 0.25)})`;
          ctx.textAlign = "left";
          ctx.fillText(it.tag, rightX + 7, ey + 0.5);
          ctx.font = "10px 'IBM Plex Mono', monospace";
        }
      }

      // sesiones PDH/PDL
      if (layers.sessions) {
        const drawSess = (price: number, col: string, label: string, dash?: number[]) => {
          if (!Number.isFinite(price)) return;
          const ly = y(price);
          if (ly < plotTop + 4 || ly > plotBottom - 4) return;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.1;
          ctx.setLineDash(dash ?? []);
          ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke();
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
      }

      // velas
      for (let i = view.start; i < view.end; i++) {
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

      // Supertrend
      if (layers.st) {
        ctx.lineWidth = 1.6;
        for (let i = view.start + 1; i < view.end; i++) {
          const px0 = (i - 1 - view.start) * cellW + cellW / 2;
          const px1 = (i - view.start) * cellW + cellW / 2;
          ctx.strokeStyle = ind.stUp[i] ? "rgba(45,224,192,0.85)" : "rgba(255,93,126,0.85)";
          ctx.beginPath();
          ctx.moveTo(px0, y(ind.st[i - 1]));
          ctx.lineTo(px1, y(ind.st[i]));
          ctx.stroke();
        }
        ctx.lineWidth = 1;
        for (let i = Math.max(1, view.start); i < view.end; i++) {
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

      // EMAs + CVD overlay
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, plotTop, plotW, plotH);
      ctx.clip();
      if (layers.ema) {
        const drawEma = (arr: number[], col: string, w: number, dash?: number[]) => {
          ctx.beginPath();
          ctx.setLineDash(dash ?? []);
          for (let i = view.start; i < view.end; i++) {
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
      if (layers.cvdOv) {
        let cMin = Infinity, cMax = -Infinity;
        for (let i = view.start; i < view.end; i++) {
          cMin = Math.min(cMin, cvd[i]);
          cMax = Math.max(cMax, cvd[i]);
        }
        const cSpan = cMax - cMin || 1;
        const cyv = (v: number) => plotTop + ((cMax - v) / cSpan) * plotH;
        ctx.beginPath();
        for (let i = view.start; i < view.end; i++) {
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

      // eje temporal
      ctx.fillStyle = "#48597a";
      ctx.textAlign = "center";
      const step = Math.max(1, Math.round(visibleCount / 5));
      for (let i = view.start; i < view.end; i += step) {
        ctx.fillText(fmtAxisTime(candles[i].t, tfMin), (i - view.start) * cellW + cellW / 2, chartH - TIME_H / 2 - 4);
      }

      // ================= OSCILADOR =================
      if (oscOpen) {
        ctx.strokeStyle = "rgba(37,54,80,0.55)";
        ctx.beginPath();
        ctx.moveTo(0, subTop - 6);
        ctx.lineTo(width, subTop - 6);
        ctx.stroke();
        const slice = (arr: number[]) => arr.slice(view.start, view.end);
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
          ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(plotW, zeroY); ctx.stroke();
          ctx.setLineDash([]);
          const cvdUp = cv[cv.length - 1] >= 0;
          const grad = ctx.createLinearGradient(0, subTop, 0, subBottom);
          grad.addColorStop(0, cvdUp ? "rgba(45,224,192,0.30)" : "rgba(255,93,126,0.30)");
          grad.addColorStop(1, cvdUp ? "rgba(45,224,192,0.02)" : "rgba(255,93,126,0.02)");
          ctx.beginPath();
          ctx.moveTo(0, subBottom);
          for (let i = 0; i < cv.length; i++) ctx.lineTo(pxOf(i), cy2(cv[i]));
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
          ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(plotW, zeroY); ctx.stroke();
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
            ctx.beginPath(); ctx.moveTo(0, ry(lvl)); ctx.lineTo(plotW, ry(lvl)); ctx.stroke();
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
          ctx.beginPath(); ctx.moveTo(0, ay(thr)); ctx.lineTo(plotW, ay(thr)); ctx.stroke();
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
          const vS = candles.slice(view.start, view.end).map((k) => k.v);
          const dS = candles.slice(view.start, view.end).map((k) => k.delta);
          let mx = 1e-9;
          for (const v of vS) mx = Math.max(mx, v);
          for (let i = 0; i < vS.length; i++) {
            const hh = (vS[i] / mx) * (subBottom - subTop - 6);
            ctx.fillStyle = dS[i] >= 0 ? "rgba(45,224,192,0.5)" : "rgba(255,93,126,0.5)";
            ctx.fillRect(pxOf(i) - cellW * 0.32, subBottom - hh, cellW * 0.64, hh);
          }
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
      }
    } catch (err) {
      console.error("[HeatmapChart] error de dibujo:", err);
      setDrawError(err instanceof Error ? err.message : String(err));
    }
  }, [state, width, chartH, ind, cfg, osc, tfMin, view, visibleCount, levOn, realCvd, logScale, layers, liqVoids, sessions, vwap, volProfile, meta, heatInt, oscOpen, scaleY, scalePrice]);

  // ================= CROSSHAIR (canvas superior, barato) =================
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = chartH * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, chartH);
    const plotW = width - SCALE_W;
    if (!hover || hover.x >= plotW || dragging.current) return;
    const plotBottom = plotBottomOf(chartH, oscOpen);
    const subBottom = chartH - TIME_H - 4;
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(183,199,226,0.4)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hover.x, PAD_T); ctx.lineTo(hover.x, oscOpen ? subBottom : plotBottom);
    ctx.moveTo(0, hover.y); ctx.lineTo(plotW, hover.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (hover.y >= PAD_T && hover.y <= plotBottom) {
      ctx.fillStyle = "#131e33";
      ctx.fillRect(plotW, hover.y - 9, SCALE_W, 18);
      ctx.strokeStyle = "rgba(143,163,196,0.6)";
      ctx.strokeRect(plotW + 0.5, hover.y - 8.5, SCALE_W - 1, 17);
      ctx.fillStyle = "#dbe6f7";
      ctx.textAlign = "left";
      ctx.fillText(fmtPrice(hover.price, meta.decimals), plotW + 8, hover.y + 0.5);
    }
  }, [hover, width, chartH, oscOpen, meta.decimals]);

  // ================= MINIMAPA =================
  useEffect(() => {
    const canvas = miniRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = MINIMAP_H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, MINIMAP_H);
    let lo = Infinity, hi = -Infinity;
    for (const k of state.candles) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
    const span = hi - lo || 1;
    const bw = width / CANDLE_COUNT;
    for (let i = 0; i < CANDLE_COUNT; i++) {
      const k = state.candles[i];
      const up = k.c >= k.o;
      const y0 = 4 + ((hi - k.h) / span) * (MINIMAP_H - 8);
      const y1 = 4 + ((hi - k.l) / span) * (MINIMAP_H - 8);
      ctx.fillStyle = up ? "rgba(45,224,192,0.5)" : "rgba(255,93,126,0.5)";
      ctx.fillRect(i * bw, y0, Math.max(1, bw - 1), Math.max(1, y1 - y0));
    }
    const x0 = view.start * bw, x1 = view.end * bw;
    ctx.fillStyle = "rgba(7,12,22,0.55)";
    ctx.fillRect(0, 0, x0, MINIMAP_H);
    ctx.fillRect(x1, 0, width - x1, MINIMAP_H);
    ctx.strokeStyle = "rgba(255,178,36,0.8)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, MINIMAP_H - 1);
  }, [state.candles, view.start, view.end, width]);

  const jumpMinimap = (clientX: number, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const center = Math.round(frac * CANDLE_COUNT);
    const newStart = Math.max(0, Math.min(CANDLE_COUNT - visibleCount, center - Math.floor(visibleCount / 2)));
    setOffset(CANDLE_COUNT - visibleCount - newStart);
  };

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragging.current) { setHover(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yy = e.clientY - rect.top;
    const plotW = width - SCALE_W;
    const plotBottom = plotBottomOf(chartH, oscOpen);
    const vIdx = Math.min(visibleCount - 1, Math.max(0, Math.floor((x / plotW) * visibleCount)));
    const idx = view.start + vIdx;
    const price = scalePrice(yy, PAD_T, plotBottom - PAD_T);
    const bin = Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((price - state.pMin) / (state.pMax - state.pMin)) * (HEAT_BINS - 1))));
    let heatVisMax = 0;
    for (let i = view.start; i < view.end; i++)
      for (let b = 0; b < HEAT_BINS; b++) heatVisMax = Math.max(heatVisMax, state.heat[i * HEAT_BINS + b]);
    if (heatVisMax <= 0) heatVisMax = state.heatMax || 1;
    const heat = state.heat[idx * HEAT_BINS + bin] / (heatVisMax / heatInt);
    setHover({ x, y: yy, idx, price, heat });
  };

  const k = hover ? state.candles[hover.idx] : null;
  const cons = ind.consensus;
  const mtf = mtfAdjust(cons, confluence);
  const regime = computeLiqRegime(state.funding, state.oiDelta1h);
  const lastStUp = ind.stUpConf[ind.stUpConf.length - 1];
  const zoomed = visibleCount < CANDLE_COUNT || offset > 0;

  const TREND_META: Record<TrendDir, { label: string; c: string; bar: string }> = {
    alcista: { label: "Alcista", c: "border-long-500/50 bg-long-900/40 text-long-300", bar: "#2de0c0" },
    bajista: { label: "Bajista", c: "border-short-500/50 bg-short-900/40 text-short-300", bar: "#ff5d7e" },
    lateral: { label: "Lateral", c: "border-flare-400/50 bg-flare-400/10 text-flare-300", bar: "#ffb224" },
  };
  const tm = TREND_META[cons.dir];

  const sectionEl = (
    <section
      className={`panel panel-corner ${fullscreen ? "flex flex-col overflow-hidden rounded-none border-0" : "anim-reveal"}`}
      style={fullscreen
        ? { position: "fixed", inset: 0, zIndex: 60, width: "100vw", height: "100vh", transform: "none", animationDelay: "0.05s" }
        : { animationDelay: "0.05s" }}
    >
      {/* cabecera */}
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
              <b className="text-mist-300">{meta.symbol}</b> · {market === "perp" ? "perp" : "spot"} · energía por nivel
            </p>
          </div>
        </div>

        <span className={`flex items-center gap-2 border px-2.5 py-1.5 ${tm.c}`}
          title={mtf.total != null ? `Consenso 5 indicadores · MTF ${mtf.agree}/${mtf.total}` : "Consenso 5 indicadores"}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            {cons.dir === "alcista" ? <path d="M12 4 L21 18 H3 Z" /> : cons.dir === "bajista" ? <path d="M12 20 L3 6 H21 Z" /> : <path d="M4 11 H20 V13 H4 Z" />}
          </svg>
          <span className="font-mono text-[9.5px] font-bold uppercase tracking-widest">{tm.label}</span>
          <span className="h-1 w-12 overflow-hidden bg-ink-700/80">
            <span className="block h-full transition-all duration-700" style={{ width: `${Math.round(mtf.strength * 100)}%`, background: tm.bar }} />
          </span>
          <span className="tick-num font-mono text-[9.5px] font-bold">{Math.round(mtf.strength * 100)}%</span>
        </span>

        <span className={`hidden items-center gap-1.5 border px-2 py-1.5 lg:flex ${REGIME_TONE[regime.tone]}`} title={regime.note}>
          <span className="font-mono text-[8.5px] font-bold uppercase tracking-widest">{regime.label}</span>
        </span>

        <div className="ml-auto flex items-center gap-2">
          <LayersMenu layers={layers} onToggle={(id) => setLayers((p) => ({ ...p, [id]: !p[id] }))} open={layersOpen} setOpen={setLayersOpen} />
          <button onClick={exportPng} className="flex items-center gap-1.5 border border-ink-700 bg-ink-850/80 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-mist-400 transition-all hover:border-long-500/40 hover:text-long-300" title="Descargar el gráfico como PNG">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            PNG
          </button>
          <button onClick={() => setFullscreen((f) => !f)}
            className={`flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest transition-all ${fullscreen ? "border-short-500/50 bg-short-900/50 text-short-300 hover:bg-short-900/80" : "border-long-500/40 bg-long-900/30 text-long-300 hover:bg-long-900/60"}`}
            title={fullscreen ? "Salir de pantalla completa (ESC)" : "Ver en pantalla completa"}>
            {fullscreen ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            )}
            {fullscreen ? "Salir" : "Ampliar"}
          </button>
        </div>
      </header>

      {/* barra de herramientas */}
      <div className="scroll-slim flex items-center gap-x-4 gap-y-2 overflow-x-auto border-b border-ink-700/50 bg-ink-900/60 px-4 py-2">
        <ToolGroup label="Temporalidad">
          {timeframes.map((t) => (
            <button key={t.key} onClick={() => setTfKey(t.key)}
              className={`px-2 py-1 font-mono text-[10px] font-semibold transition-colors ${t.key === tfKey ? "bg-long-500/20 text-long-300" : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"}`}>
              {t.key}
            </button>
          ))}
        </ToolGroup>
        <ToolDivider />
        <ToolGroup label="Zoom" title="Rueda = zoom al cursor · doble clic = restablecer">
          <button onClick={() => zoomAt(1)} className="px-2 font-mono text-[12px] font-bold text-mist-400 hover:bg-ink-750 hover:text-mist-100" title="Alejar">−</button>
          <button onClick={() => { setVisibleCount(DEFAULT_VIS); setOffset(0); setPriceOff(0); }}
            className={`tick-num border-x border-ink-700 px-2 py-1 font-mono text-[10px] font-semibold hover:bg-ink-750 ${zoomed ? "text-flare-300" : "text-mist-400"}`}
            title="Restablecer">×{(CANDLE_COUNT / visibleCount).toFixed(1)}</button>
          <button onClick={() => zoomAt(-1)} className="px-2 font-mono text-[12px] font-bold text-mist-400 hover:bg-ink-750 hover:text-mist-100" title="Acercar">+</button>
        </ToolGroup>
        <ToolGroup label="Escala" title="Escala del eje de precios (log útil en 1D/1W)">
          {(["lin", "log"] as const).map((s) => (
            <button key={s} onClick={() => setLogScale(s === "log")}
              className={`px-2 py-1 font-mono text-[10px] font-semibold uppercase transition-colors ${(s === "log") === logScale ? "bg-mist-200/15 text-mist-100" : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"}`}>
              {s}
            </button>
          ))}
        </ToolGroup>
        <ToolGroup label="Liquidez" title="Expandir el rango vertical para ver los clusters y la escalera por debajo/encima del precio">
          <button onClick={() => setLiqView((v) => !v)}
            className={`px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide transition-all ${liqView ? "bg-flare-400/15 text-flare-300 shadow-[inset_0_-2px_0_rgba(255,178,36,0.55)]" : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"}`}>
            {liqView ? "ON" : "OFF"}
          </button>
        </ToolGroup>
        <ToolGroup label="Calor" title="Intensidad del mapa de calor">
          <button onClick={() => setHeatInt((v) => Math.max(0.4, +(v - 0.15).toFixed(2)))} className="px-2 font-mono text-[12px] font-bold text-mist-400 hover:bg-ink-750 hover:text-mist-100">−</button>
          <span className="tick-num border-x border-ink-700 px-2 py-1 font-mono text-[10px] font-semibold text-mist-400">{heatInt.toFixed(2)}</span>
          <button onClick={() => setHeatInt((v) => Math.min(2.2, +(v + 0.15).toFixed(2)))} className="px-2 font-mono text-[12px] font-bold text-mist-400 hover:bg-ink-750 hover:text-mist-100">+</button>
        </ToolGroup>
        <ToolGroup label="Oscilador">
          {(["cvd", "macd", "rsi", "adx", "vol"] as Osc[]).map((o) => (
            <button key={o} onClick={() => { setOsc(o); setOscOpen(true); }}
              className={`px-2.5 py-1 font-mono text-[10px] font-semibold uppercase transition-colors ${osc === o && oscOpen ? "bg-flare-400/15 text-flare-300" : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"}`}>
              {o}
            </button>
          ))}
          <button onClick={() => setOscOpen((v) => !v)}
            className={`border-l border-ink-700 px-2 py-1 font-mono text-[10px] font-bold transition-colors ${oscOpen ? "text-flare-300" : "text-mist-500 hover:text-mist-300"}`}
            title={oscOpen ? "Ocultar oscilador (más espacio para el precio)" : "Mostrar oscilador"}>
            {oscOpen ? "▾" : "▸"}
          </button>
        </ToolGroup>
        <ToolGroup label="Apalancamiento" title="Líneas de liquidación: distancia ≈ 1/apalancamiento desde el precio">
          {LEVS.map((lv) => (
            <button key={lv} onClick={() => setLevOn((p) => ({ ...p, [lv]: !p[lv] }))}
              className={`px-2 py-1 font-mono text-[10px] font-semibold transition-all duration-150 ${levOn[lv] ? "bg-flare-400/15 text-flare-300 shadow-[inset_0_-2px_0_rgba(255,178,36,0.55)]" : "text-mist-600 hover:bg-ink-750 hover:text-mist-400"}`}>
              {lv}×
            </button>
          ))}
        </ToolGroup>
        <ToolGroup label="Próxima vela">
          <NextCandleChip tfMin={tfMin} />
        </ToolGroup>
      </div>

      {/* área del gráfico */}
      <div ref={wrapRef} className={fullscreen ? "relative min-h-0 flex-1" : "relative"}>
        {drawError && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/85 p-6">
            <div className="max-w-md border border-short-500/60 bg-ink-900 p-4">
              <div className="font-display text-xs font-bold uppercase tracking-[0.18em] text-short-300">Error al dibujar el heatmap</div>
              <p className="mt-2 font-mono text-[10px] leading-relaxed text-mist-400">{drawError}</p>
              <button onClick={() => { setDrawError(null); setVisibleCount(DEFAULT_VIS); setOffset(0); setPriceOff(0); }}
                className="mt-3 border border-long-500/50 bg-long-900/40 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-long-300 hover:bg-long-900/70">
                Reintentar
              </button>
            </div>
          </div>
        )}

        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: fullscreen ? "100%" : chartH, display: "block", cursor: grabbing ? "grabbing" : offset > 0 || priceOff !== 0 || visibleCount < CANDLE_COUNT ? "grab" : "crosshair", touchAction: "none" }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onMouseDown={(e) => {
            dragging.current = { startX: e.clientX, startY: e.clientY, startOff: offset, startPrice: priceOff, span: view.yMax - view.yMin };
            document.body.style.cursor = "grabbing";
            setGrabbing(true);
          }}
          onDoubleClick={() => { setVisibleCount(DEFAULT_VIS); setOffset(0); setPriceOff(0); }}
        />
        <canvas ref={overlayRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />

        {(offset > 0 || priceOff !== 0) && (
          <button onClick={() => { setOffset(0); setPriceOff(0); }}
            className="anim-feed-in absolute right-24 top-2 z-20 flex items-center gap-1.5 border border-flare-400/50 bg-ink-900/90 px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-flare-300 transition-all hover:bg-flare-400/20"
            title="Volver al presente y recentrar el eje de precios">
            ⟶ Al presente{priceOff !== 0 ? " · centrar" : ""}
          </button>
        )}

        {/* leyenda OHLC en vivo */}
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border border-ink-700/70 bg-ink-900/80 px-2.5 py-1.5 font-mono text-[9px] text-mist-500 backdrop-blur-[2px]">
          <span>O <b className="tick-num text-mist-200">{k ? fmtPrice(k.o, meta.decimals) : "—"}</b></span>
          <span>H <b className="tick-num text-long-300">{k ? fmtPrice(k.h, meta.decimals) : "—"}</b></span>
          <span>L <b className="tick-num text-short-300">{k ? fmtPrice(k.l, meta.decimals) : "—"}</b></span>
          <span>C <b className="tick-num text-mist-200">{k ? fmtPrice(k.c, meta.decimals) : "—"}</b></span>
          <span className="ml-2">Calor <b className={hover && hover.heat > 0.5 ? "text-flare-300" : "text-mist-300"}>{hover ? (hover.heat * 100).toFixed(0) : 0}%</b></span>
        </div>

        {/* tooltip detallado */}
        {hover && k && !dragging.current && (
          <div className="pointer-events-none absolute z-20 border border-ink-600 bg-ink-900/95 px-3 py-2 font-mono text-[10px] shadow-xl"
            style={{ left: Math.min(hover.x + 16, width - 230), top: Math.min(hover.y + 14, chartH - 190) }}>
            <div className="mb-1 text-[9px] uppercase tracking-widest text-mist-500">
              {tfMin >= 1440 ? new Date(k.t).toUTCString().slice(5, 16) : fmtHM(k.t)} UTC
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-mist-300">
              <span className="text-mist-600">O</span><span className="tick-num text-right">{fmtPrice(k.o, meta.decimals)}</span>
              <span className="text-mist-600">H</span><span className="tick-num text-right text-long-300">{fmtPrice(k.h, meta.decimals)}</span>
              <span className="text-mist-600">L</span><span className="tick-num text-right text-short-300">{fmtPrice(k.l, meta.decimals)}</span>
              <span className="text-mist-600">C</span><span className="tick-num text-right">{fmtPrice(k.c, meta.decimals)}</span>
              <span className="text-mist-600">Calor</span><span className={`tick-num text-right ${hover.heat > 0.5 ? "text-flare-300" : "text-mist-400"}`}>{(hover.heat * 100).toFixed(0)}%</span>
              <span className="text-mist-600">EMA {cfg.fast}</span><span className="tick-num text-right text-long-300">{fmtPrice(ind.emaFast[hover.idx], meta.decimals)}</span>
              <span className="text-mist-600">EMA {cfg.slow}</span><span className="tick-num text-right text-flare-300">{fmtPrice(ind.emaSlow[hover.idx], meta.decimals)}</span>
              <span className="text-mist-600">Supertrend</span>
              <span className={`tick-num text-right ${ind.stUp[hover.idx] ? "text-long-300" : "text-short-300"}`}>
                {fmtPrice(ind.st[hover.idx], meta.decimals)} {ind.stUp[hover.idx] ? "▲" : "▼"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* minimapa */}
      <div className="border-t border-ink-700/50 bg-ink-900/70" title="Minimapa: haz clic o arrastra para desplazarte por el historial">
        <canvas
          ref={miniRef}
          style={{ width: "100%", height: MINIMAP_H, display: "block", cursor: "ew-resize", touchAction: "none" }}
          onMouseDown={(e) => {
            jumpMinimap(e.clientX, e.currentTarget);
            const el = e.currentTarget;
            const onMv = (ev: MouseEvent) => jumpMinimap(ev.clientX, el);
            const onUp = () => {
              window.removeEventListener("mousemove", onMv);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMv);
            window.addEventListener("mouseup", onUp);
          }}
        />
      </div>

      {/* barra de estado */}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-700/50 bg-ink-900/70 px-5 py-2.5 font-mono text-[9px] uppercase tracking-wider text-mist-600">
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-long-400" />Liq 24h L</span>
          <b className="tick-num text-[11px] font-bold tracking-normal text-long-300">{fmtUsd(state.totalLiq24hLong)}</b>
        </span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-short-400" />Liq 24h S</span>
          <b className="tick-num text-[11px] font-bold tracking-normal text-short-300">{fmtUsd(state.totalLiq24hShort)}</b>
        </span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span>OI <b className="tick-num tracking-normal text-mist-200">{fmtUsd(state.oi, 2)}</b>{" "}
          <span className={state.oiDelta1h >= 0 ? "text-long-300" : "text-short-300"}>{fmtPct(state.oiDelta1h, 2)} 1h</span></span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span>Funding <b className={`tick-num tracking-normal ${state.funding >= 0 ? "text-long-300" : "text-short-300"}`}>{fmtPct(state.funding, 4)}</b></span>
        <span className="h-3.5 w-px bg-ink-700" />
        <span>CVD <b className={`tick-num tracking-normal ${state.cvd[state.cvd.length - 1] >= 0 ? "text-long-300" : "text-short-300"}`}>{fmtCompact(state.cvd[state.cvd.length - 1])}</b></span>
        <span className="ml-auto hidden items-center gap-2 md:flex">
          <span className="border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-mist-400">{tfKey}</span>
          <span className="border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-mist-400">{logScale ? "LOG" : "LIN"}</span>
          <span className={`border px-1.5 py-0.5 ${zoomed ? "border-flare-400/40 text-flare-300" : "border-ink-700 bg-ink-850 text-mist-400"}`}>×{(CANDLE_COUNT / visibleCount).toFixed(1)}</span>
          <span className="text-mist-600">rueda = zoom · Shift+rueda/arrastrar ↕ = precios · doble clic = reset</span>
        </span>
      </footer>
    </section>
  );

  return fullscreen ? createPortal(sectionEl, document.body) : sectionEl;
}
