import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketState } from "../lib/market";
import { CANDLE_COUNT, HEAT_BINS } from "../lib/market";
import { computeIndicators, getIndicatorCfg, type TrendDir } from "../lib/indicators";
import { fmtAxisTime, fmtCompact, fmtHM, fmtPct, fmtPrice, fmtUsd } from "../lib/format";

type Osc = "cvd" | "macd" | "rsi" | "adx";

interface Props {
  state: MarketState;
  tfKey: string;
  setTfKey: (k: string) => void;
  timeframes: { key: string; minutes: number }[];
}

const H = 488;
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
  const [osc, setOsc] = useState<Osc>("cvd");
  const [visibleCount, setVisibleCount] = useState(() => loadZoom(tfKey));
  const [levOn, setLevOn] = useState<Record<number, boolean>>(loadLevOn);

  // preferencia de escalera de apalancamiento persistida
  useEffect(() => {
    try {
      localStorage.setItem(LEV_KEY, JSON.stringify(levOn));
    } catch {
      /* sin almacenamiento */
    }
  }, [levOn]);

  const cfg = getIndicatorCfg(tfKey);
  const tfMin = timeframes.find((t) => t.key === tfKey)?.minutes ?? 5;

  const ind = useMemo(() => computeIndicators(state.candles, cfg, tfMin), [state.candles, cfg, tfMin]);

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
        const step = Math.max(2, Math.round(v * 0.14));
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

    const { candles, heat, pMin, pMax, meta, cvd, clusters } = state;
    const plotW = width - SCALE_W;
    const plotTop = PAD_T;
    const plotBottom = H - TIME_H - SUB_H - 12;
    const plotH = plotBottom - plotTop;
    const lastC = candles[CANDLE_COUNT - 1].c;
    const y = (p: number) => plotTop + ((view.yMax - p) / (view.yMax - view.yMin)) * plotH;
    const cellW = plotW / visibleCount;
    const priceOfBin = (b: number) => pMin + (b / (HEAT_BINS - 1)) * (pMax - pMin);

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

    // rejilla horizontal + escala de precios
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    for (let g = 0; g <= 6; g++) {
      const p = view.yMin + ((view.yMax - view.yMin) * g) / 6;
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

    // celdas de calor (mapeadas por precio al rango visible)
    let heatVisMax = 0;
    for (let i = view.start; i < CANDLE_COUNT; i++)
      for (let b = 0; b < HEAT_BINS; b++) heatVisMax = Math.max(heatVisMax, heat[i * HEAT_BINS + b]);
    if (heatVisMax <= 0) heatVisMax = state.heatMax || 1;
    const cellH = plotH / HEAT_BINS;
    for (let i = view.start; i < CANDLE_COUNT; i++) {
      const x = (i - view.start) * cellW;
      for (let b = 0; b < HEAT_BINS; b++) {
        const v = heat[i * HEAT_BINS + b];
        if (v / heatVisMax < 0.055) continue;
        const bp = priceOfBin(b);
        if (bp < view.yMin || bp > view.yMax) continue;
        const t = Math.min(1, Math.pow(v / heatVisMax, 1.25));
        const ramp = bp < lastC ? LONG_RAMP : SHORT_RAMP;
        ctx.fillStyle = ramp[Math.round(t * 25)];
        ctx.fillRect(x, y(bp) - cellH / 2, cellW + 0.5, cellH + 0.5);
      }
    }

    // marcadores de clústeres (línea reforzada + halo para destacar sobre el calor)
    for (const cl of clusters.slice(0, 6)) {
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
    for (const lev of LEVS) {
      if (!levOn[lev]) continue;
      const pctDist = 100 / lev;
      const sides = [
        { price: lastC * (1 - 1 / lev), col: "45,224,192", tag: `x${lev} ${pctDist.toFixed(0)}% L` },
        { price: lastC * (1 + 1 / lev), col: "255,93,126", tag: `x${lev} ${pctDist.toFixed(0)}% S` },
      ];
      const alpha = LEV_ALPHA[lev];
      for (const s of sides) {
        const ly2 = y(s.price);
        if (ly2 < plotTop + 3 || ly2 > plotBottom - 3) continue;
        ctx.strokeStyle = `rgba(${s.col},${alpha})`;
        ctx.lineWidth = 1.1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(0, ly2);
        ctx.lineTo(plotW, ly2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        const tw = ctx.measureText(s.tag).width;
        const bx = plotW - tw - 18;
        ctx.fillStyle = "rgba(7,12,22,0.92)";
        ctx.fillRect(bx, ly2 - 8, tw + 14, 15);
        ctx.strokeStyle = `rgba(${s.col},${Math.min(1, alpha + 0.2)})`;
        ctx.strokeRect(bx + 0.5, ly2 - 7.5, tw + 13, 14);
        ctx.fillStyle = `rgba(${s.col},${Math.min(1, alpha + 0.25)})`;
        ctx.textAlign = "left";
        ctx.fillText(s.tag, bx + 7, ly2 + 0.5);
      }
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
    for (let i = Math.max(1, view.start); i < CANDLE_COUNT; i++) {
      const x0 = (i - 1 - view.start) * cellW + cellW / 2;
      const x1 = (i - view.start) * cellW + cellW / 2;
      const col = ind.stUp[i] ? "#2de0c0" : "#ff5d7e";
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(x0, y(ind.st[i - 1]));
      ctx.lineTo(x1, y(ind.st[i]));
      ctx.stroke();
      if (ind.stUp[i] !== ind.stUp[i - 1]) {
        // marcador de giro de tendencia
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
    drawEma(ind.emaTrend, "rgba(143,163,196,0.75)", 1.2, [4, 4]);
    drawEma(ind.emaSlow, "#ffb224", 1.5);
    drawEma(ind.emaFast, "#7df0da", 1.5);
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
      ctx.fillText(fmtAxisTime(candles[i].t, tfMin), (i - view.start) * cellW + cellW / 2, H - TIME_H / 2 - 4);
    }

    // --- sub-panel de oscilador (CVD / MACD / RSI / ADX) ---
    const subTop = plotBottom + 14;
    const subBottom = H - TIME_H - 4;
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
      ctx.fillText("CVD · delta acumulado", 8, subTop + 1);
      ctx.fillStyle = cvdUp ? "#2de0c0" : "#ff5d7e";
      ctx.fillText(fmtCompact(cv[cv.length - 1]), 146, subTop + 1);
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
      let mx = 40;
      for (let i = 0; i < aS.length; i++) mx = Math.max(mx, aS[i], pS[i], mS[i]);
      const ay = (v: number) => subTop + (1 - Math.min(1, v / mx)) * (subBottom - subTop);
      // zona de tendencia fuerte (≥25)
      ctx.fillStyle = "rgba(255,178,36,0.06)";
      ctx.fillRect(0, ay(mx), plotW, ay(25) - ay(mx));
      ctx.strokeStyle = "rgba(95,115,150,0.35)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, ay(25));
      ctx.lineTo(plotW, ay(25));
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
      ctx.fillStyle = av >= 25 ? "#ffb224" : "#8fa3c4";
      ctx.fillText(av.toFixed(1), 196, subTop + 1);
      ctx.fillStyle = "#48597a";
      ctx.fillText("fuerte ≥ 25", 236, subTop + 1);
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
  }, [state, width, hover, ind, osc, tfMin, cfg, view, visibleCount, levOn]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yy = e.clientY - rect.top;
    const plotW = width - SCALE_W;
    const plotBottom = H - TIME_H - SUB_H - 12;
    const vIdx = Math.min(visibleCount - 1, Math.max(0, Math.floor((x / plotW) * visibleCount)));
    const idx = view.start + vIdx;
    const price = view.yMax - ((yy - PAD_T) / (plotBottom - PAD_T)) * (view.yMax - view.yMin);
    const bin = Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((price - state.pMin) / (state.pMax - state.pMin)) * (HEAT_BINS - 1))));
    const heat = state.heat[idx * HEAT_BINS + bin] / state.heatMax;
    setHover({ x, y: yy, idx, price, heat });
  };

  const k = hover ? state.candles[hover.idx] : null;
  const cons = ind.consensus;
  const tm = TREND_META[cons.dir];
  const lastFast = ind.emaFast[ind.emaFast.length - 1];
  const lastSlow = ind.emaSlow[ind.emaSlow.length - 1];
  const lastTrend = ind.emaTrend[ind.emaTrend.length - 1];
  const lastStUp = ind.stUp[ind.stUp.length - 1];
  const zoomed = visibleCount < CANDLE_COUNT;

  return (
    <section className="panel panel-corner anim-reveal" style={{ animationDelay: "0.05s" }}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Heatmap de liquidaciones
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {state.meta.symbol} · perp ·{" "}
            <span className="hidden sm:inline">rueda = zoom · doble clic = restablecer</span>
            <span className="sm:hidden">energía por nivel</span>
          </p>
        </div>

        {/* insignia de tendencia (consenso de 5 indicadores) */}
        <span className={`flex items-center gap-2 border px-2.5 py-1.5 ${tm.c}`} title="Consenso: cruce EMA + MACD + RSI + Supertrend + ADX">
          <TrendIcon dir={cons.dir} />
          <span className="font-mono text-[9.5px] font-bold uppercase tracking-widest">{tm.label}</span>
          <span className="h-1 w-12 overflow-hidden bg-ink-700/80">
            <span
              className="block h-full transition-all duration-700"
              style={{ width: `${Math.round(cons.strength * 100)}%`, background: tm.bar }}
            />
          </span>
          <span className="tick-num font-mono text-[9.5px] font-bold">{Math.round(cons.strength * 100)}%</span>
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* leyenda */}
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
            <span className="flex items-center gap-1.5">
              <span className={`h-[2px] w-4 ${lastStUp ? "bg-long-400" : "bg-short-400"}`} />
              ST {cfg.atr}×{cfg.stMult}
            </span>
          </div>

          {/* escalera de apalancamiento */}
          <div
            className="flex items-center border border-ink-700 bg-ink-900/70"
            title="Líneas de liquidación por apalancamiento: distancia ≈ 1/apalancamiento desde el precio actual (margen aislado)"
          >
            <span className="border-r border-ink-700 px-2 py-1 font-mono text-[8.5px] font-semibold uppercase tracking-[0.14em] text-mist-600">
              Liq lev
            </span>
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
          </div>

          {/* selector de oscilador */}
          <div className="flex border border-ink-700 bg-ink-900/70">
            {(["cvd", "macd", "rsi", "adx"] as Osc[]).map((o) => (
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

          {/* control de zoom */}
          <div className="flex items-stretch border border-ink-700 bg-ink-900/70" title="Nivel de zoom sobre la ventana de velas">
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
              title="Restablecer zoom"
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
          </div>

          {/* timeframes */}
          <div className="flex border border-ink-700 bg-ink-900/70">
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
          onDoubleClick={() => setVisibleCount(CANDLE_COUNT)}
        />
        {hover && k && (
          <div
            className="pointer-events-none absolute z-20 border border-ink-600 bg-ink-900/95 px-3 py-2 font-mono text-[10px] shadow-xl"
            style={{
              left: Math.min(hover.x + 16, width - 220),
              top: Math.min(hover.y + 14, H - 170),
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
    </section>
  );
}
