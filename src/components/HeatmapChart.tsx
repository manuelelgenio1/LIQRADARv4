import { useEffect, useRef, useState } from "react";
import type { MarketState } from "../lib/market";
import { CANDLE_COUNT, HEAT_BINS } from "../lib/market";
import { fmtCompact, fmtHM, fmtPct, fmtPrice, fmtUsd } from "../lib/format";

interface Props {
  state: MarketState;
  tfKey: string;
  setTfKey: (k: string) => void;
  timeframes: { key: string; minutes: number }[];
}

const H = 488;
const SCALE_W = 86;
const CVD_H = 82;
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

export default function HeatmapChart({ state, tfKey, setTfKey, timeframes }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<Hover | null>(null);

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
    const plotBottom = H - TIME_H - CVD_H - 10;
    const plotH = plotBottom - plotTop;
    const lastC = candles[CANDLE_COUNT - 1].c;
    const y = (p: number) => plotTop + ((pMax - p) / (pMax - pMin)) * plotH;
    const cellW = plotW / CANDLE_COUNT;
    const cellH = plotH / HEAT_BINS;

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

    // eje de tiempo
    ctx.fillStyle = "#48597a";
    ctx.textAlign = "center";
    for (let i = 8; i < CANDLE_COUNT; i += 26) {
      ctx.fillText(fmtHM(candles[i].t), i * cellW + cellW / 2, H - TIME_H / 2 - 4);
    }

    // --- sub-panel CVD ---
    const cvdTop = plotBottom + 12;
    const cvdBottom = H - TIME_H - 6;
    ctx.strokeStyle = "rgba(37,54,80,0.55)";
    ctx.beginPath();
    ctx.moveTo(0, cvdTop - 6);
    ctx.lineTo(width, cvdTop - 6);
    ctx.stroke();
    let cMin = Infinity, cMax = -Infinity;
    for (const v of cvd) { cMin = Math.min(cMin, v); cMax = Math.max(cMax, v); }
    const cSpan = Math.max(1e-9, cMax - cMin);
    const cy2 = (v: number) => cvdTop + ((cMax - v) / cSpan) * (cvdBottom - cvdTop);
    const zeroY = cy2(0);
    ctx.strokeStyle = "rgba(95,115,150,0.35)";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(plotW, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    const cvdUp = cvd[cvd.length - 1] >= 0;
    const grad = ctx.createLinearGradient(0, cvdTop, 0, cvdBottom);
    if (cvdUp) {
      grad.addColorStop(0, "rgba(45,224,192,0.30)");
      grad.addColorStop(1, "rgba(45,224,192,0.02)");
    } else {
      grad.addColorStop(0, "rgba(255,93,126,0.30)");
      grad.addColorStop(1, "rgba(255,93,126,0.02)");
    }
    ctx.beginPath();
    ctx.moveTo(0, cvdBottom);
    for (let i = 0; i < cvd.length; i++) ctx.lineTo(i * cellW + cellW / 2, cy2(cvd[i]));
    ctx.lineTo(plotW, cvdBottom);
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
    ctx.fillText("CVD", 8, cvdTop + 2);
    ctx.fillStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
    ctx.fillText(fmtCompact(cvd[cvd.length - 1]), 36, cvdTop + 2);

    // crosshair
    if (hover && hover.x < plotW) {
      ctx.strokeStyle = "rgba(183,199,226,0.4)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, plotTop);
      ctx.lineTo(hover.x, cvdBottom);
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
  }, [state, width, hover]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yy = e.clientY - rect.top;
    const plotW = width - SCALE_W;
    const plotBottom = H - TIME_H - CVD_H - 10;
    const idx = Math.min(CANDLE_COUNT - 1, Math.max(0, Math.floor((x / plotW) * CANDLE_COUNT)));
    const price = state.pMax - ((yy - PAD_T) / (plotBottom - PAD_T)) * (state.pMax - state.pMin);
    const bin = Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((price - state.pMin) / (state.pMax - state.pMin)) * (HEAT_BINS - 1))));
    const heat = state.heat[idx * HEAT_BINS + bin] / state.heatMax;
    setHover({ x, y: yy, idx, price, heat });
  };

  const k = hover ? state.candles[hover.idx] : null;

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

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="hidden items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-mist-500 lg:flex">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 bg-long-400/80" /> liq. longs
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 bg-short-400/80" /> liq. shorts
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-8" style={{ background: "linear-gradient(90deg, rgba(45,224,192,0.1), #ffd37a, #fff)" }} />
              intensidad
            </span>
          </div>
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
              left: Math.min(hover.x + 16, width - 190),
              top: Math.min(hover.y + 14, H - 130),
            }}
          >
            <div className="mb-1 text-[9px] uppercase tracking-widest text-mist-500">{fmtHM(k.t)} UTC</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-mist-300">
              <span className="text-mist-600">O</span><span className="tick-num text-right">{fmtPrice(k.o, state.meta.decimals)}</span>
              <span className="text-mist-600">H</span><span className="tick-num text-right text-long-300">{fmtPrice(k.h, state.meta.decimals)}</span>
              <span className="text-mist-600">L</span><span className="tick-num text-right text-short-300">{fmtPrice(k.l, state.meta.decimals)}</span>
              <span className="text-mist-600">C</span><span className="tick-num text-right">{fmtPrice(k.c, state.meta.decimals)}</span>
              <span className="text-mist-600">Calor</span>
              <span className={`tick-num text-right ${hover.heat > 0.5 ? "text-flare-300" : "text-mist-400"}`}>
                {(hover.heat * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
