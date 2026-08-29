// ============================================================
// Indicadores técnicos calibrados por temporalidad
// EMA rápida/lenta/tendencia · MACD · RSI · ATR · Supertrend ·
// ADX(+DI/−DI) · consenso de tendencia ponderado
// ============================================================
import type { Candle } from "./market";

export interface IndicatorCfg {
  fast: number;            // periodo EMA rápida (velas)
  slow: number;            // periodo EMA lenta (velas)
  trend: number;           // periodo EMA de tendencia de fondo
  macd: [number, number, number];
  rsi: number;
  atr: number;             // periodo ATR del Supertrend
  stMult: number;          // multiplicador del Supertrend
  adx: number;             // periodo del ADX
}

// Calibración por timeframe: cada temporalidad usa periodos que cubren
// horizontes equivalentes en tiempo real (no en número de velas).
export const TF_INDICATORS: Record<string, IndicatorCfg> = {
  "1m":  { fast: 9,  slow: 21, trend: 50,  macd: [12, 26, 9], rsi: 9,  atr: 10, stMult: 3,   adx: 14 },
  "5m":  { fast: 12, slow: 26, trend: 60,  macd: [12, 26, 9], rsi: 14, atr: 10, stMult: 3,   adx: 14 },
  "15m": { fast: 14, slow: 30, trend: 70,  macd: [12, 26, 9], rsi: 14, atr: 10, stMult: 3,   adx: 14 },
  "1H":  { fast: 20, slow: 50, trend: 100, macd: [12, 26, 9], rsi: 14, atr: 10, stMult: 3,   adx: 14 },
  "4H":  { fast: 21, slow: 55, trend: 110, macd: [19, 39, 9], rsi: 14, atr: 12, stMult: 2.8, adx: 14 },
  "1D":  { fast: 21, slow: 55, trend: 120, macd: [12, 26, 9], rsi: 14, atr: 10, stMult: 3,   adx: 14 },
  "1W":  { fast: 10, slow: 30, trend: 52,  macd: [8, 21, 5],  rsi: 10, atr: 10, stMult: 2.4, adx: 10 },
};

export function getIndicatorCfg(tfKey: string): IndicatorCfg {
  return TF_INDICATORS[tfKey] ?? TF_INDICATORS["5m"];
}

// ---------- EMA ----------
export function emaSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
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

// ---------- MACD ----------
export interface MacdResult {
  macd: number[];
  signal: number[];
  hist: number[];
}

export function macdSeries(values: number[], f: number, s: number, sig: number): MacdResult {
  const ef = emaSeries(values, f);
  const es = emaSeries(values, s);
  const macd = values.map((_, i) => ef[i] - es[i]);
  const signal = emaSeries(macd, sig);
  const hist = macd.map((v, i) => v - signal[i]);
  return { macd, signal, hist };
}

// ---------- RSI (Wilder) ----------
export function rsiSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(50);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(0, d)) / period;
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

// ---------- ATR (Wilder) ----------
export function atrSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out = new Array(n).fill(0);
  if (!n) return out;
  const tr = (i: number) =>
    i === 0
      ? candles[0].h - candles[0].l
      : Math.max(
          candles[i].h - candles[i].l,
          Math.abs(candles[i].h - candles[i - 1].c),
          Math.abs(candles[i].l - candles[i - 1].c)
        );
  let atr = tr(0);
  out[0] = atr;
  for (let i = 1; i < n; i++) {
    const t = tr(i);
    atr = i < period ? (atr * i + t) / (i + 1) : (atr * (period - 1) + t) / period;
    out[i] = atr;
  }
  return out;
}

// ---------- Supertrend (ATR con bandas de soporte/resistencia dinámicas) ----------
export function supertrendSeries(
  candles: Candle[],
  period: number,
  mult: number
): { line: number[]; up: boolean[] } {
  const n = candles.length;
  const line = new Array(n).fill(0);
  const up = new Array(n).fill(true);
  if (!n) return { line, up };
  const atr = atrSeries(candles, period);
  let fu = Infinity;
  let fl = -Infinity;
  let trend = 1;
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const mid = (k.h + k.l) / 2;
    const bu = mid + mult * atr[i];
    const bl = mid - mult * atr[i];
    if (i === 0) {
      fu = bu;
      fl = bl;
      line[0] = bl;
      up[0] = true;
      continue;
    }
    const pc = candles[i - 1].c;
    fu = bu < fu || pc > fu ? bu : fu;
    fl = bl > fl || pc < fl ? bl : fl;
    if (trend === 1 && k.c < fl) trend = -1;
    else if (trend === -1 && k.c > fu) trend = 1;
    line[i] = trend === 1 ? fl : fu;
    up[i] = trend === 1;
  }
  return { line, up };
}

