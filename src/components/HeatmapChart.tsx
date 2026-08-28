import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketState } from "../lib/market";
import { CANDLE_COUNT, HEAT_BINS } from "../lib/market";
import { computeIndicators, getIndicatorCfg } from "../lib/indicators";
import { fmtAxisTime, fmtCompact, fmtHM, fmtPct, fmtPrice, fmtUsd } from "../lib/format";

type Osc = "cvd" | "macd" | "rsi";

interface Props {
  state: MarketState;
  tfKey: string;
  setTfKey: (k: string) => void;
  timeframes: { key: string; minutes: number }[];
}

const H = 496;
const SCALE_W = 86;
const SUB_H = 84;
const TIME_H = 22;
const PAD_T = 16;

function buildRamp(kind: "long" | "short"): string[] {
  const out: string[] = [];
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const a = 0.045 + Math.pow(t, 1.12) * 0.85;
    if (kind === "long") {
      const hue = 168 - t * 118;
      out.push(`hsla(${hue}, 92%, ${42 + t * 32}%, ${a})`);
    } else {
      const hue = 350 + t * 38;
      out.push(`hsla(${hue}, 92%, ${44 + t * 30}%, ${a})`);
    }
  }
  return out;
}
const LONG_RAMP = buildRamp("long");
const SHORT_RAMP = buildRamp("short");

interface Hover { x: number; y: number; idx: number; price: number; heat: number; }

const TREND_META = {
  alcista: { label: "Tendencia alcista", c: "border-long-500/50 bg-long-900/40 text-long-300", bar: "#2de0c0" },
  bajista: { label: "Tendencia bajista", c: "border-short-500/50 bg-short-900/50 text-short-300", bar: "#ff5d7e" },
  lateral: { label: "Rango lateral", c: "border-ink-600 bg-ink-800/70 text-mist-400", bar: "#8fa3c4" },
} as const;

