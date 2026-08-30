// ============================================================
// Indicadores de tendencia (funciones puras, sin side-effects)
// ============================================================
import type { Candle } from "./market";

export type TrendDir = "alcista" | "bajista" | "lateral";

export interface IndicatorCfg {
  fast: number;            // EMA rápida
  slow: number;            // EMA lenta
  trend: number;           // EMA de tendencia (fondo)
  macd: [number, number, number];
  rsi: number;
  atr: number;             // periodo ATR del Supertrend
  stMult: number;          // multiplicador del Supertrend
  adx: number;             // periodo del ADX
  adxThr?: number;         // umbral de régimen (default 25): ≥ = tendencia, < = rango
}

export const adxThrOf = (cfg: IndicatorCfg): number =>
  Number.isFinite(cfg.adxThr) && (cfg.adxThr as number) > 0 ? (cfg.adxThr as number) : 25;

// Calibración por temporalidad: cada timeframe cubre un horizonte distinto,
// así que los periodos se ajustan a lo que ese horizonte "ve".
export const TF_INDICATORS: Record<string, IndicatorCfg> = {
  "1m":  { fast: 9,  slow: 21, trend: 50,  macd: [12, 26, 9], rsi: 9,  atr: 10, stMult: 1.6, adx: 14 },
  "5m":  { fast: 12, slow: 26, trend: 50,  macd: [12, 26, 9], rsi: 12, atr: 10, stMult: 1.8, adx: 14 },
  "15m": { fast: 12, slow: 26, trend: 55,  macd: [12, 26, 9], rsi: 14, atr: 10, stMult: 2.0, adx: 14 },
  "1H":  { fast: 20, slow: 50, trend: 100, macd: [12, 26, 9], rsi: 14, atr: 12, stMult: 2.2, adx: 14 },
  "4H":  { fast: 21, slow: 55, trend: 120, macd: [19, 39, 9], rsi: 14, atr: 12, stMult: 2.6, adx: 14 },
  "1D":  { fast: 21, slow: 55, trend: 120, macd: [12, 26, 9], rsi: 14, atr: 14, stMult: 3.0, adx: 14 },
  "1W":  { fast: 10, slow: 30, trend: 60,  macd: [8, 21, 5],  rsi: 10, atr: 10, stMult: 3.2, adx: 10 },
};

export function getIndicatorCfg(tfKey: string): IndicatorCfg {
  return TF_INDICATORS[tfKey] ?? TF_INDICATORS["5m"];
}

// ---------- series ----------

export function emaSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(values[0] ?? 0);
  if (!values.length) return out;
  const k = 2 / (Math.max(1, period) + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function macdSeries(
  closes: number[],
  [fast, slow, sig]: [number, number, number]
): { macd: number[]; signal: number[]; hist: number[] } {
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
  const p = Math.max(1, period);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(0, ch), l = Math.max(0, -ch);
    if (i <= p) {
      avgG += g / p;
      avgL += l / p;
      if (i < p) continue;
    } else {
      avgG = (avgG * (p - 1) + g) / p;
      avgL = (avgL * (p - 1) + l) / p;
    }
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function atrSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out = new Array(n).fill(0);
  if (!n) return out;
  const p = Math.max(1, period);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const pc = i > 0 ? candles[i - 1].c : k.o;
    const tr = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    prev = i === 0 ? tr : (prev * (p - 1) + tr) / p;
    out[i] = prev;
  }
  return out;
}

export function supertrendSeries(
  candles: Candle[],
  period: number,
  mult: number
): { line: number[]; up: boolean[]; upConf: boolean[] } {
  const n = candles.length;
  const line = new Array(n).fill(0);
  const up = new Array(n).fill(true);
  if (!n) return { line, up, upConf: up };
  const atr = atrSeries(candles, period);
  let upper = Infinity, lower = -Infinity, trend = 1;
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const mid = (k.h + k.l) / 2;
    const band = mult * atr[i];
    const bu = mid + band, bl = mid - band;
    upper = bu < upper || k.c > upper ? bu : upper;
    lower = bl > lower || k.c < lower ? bl : lower;
    if (trend === 1 && k.c < lower) trend = -1;
    else if (trend === -1 && k.c > upper) trend = 1;
    const fl = trend === 1 ? lower : upper;
    const fu = trend === 1 ? upper : lower;
    line[i] = trend === 1 ? fl : fu;
    up[i] = trend === 1;
  }
  // Giros CONFIRMADOS: un cambio de dirección solo se acepta cuando persiste
  // (la vela siguiente mantiene el nuevo lado). Elimina los latigazos de 1 vela
  // que generan señales falsas en mercados laterales.
  const upConf = up.slice();
  let conf = up[0];
  upConf[0] = conf;
  for (let i = 1; i < n; i++) {
    if (up[i] === up[i - 1]) conf = up[i]; // persiste → se confirma
    upConf[i] = conf;
  }
  return { line, up, upConf };
}