// ---------- ADX con +DI / −DI (Wilder) ----------
export function adxSeries(
  candles: Candle[],
  period: number
): { adx: number[]; pdi: number[]; mdi: number[] } {
  const n = candles.length;
  const adx = new Array(n).fill(0);
  const pdi = new Array(n).fill(0);
  const mdi = new Array(n).fill(0);
  if (n <= period) return { adx, pdi, mdi };

  const tr = (i: number) =>
    Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );

  let aTr = 0, aPdm = 0, aMdm = 0;
  for (let i = 1; i <= period; i++) {
    aTr += tr(i);
    aPdm += Math.max(0, candles[i].h - candles[i - 1].h);
    aMdm += Math.max(0, candles[i - 1].l - candles[i].l);
  }
  aTr /= period;
  aPdm /= period;
  aMdm /= period;

  const dxArr = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    if (i > period) {
      aTr = (aTr * (period - 1) + tr(i)) / period;
      aPdm = (aPdm * (period - 1) + Math.max(0, candles[i].h - candles[i - 1].h)) / period;
      aMdm = (aMdm * (period - 1) + Math.max(0, candles[i - 1].l - candles[i].l)) / period;
    }
    const dp = aTr > 0 ? (100 * aPdm) / aTr : 0;
    const dm = aTr > 0 ? (100 * aMdm) / aTr : 0;
    pdi[i] = dp;
    mdi[i] = dm;
    dxArr[i] = dp + dm > 0 ? (100 * Math.abs(dp - dm)) / (dp + dm) : 0;
  }

  // ADX: media de los primeros `period` DX y luego suavizado de Wilder
  const seedEnd = Math.min(2 * period, n);
  let sum = 0;
  for (let i = period; i < seedEnd; i++) sum += dxArr[i];
  let a = sum / Math.max(1, seedEnd - period);
  for (let i = period; i < n; i++) {
    if (i < seedEnd) {
      adx[i] = a;
    } else {
      a = (a * (period - 1) + dxArr[i]) / period;
      adx[i] = a;
    }
  }
  return { adx, pdi, mdi };
}

// ---------- clasificación de tendencia (EMA) ----------
export type TrendDir = "alcista" | "bajista" | "lateral";

export interface TrendInfo {
  dir: TrendDir;
  strength: number; // 0..1
}

export function classifyTrend(emaFast: number[], emaSlow: number[], tfMinutes: number): TrendInfo {
  const n = emaFast.length;
  if (!n) return { dir: "lateral", strength: 0 };
  const f = emaFast[n - 1];
  const s = emaSlow[n - 1] || 1;
  const rel = (f - s) / Math.abs(s);
  // umbral calibrado por temporalidad; si tfMinutes no es finito se usa 5m
  const tf = Number.isFinite(tfMinutes) && tfMinutes > 0 ? tfMinutes : 5;
  const thr = Math.min(0.03, 0.0006 * Math.sqrt(tf / 5));
  let dir: TrendDir = "lateral";
  if (rel > thr) dir = "alcista";
  else if (rel < -thr) dir = "bajista";
  const strength = Math.max(0, Math.min(1, Number.isFinite(rel) ? Math.abs(rel) / (thr * 3) : 0));
  return { dir, strength };
}

// ---------- consenso ponderado de 5 indicadores ----------
export interface ConsensusVote {
  name: string;
  note: string;
  dir: TrendDir;
  strength: number; // 0..1
  weight: number;
}

export interface Consensus {
  votes: ConsensusVote[];
  score: number;   // -1..1 (negativo = bajista)
  dir: TrendDir;
  strength: number; // 0..1
}

