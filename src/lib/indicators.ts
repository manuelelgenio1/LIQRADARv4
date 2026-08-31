// ============================================================
// Indicadores técnicos: funciones puras sobre series de velas,
// calibrados por temporalidad.
// ============================================================
import type { Candle } from "./market";

export type TrendDir = "alcista" | "bajista" | "lateral";

export interface IndicatorCfg {
  fast: number;
  slow: number;
  trend: number;
  macd: [number, number, number];
  rsi: number;
  atr: number;
  stMult: number;
  adx: number;
  adxThr: number;
}

const TF_INDICATORS: Record<string, IndicatorCfg> = {
  "1m": { fast: 9, slow: 21, trend: 50, macd: [9, 21, 6], rsi: 9, atr: 8, stMult: 1.6, adx: 12, adxThr: 22 },
  "5m": { fast: 12, slow: 26, trend: 60, macd: [10, 24, 7], rsi: 11, atr: 10, stMult: 2.0, adx: 14, adxThr: 23 },
  "15m": { fast: 14, slow: 30, trend: 70, macd: [11, 26, 8], rsi: 12, atr: 10, stMult: 2.2, adx: 14, adxThr: 24 },
  "1H": { fast: 20, slow: 50, trend: 100, macd: [12, 26, 9], rsi: 14, atr: 11, stMult: 2.6, adx: 14, adxThr: 25 },
  "4H": { fast: 21, slow: 55, trend: 120, macd: [19, 39, 9], rsi: 14, atr: 12, stMult: 3.0, adx: 14, adxThr: 25 },
  "1D": { fast: 21, slow: 55, trend: 120, macd: [12, 26, 9], rsi: 14, atr: 12, stMult: 3.0, adx: 14, adxThr: 25 },
  "1W": { fast: 10, slow: 30, trend: 52, macd: [8, 21, 5], rsi: 10, atr: 10, stMult: 2.8, adx: 12, adxThr: 24 },
};

export function getIndicatorCfg(tfKey: string): IndicatorCfg {
  return TF_INDICATORS[tfKey] ?? TF_INDICATORS["5m"];
}

export function adxThrOf(cfg: IndicatorCfg): number {
  return Number.isFinite(cfg.adxThr) && cfg.adxThr > 0 ? cfg.adxThr : 25;
}

export function emaSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(values[0] ?? 0);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function macdSeries(closes: number[], [fast, slow, sig]: [number, number, number]) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const macd = ef.map((v, i) => v - es[i]);
  const signal = emaSeries(macd, sig);
  const hist = macd.map((v, i) => v - signal[i]);
  return { macd, signal, hist };
}