function TrendIcon({ dir }: { dir: keyof typeof TREND_META }) {
  if (dir === "alcista")
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M4 18 L14 8 M14 8 H7 M14 8 V15" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-8 12 12)" />
      </svg>
    );
  if (dir === "bajista")
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M4 6 L14 16 M14 16 H7 M14 16 V9" strokeLinecap="round" strokeLinejoin="round" transform="rotate(8 12 12)" />
      </svg>
    );
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
      <path d="M4 12 H20 M16 8 L20 12 L16 16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function HeatmapChart({ state, tfKey, setTfKey, timeframes }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<Hover | null>(null);
  const [osc, setOsc] = useState<Osc>("cvd");

  const cfg = getIndicatorCfg(tfKey);
  const tfMin = timeframes.find((t) => t.key === tfKey)?.minutes ?? 5;

  const ind = useMemo(
    () => computeIndicators(state.candles.map((k) => k.c), cfg, tfMin),
    [state.candles, cfg, tfMin]
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);

    const { candles, heat, heatMax, pMin, pMax, meta, cvd, clusters } = state;
    const plotW = width - SCALE_W;
    const plotTop = PAD_T;
    const plotBottom = H - TIME_H - SUB_H - 12;
    const plotH = plotBottom - plotTop;
    const lastC = candles[CANDLE_COUNT - 1].c;
    const y = (p: number) => plotTop + ((pMax - p) / (pMax - pMin)) * plotH;
    const cellW = plotW / CANDLE_COUNT;
    const cellH = plotH / HEAT_BINS;

    // tinte de fondo según la tendencia dominante
    const tint = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    if (ind.trend.dir === "alcista") {
      tint.addColorStop(0, "rgba(45,224,192,0)");
      tint.addColorStop(1, `rgba(45,224,192,${0.028 + ind.trend.strength * 0.03})`);
    } else if (ind.trend.dir === "bajista") {
      tint.addColorStop(0, `rgba(255,93,126,${0.028 + ind.trend.strength * 0.03})`);
      tint.addColorStop(1, "rgba(255,93,126,0)");
    }
    ctx.fillStyle = tint;
    ctx.fillRect(0, plotTop, plotW, plotH);

    // rejilla horizontal + escala de precios
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    for (let g = 0; g <= 6; g++) {
      const p = pMin + ((pMax - pMin) * g) / 6;
      const gy = y(p);
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

    // celdas de calor
    for (let i = 0; i < CANDLE_COUNT; i++) {
      for (let b = 0; b < HEAT_BINS; b++) {
        const raw = heat[i * HEAT_BINS + b] / heatMax;
        if (raw < 0.055) continue;
        const t = Math.min(1, Math.pow(raw, 1.25));
        const binPrice = pMin + ((b + 0.5) / HEAT_BINS) * (pMax - pMin);
        const ramp = binPrice < lastC ? LONG_RAMP : SHORT_RAMP;
        ctx.fillStyle = ramp[Math.round(t * 25)];
        ctx.fillRect(i * cellW, plotTop + (HEAT_BINS - 1 - b) * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // marcadores de clústeres
    for (const cl of clusters.slice(0, 6)) {
      const cy = y(cl.price);
      if (cy < plotTop || cy > plotBottom) continue;
      const col = cl.side === "long" ? "45,224,192" : "255,93,126";
      ctx.strokeStyle = `rgba(${col},0.28)`;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(plotW, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `${fmtUsd(cl.sizeUsd)} ${cl.side === "long" ? "LONG" : "SHORT"}`;
      ctx.fillStyle = "rgba(7,12,22,0.88)";
      ctx.fillRect(6, cy - 8, 96, 16);
      ctx.strokeStyle = `rgba(${col},0.55)`;
      ctx.strokeRect(6.5, cy - 7.5, 95, 15);
      ctx.fillStyle = `rgb(${col})`;
      ctx.textAlign = "left";
      ctx.fillText(label, 12, cy + 0.5);
    }

    // velas
    for (let i = 0; i < CANDLE_COUNT; i++) {
      const k = candles[i];
      const cx = i * cellW + cellW / 2;
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

    // ---- indicadores de tendencia (EMAs) ----
    const drawEma = (arr: number[], color: string, w: number, dash?: number[]) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, plotTop, plotW, plotH);
      ctx.clip();
      ctx.beginPath();
      ctx.setLineDash(dash ?? []);
      for (let i = 0; i < arr.length; i++) {
        const px = i * cellW + cellW / 2;
        const py = y(arr[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    };
    drawEma(ind.emaTrend, "rgba(143,163,196,0.75)", 1.2, [4, 4]);
    drawEma(ind.emaSlow, "#ffb224", 1.5);
    drawEma(ind.emaFast, "#7df0da", 1.5);

    // punto de cruce en la última lectura
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
    const step = tfMin >= 1440 ? 32 : 26;
    for (let i = 8; i < CANDLE_COUNT; i += step) {
      ctx.fillText(fmtAxisTime(candles[i].t, tfMin), i * cellW + cellW / 2, H - TIME_H / 2 - 4);
    }

    // --- sub-panel de oscilador (CVD / MACD / RSI) ---
    const subTop = plotBottom + 14;
    const subBottom = H - TIME_H - 4;
    ctx.strokeStyle = "rgba(37,54,80,0.55)";
    ctx.beginPath();
    ctx.moveTo(0, subTop - 7);
    ctx.lineTo(width, subTop - 7);
    ctx.stroke();

    const subMid = (subTop + subBottom) / 2;
    const subHalf = (subBottom - subTop) / 2 - 4;

    if (osc === "cvd") {
      let cMin = Infinity, cMax = -Infinity;
      for (const v of cvd) { cMin = Math.min(cMin, v); cMax = Math.max(cMax, v); }
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
      const cvdUp = cvd[cvd.length - 1] >= 0;
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
      for (let i = 0; i < cvd.length; i++) ctx.lineTo(i * cellW + cellW / 2, cy2(cvd[i]));
      ctx.lineTo(plotW, subBottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < cvd.length; i++) {
        const px = i * cellW + cellW / 2;
        if (i === 0) ctx.moveTo(px, cy2(cvd[i]));
        else ctx.lineTo(px, cy2(cvd[i]));
      }
      ctx.strokeStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = "#8fa3c4";
      ctx.textAlign = "left";
      ctx.fillText("CVD · delta acumulado", 8, subTop + 1);
      ctx.fillStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
      ctx.fillText(fmtCompact(cvd[cvd.length - 1]), 146, subTop + 1);
    } else if (osc === "macd") {
      let mMax = 1e-9;
      for (let i = 0; i < ind.hist.length; i++) {
        mMax = Math.max(mMax, Math.abs(ind.hist[i]), Math.abs(ind.macd[i]), Math.abs(ind.signal[i]));
      }
      const my = (v: number) => subMid - (v / mMax) * subHalf;
      // histograma
      for (let i = 0; i < ind.hist.length; i++) {
        const v = ind.hist[i];
        const px = i * cellW + cellW / 2;
        ctx.fillStyle = v >= 0 ? "rgba(45,224,192,0.45)" : "rgba(255,93,126,0.45)";
        const y0 = my(0), y1 = my(v);
        ctx.fillRect(px - Math.max(1, cellW * 0.28), Math.min(y0, y1), Math.max(1.4, cellW * 0.56), Math.abs(y1 - y0) || 1);
      }
      // líneas macd y señal
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
      line(ind.macd, "#2de0c0");
      line(ind.signal, "#ffb224");
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
      const hv = ind.hist[ind.hist.length - 1];
      ctx.fillStyle = hv >= 0 ? "#2de0c0" : "#ff5d7e";
      ctx.fillText(`hist ${fmtCompact(hv)}`, 138, subTop + 1);
    } else {
      const ry = (v: number) => subTop + ((100 - v) / 100) * (subBottom - subTop);
      // zonas sobreventa / sobrecompra
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
      for (let i = 0; i < ind.rsi.length; i++) {
        const px = i * cellW + cellW / 2;
        if (i === 0) ctx.moveTo(px, ry(ind.rsi[i]));
        else ctx.lineTo(px, ry(ind.rsi[i]));
      }
      ctx.strokeStyle = "#b7c7e2";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const rv = ind.rsi[ind.rsi.length - 1];
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
  }, [state, width, hover, ind, osc, tfMin, cfg]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yy = e.clientY - rect.top;
    const plotW = width - SCALE_W;
    const plotBottom = H - TIME_H - SUB_H - 12;
    const idx = Math.min(CANDLE_COUNT - 1, Math.max(0, Math.floor((x / plotW) * CANDLE_COUNT)));
    const price = state.pMax - ((yy - PAD_T) / (plotBottom - PAD_T)) * (state.pMax - state.pMin);
    const bin = Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((price - state.pMin) / (state.pMax - state.pMin)) * (HEAT_BINS - 1))));
    const heat = state.heat[idx * HEAT_BINS + bin] / state.heatMax;
    setHover({ x, y: yy, idx, price, heat });
  };

  const k = hover ? state.candles[hover.idx] : null;
  const tm = TREND_META[ind.trend.dir];
  const lastFast = ind.emaFast[ind.emaFast.length - 1];
  const lastSlow = ind.emaSlow[ind.emaSlow.length - 1];
  const lastTrend = ind.emaTrend[ind.emaTrend.length - 1];

  return (
    <section className="panel panel-corner anim-reveal" style={{ animationDelay: "0.05s" }}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Heatmap de liquidaciones
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {state.meta.symbol} · perp · energía de liquidación por nivel de precio
          </p>
        </div>

        {/* insignia de tendencia */}
        <span className={`flex items-center gap-2 border px-2.5 py-1.5 ${tm.c}`}>
          <TrendIcon dir={ind.trend.dir} />
          <span className="font-mono text-[9.5px] font-bold uppercase tracking-widest">{tm.label}</span>
          <span className="h-1 w-12 overflow-hidden bg-ink-700/80">
            <span
              className="block h-full transition-all duration-700"
              style={{ width: `${Math.round(ind.trend.strength * 100)}%`, background: tm.bar }}
            />
          </span>
          <span className="tick-num font-mono text-[9.5px] font-bold">{Math.round(ind.trend.strength * 100)}%</span>
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* leyenda de EMAs */}
          <div className="hidden items-center gap-3 font-mono text-[9px] text-mist-500 2xl:flex">
            <span className="flex items-center gap-1.5">
              <span className="h-[2px] w-4 bg-long-300" /> EMA {cfg.fast}
              <b className="tick-num text-mist-300">{fmtPrice(lastFast, state.meta.decimals)}</b>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-[2px] w-4 bg-flare-400" /> EMA {cfg.slow}
              <b className="tick-num text-mist-300">{fmtPrice(lastSlow, state.meta.decimals)}</b>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0 w-4 border-t border-dashed border-mist-400" /> EMA {cfg.trend}
              <b className="tick-num text-mist-300">{fmtPrice(lastTrend, state.meta.decimals)}</b>
            </span>
          </div>

          {/* selector de oscilador */}
          <div className="flex border border-ink-700 bg-ink-900/70">
            {(["cvd", "macd", "rsi"] as Osc[]).map((o) => (
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
          </div>

          {/* timeframes */}
          <div className="flex border border-ink-700 bg-ink-900/70">
            {timeframes.map((t) => (
              <button
                key={t.key}
                onClick={() => setTfKey(t.key)}
                className={`px-2.5 py-1 font-mono text-[10px] font-semibold transition-colors ${
                  t.key === tfKey
                    ? "bg-long-500/20 text-long-300"
                    : "text-mist-500 hover:bg-ink-750 hover:text-mist-300"
                }`}
              >
                {t.key}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* stats strip */}
      <div className="grid grid-cols-2 divide-x divide-ink-700/50 border-b border-ink-700/50 bg-ink-900/50 sm:grid-cols-4">
        {[
          { l: "Liq. 24h longs", v: fmtUsd(state.totalLiq24hLong), c: "text-long-300" },
          { l: "Liq. 24h shorts", v: fmtUsd(state.totalLiq24hShort), c: "text-short-300" },
          { l: "Open interest", v: fmtUsd(state.oi, 2), c: "text-mist-200", sub: fmtPct(state.oiDelta1h, 2) + " 1h" },
          { l: "Funding", v: fmtPct(state.funding, 4), c: state.funding >= 0 ? "text-long-300" : "text-short-300" },
        ].map((it) => (
          <div key={it.l} className="px-4 py-2.5">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">{it.l}</div>
            <div className={`tick-num mt-0.5 font-display text-base font-bold ${it.c}`}>
              {it.v}
              {it.sub && <span className="ml-1.5 font-mono text-[9px] font-medium text-mist-500">{it.sub}</span>}
            </div>
          </div>
        ))}
      </div>

      <div ref={wrapRef} className="relative">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: H, display: "block", cursor: "crosshair" }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
        {hover && k && (
          <div
            className="pointer-events-none absolute z-20 border border-ink-600 bg-ink-900/95 px-3 py-2 font-mono text-[10px] shadow-xl"
            style={{
              left: Math.min(hover.x + 16, width - 200),
              top: Math.min(hover.y + 14, H - 150),
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
                <span className="text-flare-300">{fmtPrice(ind.emaSlow[hover.idx], state.meta.decimals)}</span>
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