function buildConsensus(
  b: {
    emaFast: number[];
    emaSlow: number[];
    hist: number[];
    rsi: number[];
    stUp: boolean[];
    adx: number[];
    pdi: number[];
    mdi: number[];
    atr: number[];
  },
  cfg: IndicatorCfg,
  tfMinutes: number
): Consensus {
  const n = b.emaFast.length;
  const votes: ConsensusVote[] = [];
  if (!n) return { votes, score: 0, dir: "lateral", strength: 0 };

  const last = <T,>(arr: T[]): T => arr[arr.length - 1];
  const tf = Number.isFinite(tfMinutes) && tfMinutes > 0 ? tfMinutes : 5;
  const thr = Math.min(0.03, 0.0006 * Math.sqrt(tf / 5));

  // 1 · cruce de EMAs
  const f = last(b.emaFast);
  const s = last(b.emaSlow) || 1;
  const rel = (f - s) / Math.abs(s);
  votes.push({
    name: "Cruce EMA",
    note: `EMA ${cfg.fast}/${cfg.slow}`,
    weight: 1,
    dir: rel > thr ? "alcista" : rel < -thr ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(rel) / (thr * 3)),
  });

  // 2 · histograma MACD (normalizado por ATR)
  const h = last(b.hist);
  const aRef = Math.max(Math.abs(last(b.atr)) * 0.25, Math.abs(s) * 1e-6);
  votes.push({
    name: "MACD",
    note: `(${cfg.macd.join(",")})`,
    weight: 1,
    dir: h > aRef * 0.15 ? "alcista" : h < -aRef * 0.15 ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(h) / aRef),
  });

  // 3 · sesgo del RSI
  const r = last(b.rsi);
  votes.push({
    name: "RSI",
    note: `${cfg.rsi} períodos`,
    weight: 0.8,
    dir: r > 55 ? "alcista" : r < 45 ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(r - 50) / 30),
  });

  // 4 · Supertrend (dirección pura)
  const st = last(b.stUp);
  votes.push({
    name: "Supertrend",
    note: `ATR ${cfg.atr} × ${cfg.stMult}`,
    weight: 1.25,
    dir: st ? "alcista" : "bajista",
    strength: 1,
  });

  // 5 · ADX como filtro de fuerza (veta mercados en rango)
  const a = last(b.adx);
  const strong = a >= 20;
  votes.push({
    name: "ADX",
    note: strong ? `fuerza ${a.toFixed(0)}` : `débil · ${a.toFixed(0)}`,
    weight: 1.4,
    dir: !strong ? "lateral" : last(b.pdi) > last(b.mdi) ? "alcista" : "bajista",
    strength: strong ? Math.min(1, a / 50) : (20 - a) / 20,
  });

  const fin = (x: number, fb = 0): number => (Number.isFinite(x) ? x : fb);
  const dirVal = (d: TrendDir) => (d === "alcista" ? 1 : d === "bajista" ? -1 : 0);
  // fuerzas de voto siempre finitas y acotadas a [0,1]
  for (const v of votes) v.strength = Math.max(0, Math.min(1, fin(v.strength)));
  const wSum = votes.reduce((x, v) => x + v.weight, 0) || 1;
  const raw =
    votes.reduce((x, v) => x + v.weight * dirVal(v.dir) * (0.35 + 0.65 * v.strength), 0) / wSum;
  const score = Math.max(-1, Math.min(1, fin(raw)));
  const dir: TrendDir = score > 0.22 ? "alcista" : score < -0.22 ? "bajista" : "lateral";
  return { votes, score, dir, strength: Math.max(0, Math.min(1, Math.abs(score) * 1.4)) };
}

// ---------- bundle completo ----------
export interface IndicatorBundle {
  emaFast: number[];
  emaSlow: number[];
  emaTrend: number[];
  macd: number[];
  signal: number[];
  hist: number[];
  rsi: number[];
  atr: number[];
  st: number[];      // línea Supertrend
  stUp: boolean[];   // true = tendencia alcista
  adx: number[];
  pdi: number[];
  mdi: number[];
  trend: TrendInfo;
  consensus: Consensus;
}

export function computeIndicators(
  candles: Candle[],
  cfg: IndicatorCfg,
  tfMinutes: number
): IndicatorBundle {
  const closes = candles.map((k) => k.c);
  const emaFast = emaSeries(closes, cfg.fast);
  const emaSlow = emaSeries(closes, cfg.slow);
  const emaTrend = emaSeries(closes, cfg.trend);
  const m = macdSeries(closes, cfg.macd[0], cfg.macd[1], cfg.macd[2]);
  const rsi = rsiSeries(closes, cfg.rsi);
  const atr = atrSeries(candles, cfg.atr);
  const stR = supertrendSeries(candles, cfg.atr, cfg.stMult);
  const adxR = adxSeries(candles, cfg.adx);
  const trend = classifyTrend(emaFast, emaSlow, tfMinutes);
  const consensus = buildConsensus(
    {
      emaFast,
      emaSlow,
      hist: m.hist,
      rsi,
      stUp: stR.up,
      adx: adxR.adx,
      pdi: adxR.pdi,
      mdi: adxR.mdi,
      atr,
    },
    cfg,
    tfMinutes
  );
  return {
    emaFast,
    emaSlow,
    emaTrend,
    macd: m.macd,
    signal: m.signal,
    hist: m.hist,
    rsi,
    atr,
    st: stR.line,
    stUp: stR.up,
    adx: adxR.adx,
    pdi: adxR.pdi,
    mdi: adxR.mdi,
    trend,
    consensus,
  };
}