export function rsiSeries(closes: number[], period: number): number[] {
  const n = closes.length;
  const out = new Array(n).fill(50);
  if (n < 2) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(0, d), l = Math.max(0, -d);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) {
        gain /= period; loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function atrSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out = new Array(n).fill(0);
  if (!n) return out;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const pc = i > 0 ? candles[i - 1].c : k.o;
    const tr = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    prev = i === 0 ? tr : (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

export function supertrendSeries(candles: Candle[], period: number, mult: number) {
  const n = candles.length;
  const line = new Array(n).fill(0);
  const up = new Array(n).fill(true);
  if (!n) return { line, up, upConf: up };
  const atr = atrSeries(candles, period);
  let ub = Infinity, lb = -Infinity, trend = 1;
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const mid = (k.h + k.l) / 2;
    const band = mult * atr[i];
    let fu = mid + band, fl = mid - band;
    if (i > 0) {
      if (fu < ub || candles[i - 1].c > ub) ub = fu;
      else fu = ub;
      if (fl > lb || candles[i - 1].c < lb) lb = fl;
      else fl = lb;
    }
    trend = i === 0 ? (k.c > fu ? 1 : -1) : trend === 1 ? (k.c < fl ? -1 : 1) : k.c > fu ? 1 : -1;
    line[i] = trend === 1 ? fl : fu;
    up[i] = trend === 1;
  }
  // giros confirmados (persistencia de 1 vela) — elimina latigazos
  const upConf = up.slice();
  let conf = up[0];
  upConf[0] = conf;
  for (let i = 1; i < n; i++) {
    if (up[i] === up[i - 1]) conf = up[i];
    upConf[i] = conf;
  }
  return { line, up, upConf };
}

export function adxSeries(candles: Candle[], period: number) {
  const n = candles.length;
  const adx = new Array(n).fill(0);
  const pdi = new Array(n).fill(0);
  const mdi = new Array(n).fill(0);
  if (n < 2) return { adx, pdi, mdi };
  const atr = atrSeries(candles, period);
  let sp = 0, sm = 0, dxSum = 0, dxCount = 0, adxPrev = 0;
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const dnMove = candles[i - 1].l - candles[i].l;
    sp = (sp * (period - 1)) / period + (upMove > dnMove && upMove > 0 ? upMove : 0);
    sm = (sm * (period - 1)) / period + (dnMove > upMove && dnMove > 0 ? dnMove : 0);
    const a = atr[i] || 1e-9;
    const p = (sp / a) * 100;
    const m = (sm / a) * 100;
    pdi[i] = p;
    mdi[i] = m;
    const dx = p + m > 0 ? (Math.abs(p - m) / (p + m)) * 100 : 0;
    if (dxCount < period) {
      dxSum += dx;
      dxCount++;
      adx[i] = dxSum / dxCount;
    } else {
      adxPrev = (adxPrev * (period - 1) + dx) / period;
      adx[i] = adxPrev;
    }
  }
  adx[0] = adx[1] ?? 0;
  return { adx, pdi, mdi };
}

// ---------- consenso de 5 indicadores ----------
export interface Vote {
  name: string;
  note: string;
  weight: number;
  dir: TrendDir;
  strength: number;
}
export interface Consensus {
  dir: TrendDir;
  score: number;
  strength: number;
  votes: Vote[];
}

function last(a: number[]): number {
  return a.length ? a[a.length - 1] : 0;
}

export function buildConsensus(
  b: {
    emaFast: number[]; emaSlow: number[]; hist: number[]; rsi: number[];
    stUp: boolean[]; stUpConf: boolean[]; adx: number[]; pdi: number[]; mdi: number[];
    atr: number[]; closes: number[]; st: number[];
  },
  cfg: IndicatorCfg,
  tfMinutes: number
): Consensus {
  const votes: Vote[] = [];
  const tf = Number.isFinite(tfMinutes) && tfMinutes > 0 ? tfMinutes : 5;
  const thr = 0.0006 * Math.sqrt(tf / 5);

  const ef = last(b.emaFast), es = last(b.emaSlow);
  const sep = es !== 0 ? (ef - es) / es : 0;
  votes.push({
    name: "Cruce EMA",
    note: `Δ ${(sep * 100).toFixed(2)}%`,
    weight: 1,
    dir: sep > thr ? "alcista" : sep < -thr ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(sep) / (thr * 4)),
  });

  const h = last(b.hist);
  votes.push({
    name: "MACD",
    note: `hist ${h >= 0 ? "+" : ""}${h.toFixed(2)}`,
    weight: 1,
    dir: h > 0 ? "alcista" : h < 0 ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(h) / (last(b.atr) * 0.5 + 1e-9)),
  });

  const r = last(b.rsi);
  votes.push({
    name: "RSI",
    note: `rsi ${r.toFixed(0)}`,
    weight: 0.8,
    dir: r > 55 ? "alcista" : r < 45 ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(r - 50) / 30),
  });

  const st = b.stUpConf[b.stUpConf.length - 1] ?? true;
  votes.push({
    name: "Supertrend",
    note: `ATR ${cfg.atr} × ${cfg.stMult}`,
    weight: 1.25,
    dir: st ? "alcista" : "bajista",
    strength: 1,
  });

  const a = last(b.adx);
  const thrA = adxThrOf(cfg);
  const strong = a >= thrA;
  votes.push({
    name: "ADX",
    note: strong ? `fuerza ${a.toFixed(0)}` : `débil · ${a.toFixed(0)}`,
    weight: 1.4,
    dir: !strong ? "lateral" : last(b.pdi) > last(b.mdi) ? "alcista" : "bajista",
    strength: strong ? Math.min(1, a / 50) : Math.max(0, (thrA - a) / thrA),
  });

  let num = 0, den = 0;
  for (const v of votes) {
    const s = v.dir === "alcista" ? 1 : v.dir === "bajista" ? -1 : 0;
    num += s * v.weight * v.strength;
    den += v.weight;
  }
  const fin = (x: number) => (Number.isFinite(x) ? x : 0);
  const score = den ? fin(num / den) : 0;
  const strength = Math.max(0, Math.min(1, Math.abs(score)));
  const dir: TrendDir = score > 0.12 ? "alcista" : score < -0.12 ? "bajista" : "lateral";
  return { dir, score, strength, votes };
}