export function adxSeries(
  candles: Candle[],
  period: number
): { adx: number[]; pdi: number[]; mdi: number[] } {
  const n = candles.length;
  const adx = new Array(n).fill(0);
  const pdi = new Array(n).fill(0);
  const mdi = new Array(n).fill(0);
  if (n < 2) return { adx, pdi, mdi };
  const p = Math.max(1, period);
  let sPdm = 0, sMdm = 0, sTr = 0, sDx = 0, adxPrev = 0;
  for (let i = 1; i < n; i++) {
    const k = candles[i], pk = candles[i - 1];
    const upMove = k.h - pk.h, downMove = pk.l - k.l;
    const pdm = upMove > downMove && upMove > 0 ? upMove : 0;
    const mdm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(k.h - k.l, Math.abs(k.h - pk.c), Math.abs(k.l - pk.c));
    if (i <= p) {
      sPdm += pdm; sMdm += mdm; sTr += tr;
      if (i < p) continue;
      const pd = sTr > 0 ? (sPdm / sTr) * 100 : 0;
      const md = sTr > 0 ? (sMdm / sTr) * 100 : 0;
      pdi[i] = pd; mdi[i] = md;
      const sum = pd + md;
      const dx = sum > 0 ? (Math.abs(pd - md) / sum) * 100 : 0;
      sDx = dx; adxPrev = dx; adx[i] = dx;
    } else {
      sPdm = sPdm - sPdm / p + pdm;
      sMdm = sMdm - sMdm / p + mdm;
      sTr = sTr - sTr / p + tr;
      const pd = sTr > 0 ? (sPdm / sTr) * 100 : 0;
      const md = sTr > 0 ? (sMdm / sTr) * 100 : 0;
      pdi[i] = pd; mdi[i] = md;
      const sum = pd + md;
      const dx = sum > 0 ? (Math.abs(pd - md) / sum) * 100 : 0;
      adxPrev = (adxPrev * (p - 1) + dx) / p;
      adx[i] = adxPrev;
    }
  }
  return { adx, pdi, mdi };
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
  dir: TrendDir;
  score: number;      // -1..1
  strength: number;   // 0..1 convicción
  votes: ConsensusVote[];
}

const last = (a: number[]): number => a[a.length - 1] ?? 0;
const fin = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

