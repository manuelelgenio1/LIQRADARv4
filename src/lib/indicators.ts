// ============================================================
// Indicadores técnicos calibrados por temporalidad
// EMA rápida/lenta/tendencia · MACD · RSI · clasificación de tendencia
// ============================================================

export interface IndicatorCfg {
  fast: number;            // periodo EMA rápida (velas)
  slow: number;            // periodo EMA lenta (velas)
  trend: number;           // periodo EMA de tendencia de fondo
  macd: [number, number, number];
  rsi: number;
}

// Calibración por timeframe: cada temporalidad usa periodos que cubren
// horizontes equivalentes en tiempo real (no en número de velas).
export const TF_INDICATORS: Record<string, IndicatorCfg> = {
  "1m":  { fast: 9,  slow: 21, trend: 50,  macd: [12, 26, 9], rsi: 9  },
  "5m":  { fast: 12, slow: 26, trend: 60,  macd: [12, 26, 9], rsi: 14 },
  "15m": { fast: 14, slow: 30, trend: 70,  macd: [12, 26, 9], rsi: 14 },
  "1H":  { fast: 20, slow: 50, trend: 100, macd: [12, 26, 9], rsi: 14 },
  "4H":  { fast: 21, slow: 55, trend: 110, macd: [19, 39, 9], rsi: 14 },
  "1D":  { fast: 21, slow: 55, trend: 120, macd: [12, 26, 9], rsi: 14 },
  "1W":  { fast: 10, slow: 30, trend: 52,  macd: [8, 21, 5],  rsi: 10 },
};

export function getIndicatorCfg(tfKey: string): IndicatorCfg {
  return TF_INDICATORS[tfKey] ?? TF_INDICATORS["5m"];
}

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

export type TrendDir = "alcista" | "bajista" | "lateral";

export interface TrendInfo {
  dir: TrendDir;
  strength: number; // 0..1
}

// El umbral de separación entre EMAs escala con la volatilidad propia
// de la temporalidad: una 1W necesita más recorrido que una 1m.
export function classifyTrend(emaFast: number[], emaSlow: number[], tfMinutes: number): TrendInfo {
  const n = emaFast.length;
  if (!n) return { dir: "lateral", strength: 0 };
  const f = emaFast[n - 1];
  const s = emaSlow[n - 1] || 1;
  const rel = (f - s) / Math.abs(s);
  const thr = Math.min(0.03, 0.0006 * Math.sqrt(tfMinutes / 5));
  let dir: TrendDir = "lateral";
  if (rel > thr) dir = "alcista";
  else if (rel < -thr) dir = "bajista";
  const strength = Math.min(1, Math.abs(rel) / (thr * 3));
  return { dir, strength };
}

export interface IndicatorBundle {
  emaFast: number[];
  emaSlow: number[];
  emaTrend: number[];
  macd: number[];
  signal: number[];
  hist: number[];
  rsi: number[];
  trend: TrendInfo;
}

export function computeIndicators(closes: number[], cfg: IndicatorCfg, tfMinutes: number): IndicatorBundle {
  const emaFast = emaSeries(closes, cfg.fast);
  const emaSlow = emaSeries(closes, cfg.slow);
  const emaTrend = emaSeries(closes, cfg.trend);
  const m = macdSeries(closes, cfg.macd[0], cfg.macd[1], cfg.macd[2]);
  const rsi = rsiSeries(closes, cfg.rsi);
  const trend = classifyTrend(emaFast, emaSlow, tfMinutes);
  return { emaFast, emaSlow, emaTrend, ...m, rsi, trend };
}