export interface IndicatorBundle {
  emaFast: number[]; emaSlow: number[]; emaTrend: number[];
  macd: number[]; signal: number[]; hist: number[];
  rsi: number[]; atr: number[];
  st: number[]; stUp: boolean[]; stUpConf: boolean[];
  adx: number[]; pdi: number[]; mdi: number[];
  consensus: Consensus;
}

export function computeIndicators(candles: Candle[], cfg: IndicatorCfg, tfMinutes: number): IndicatorBundle {
  const closes = candles.map((k) => k.c);
  const emaFast = emaSeries(closes, cfg.fast);
  const emaSlow = emaSeries(closes, cfg.slow);
  const emaTrend = emaSeries(closes, cfg.trend);
  const m = macdSeries(closes, cfg.macd);
  const rsi = rsiSeries(closes, cfg.rsi);
  const atr = atrSeries(candles, cfg.atr);
  const stR = supertrendSeries(candles, cfg.atr, cfg.stMult);
  const adxR = adxSeries(candles, cfg.adx);
  const consensus = buildConsensus(
    {
      emaFast, emaSlow, hist: m.hist, rsi,
      stUp: stR.up, stUpConf: stR.upConf, adx: adxR.adx,
      pdi: adxR.pdi, mdi: adxR.mdi, atr, closes, st: stR.line,
    },
    cfg,
    tfMinutes
  );
  return {
    emaFast, emaSlow, emaTrend,
    macd: m.macd, signal: m.signal, hist: m.hist,
    rsi, atr,
    st: stR.line, stUp: stR.up, stUpConf: stR.upConf,
    adx: adxR.adx, pdi: adxR.pdi, mdi: adxR.mdi,
    consensus,
  };
}

export function sliceIndicators(d: IndicatorBundle, n: number): IndicatorBundle {
  const sN = (a: number[]) => (a.length > n ? a.slice(-n) : a);
  const sB = (a: boolean[]) => (a.length > n ? a.slice(-n) : a);
  return {
    ...d,
    emaFast: sN(d.emaFast), emaSlow: sN(d.emaSlow), emaTrend: sN(d.emaTrend),
    macd: sN(d.macd), signal: sN(d.signal), hist: sN(d.hist),
    rsi: sN(d.rsi), atr: sN(d.atr),
    st: sN(d.st), stUp: sB(d.stUp), stUpConf: sB(d.stUpConf),
    adx: sN(d.adx), pdi: sN(d.pdi), mdi: sN(d.mdi),
  };
}

export interface MtfAdj {
  strength: number;
  agree: number | null;
  total: number | null;
}
export function mtfAdjust(cons: Consensus, confluence: { dir: TrendDir }[] | null | undefined): MtfAdj {
  if (!confluence || !confluence.length || cons.dir === "lateral") {
    return { strength: cons.strength, agree: null, total: null };
  }
  const agree = confluence.filter((c) => c.dir === cons.dir).length;
  const total = confluence.length;
  const strength = Math.max(0, Math.min(1, cons.strength * (0.7 + 0.6 * (agree / total))));
  return { strength, agree, total };
}