function buildConsensus(
  b: {
    emaFast: number[]; emaSlow: number[]; hist: number[]; rsi: number[];
    stUp: boolean[]; stUpConf: boolean[]; adx: number[]; pdi: number[]; mdi: number[]; atr: number[];
  },
  cfg: IndicatorCfg,
  tfMinutes: number
): Consensus {
  const votes: ConsensusVote[] = [];
  // umbral que separa "tendencia" de "ruido" escala con la volatilidad propia
  // de la temporalidad (una 1W exige más recorrido que una 1m)
  const tf = Number.isFinite(tfMinutes) && tfMinutes > 0 ? tfMinutes : 5;
  const thr = 0.0006 * Math.sqrt(tf / 5);

  // 1 · Cruce EMA (dirección + separación relativa)
  const ef = last(b.emaFast), es = last(b.emaSlow);
  const sep = Math.abs(ef - es) / Math.max(1e-9, Math.abs(es));
  votes.push({
    name: "Cruce EMA",
    note: `${cfg.fast}/${cfg.slow}`,
    weight: 1,
    dir: sep < thr * 0.5 ? "lateral" : ef > es ? "alcista" : "bajista",
    strength: fin(Math.min(1, sep / (thr * 4))),
  });

  // 2 · MACD (signo del histograma + expansión)
  const h = last(b.hist);
  const atrNow = last(b.atr) || 1;
  votes.push({
    name: "MACD",
    note: "histograma",
    weight: 1,
    dir: Math.abs(h) < atrNow * 0.03 ? "lateral" : h > 0 ? "alcista" : "bajista",
    strength: fin(Math.min(1, Math.abs(h) / (atrNow * 0.6))),
  });

  // 3 · RSI (posición respecto a 50; extremos = sobreextensión)
  const r = last(b.rsi);
  votes.push({
    name: "RSI",
    note: cfg.rsi.toString(),
    weight: 0.8,
    dir: Math.abs(r - 50) < 4 ? "lateral" : r > 50 ? "alcista" : "bajista",
    strength: fin(Math.abs(r - 50) / 30),
  });

  // 4 · Supertrend (giro CONFIRMADO: requiere persistencia, evita latigazos)
  const st = b.stUpConf[b.stUpConf.length - 1] ?? true;
  votes.push({
    name: "Supertrend",
    note: `ATR ${cfg.atr} × ${cfg.stMult}`,
    weight: 1.25,
    dir: st ? "alcista" : "bajista",
    strength: 1,
  });

  // 5 · ADX como filtro de fuerza (veta mercados en rango; umbral calibrable)
  const a = last(b.adx);
  const thrA = adxThrOf(cfg);
  const strong = a >= thrA;
  const p = last(b.pdi), m = last(b.mdi);
  votes.push({
    name: "ADX",
    note: strong ? `fuerza ${a.toFixed(0)}` : `débil · ${a.toFixed(0)}`,
    weight: 1.4,
    dir: !strong ? "lateral" : p > m ? "alcista" : "bajista",
    strength: fin(strong ? Math.min(1, a / 50) : (thrA - a) / thrA),
  });

  let score = 0, wSum = 0;
  for (const v of votes) {
    wSum += v.weight;
    score += v.weight * (v.dir === "alcista" ? v.strength : v.dir === "bajista" ? -v.strength : 0);
  }
  score = wSum > 0 ? score / wSum : 0;
  if (!Number.isFinite(score)) score = 0;

  let dir: TrendDir = "lateral";
  if (score > 0.12) dir = "alcista";
  else if (score < -0.12) dir = "bajista";
  const strength = fin(Math.abs(score) / 0.6);

  return { dir, score, strength, votes };
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
  st: number[];
  stUp: boolean[];
  stUpConf: boolean[];
  adx: number[];
  pdi: number[];
  mdi: number[];
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
      emaFast,
      emaSlow,
      hist: m.hist,
      rsi,
      stUp: stR.up,
      stUpConf: stR.upConf,
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
    stUpConf: stR.upConf,
    adx: adxR.adx,
    pdi: adxR.pdi,
    mdi: adxR.mdi,
    consensus,
  };
}

// ---------- precisión: semilla extendida ----------
// Recorta cada serie del bundle a las últimas `n` velas. Permite calcular los
// indicadores sobre 500 velas (semilla caliente) y alinear solo las últimas n
// al gráfico, eliminando el sesgo de arranque de EMA/ADX/ATR/Supertrend.
export function sliceIndicators(d: IndicatorBundle, n: number): IndicatorBundle {
  const sN = (a: number[]) => (a.length > n ? a.slice(-n) : a);
  const sB = (a: boolean[]) => (a.length > n ? a.slice(-n) : a);
  return {
    ...d,
    emaFast: sN(d.emaFast),
    emaSlow: sN(d.emaSlow),
    emaTrend: sN(d.emaTrend),
    macd: sN(d.macd),
    signal: sN(d.signal),
    hist: sN(d.hist),
    rsi: sN(d.rsi),
    atr: sN(d.atr),
    st: sN(d.st),
    stUp: sB(d.stUp),
    stUpConf: sB(d.stUpConf),
    adx: sN(d.adx),
    pdi: sN(d.pdi),
    mdi: sN(d.mdi),
  };
}

// ---------- precisión: ajuste por confluencia multi-timeframe ----------
// Un consenso alineado con las temporalidades superiores es más fiable;
// uno en contra recibe un castigo de convicción.
export interface MtfAdj {
  strength: number;         // convicción ajustada 0..1
  agree: number | null;     // TFs superiores que coinciden
  total: number | null;     // TFs evaluados
}
export function mtfAdjust(
  cons: Consensus,
  confluence: { dir: TrendDir }[] | null | undefined
): MtfAdj {
  if (!confluence || !confluence.length || cons.dir === "lateral") {
    return { strength: cons.strength, agree: null, total: null };
  }
  const agree = confluence.filter((c) => c.dir === cons.dir).length;
  const total = confluence.length;
  const ratio = agree / total;
  const strength = fin(cons.strength * (0.7 + 0.6 * ratio));
  return { strength, agree, total };
}
