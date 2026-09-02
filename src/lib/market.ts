// ============================================================
// Motor de mercado: estado, generación simulada, y funciones
// puras que inyectan datos 100% reales (velas, trades, liqs).
// ============================================================

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface Candle {
  t: number; o: number; h: number; l: number; c: number;
  v: number;
  delta: number;
}

export interface SymbolMeta {
  symbol: string;
  base: string;
  name: string;
  basePrice: number;
  decimals: number;
  vol: number;
  liqScale: number;
  bookBase: number;
}

export const SYMBOLS: SymbolMeta[] = [
  { symbol: "BTCUSDT", base: "BTC", name: "Bitcoin", basePrice: 97400, decimals: 1, vol: 0.0022, liqScale: 42, bookBase: 26 },
  { symbol: "ETHUSDT", base: "ETH", name: "Ethereum", basePrice: 3620, decimals: 2, vol: 0.0028, liqScale: 18, bookBase: 210 },
  { symbol: "SOLUSDT", base: "SOL", name: "Solana", basePrice: 216, decimals: 2, vol: 0.004, liqScale: 7, bookBase: 1500 },
  { symbol: "BNBUSDT", base: "BNB", name: "BNB", basePrice: 655, decimals: 2, vol: 0.0026, liqScale: 4, bookBase: 120 },
  { symbol: "XRPUSDT", base: "XRP", name: "XRP", basePrice: 2.31, decimals: 4, vol: 0.0038, liqScale: 6, bookBase: 85000 },
  { symbol: "DOGEUSDT", base: "DOGE", name: "Dogecoin", basePrice: 0.328, decimals: 5, vol: 0.0046, liqScale: 3.4, bookBase: 620000 },
];

export const TIMEFRAMES: { key: string; minutes: number }[] = [
  { key: "1m", minutes: 1 },
  { key: "5m", minutes: 5 },
  { key: "15m", minutes: 15 },
  { key: "1H", minutes: 60 },
  { key: "4H", minutes: 240 },
  { key: "1D", minutes: 1440 },
  { key: "1W", minutes: 10080 },
];

export const CANDLE_COUNT = 128;
export const HEAT_BINS = 48;
export const CHART_CLUSTER_LIMIT = 6;
export const RADAR_CLUSTER_LIMIT = 12;

export interface LiqCluster {
  id: string;
  price: number;
  side: "long" | "short";
  sizeUsd: number;
  strength: number;
  leverage: string;
  exchange: string;
}

export interface BookLevel {
  price: number;
  size: number;
  total: number;
  exchange: string;
  isWall: boolean;
}

export interface LiquidationEvent {
  id: string;
  time: number;
  symbol: string;
  side: "long" | "short";
  price: number;
  qtyUsd: number;
  exchange: string;
  isReal: boolean;
}

export interface MarketState {
  meta: SymbolMeta;
  tfMinutes: number;
  candles: Candle[];
  warm?: Candle[];
  heat: Float32Array;
  heatMax: number;
  cvd: number[];
  pMin: number;
  pMax: number;
  clusters: LiqCluster[];
  bids: BookLevel[];
  asks: BookLevel[];
  imbalance: number;
  spoofing: number;
  funding: number;
  fundingNextMs: number;
  oi: number;
  oiDelta1h: number;
  longShortRatio: number;
  events: LiquidationEvent[];
  totalLiq24hLong: number;
  totalLiq24hShort: number;
  latency: number[];
  msgsPerSec: number;
  uptimePct: number;
  now: number;
}

const EXCHANGES = ["Binance", "Bybit", "OKX"];

// Apalancamiento según la distancia como FRACCIÓN del rango visible:
// cerca del precio → x100, lejos → x5.
export function levFromFrac(frac: number): string {
  if (frac < 0.12) return "x100";
  if (frac < 0.24) return "x50";
  if (frac < 0.36) return "x20";
  if (frac < 0.48) return "x10";
  return "x5";
}

export function deriveClusters(
  meta: SymbolMeta,
  candles: Candle[],
  heat: Float32Array,
  heatMax: number,
  pMin: number,
  pMax: number
): LiqCluster[] {
  const lastC = candles[candles.length - 1]?.c ?? 0;
  const span = pMax - pMin || 1;
  const hm = heatMax >= 1 ? heatMax : 1;

  const profile = new Float64Array(HEAT_BINS);
  const from = Math.max(0, candles.length - 40);
  for (let i = from; i < candles.length; i++)
    for (let b = 0; b < HEAT_BINS; b++) profile[b] += heat[i * HEAT_BINS + b];

  // máximos locales del perfil (clusters reales derivados del calor)
  const peaks: { bin: number; v: number }[] = [];
  for (let b = 1; b < HEAT_BINS - 1; b++) {
    if (profile[b] > profile[b - 1] && profile[b] >= profile[b + 1] && profile[b] > hm * 0.42) {
      peaks.push({ bin: b, v: profile[b] });
    }
  }
  peaks.sort((a, z) => z.v - a.v);

  const clusters: LiqCluster[] = [];
  for (const p of peaks) {
    const price = pMin + ((p.bin + 0.5) / HEAT_BINS) * span;
    const frac = Math.abs(price - lastC) / span;
    if (frac < 0.05) continue;
    const side: "long" | "short" = price < lastC ? "long" : "short";
    clusters.push({
      id: `cl-${meta.symbol}-${p.bin}`,
      price,
      side,
      sizeUsd: p.v * meta.liqScale * 1e6 * (1.6 + frac * 6),
      strength: Math.min(1, p.v / hm),
      leverage: levFromFrac(frac),
      exchange: EXCHANGES[p.bin % 3],
    });
    if (clusters.length >= 9) break;
  }

  // Garantiza al menos un clúster en CADA banda de apalancamiento (x100…x5)
  // por lado: rellena solo las bandas que el calor no haya producido.
  // Los centros caen dentro de los rangos de levFromFrac (jitter acotado ±0.03).
  const LEV_BANDS = [
    { lev: "x100", frac: 0.07 },
    { lev: "x50", frac: 0.16 },
    { lev: "x20", frac: 0.27 },
    { lev: "x10", frac: 0.39 },
    { lev: "x5", frac: 0.52 },
  ];
  const ensure = (side: "long" | "short") => {
    for (const band of LEV_BANDS) {
      if (clusters.some((c) => c.side === side && c.leverage === band.lev)) continue;
      const frac = band.frac + (((hashStr(meta.symbol + side + band.lev) % 100) / 100) - 0.5) * 0.06;
      const offset = frac * span;
      const price = side === "long" ? lastC - offset : lastC + offset;
      clusters.push({
        id: `sy-${meta.symbol}-${side}-${band.lev}`,
        price,
        side,
        sizeUsd: meta.liqScale * 1e6 * (0.5 + ((hashStr(meta.symbol + side + band.lev) % 100) / 100) * 1.3),
        strength: 0.4 + ((hashStr(side + band.lev + meta.symbol) % 100) / 100) * 0.45,
        leverage: band.lev,
        exchange: EXCHANGES[hashStr(band.lev + side) % 3],
      });
    }
  };
  ensure("long");
  ensure("short");

  clusters.sort((a, z) => Math.abs(a.price - lastC) - Math.abs(z.price - lastC));
  return clusters;
}

// ---------- calor de liquidaciones ----------
function seedHeat(candles: Candle[], pMin: number, pMax: number, rand: () => number): Float32Array {
  const heat = new Float32Array(CANDLE_COUNT * HEAT_BINS);
  const span = pMax - pMin || 1;
  const binOf = (p: number) =>
    Math.max(0, Math.min(HEAT_BINS - 1, Math.round(((p - pMin) / span) * (HEAT_BINS - 1))));
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const w = Math.max(1e-9, k.v);
    for (const px of [k.h, k.l]) {
      const bin = binOf(px);
      for (let db = -2; db <= 2; db++) {
        const b = bin + db;
        if (b >= 0 && b < HEAT_BINS) heat[i * HEAT_BINS + b] += w * Math.exp(-(db * db) / 2);
      }
    }
    const mid = binOf((k.h + k.l) / 2);
    heat[i * HEAT_BINS + mid] += w * 0.25;
    if (rand() < 0.4) {
      const b = Math.floor(rand() * HEAT_BINS);
      heat[i * HEAT_BINS + b] += w * rand() * 0.5;
    }
  }
  return heat;
}

function rebinHeat(heat: Float32Array, oldMin: number, oldMax: number, newMin: number, newMax: number): Float32Array {
  if (oldMax - oldMin <= 0 || newMax - newMin <= 0) return heat;
  const out = new Float32Array(heat.length);
  for (let i = 0; i < CANDLE_COUNT; i++) {
    for (let b = 0; b < HEAT_BINS; b++) {
      const price = newMin + ((b + 0.5) / HEAT_BINS) * (newMax - newMin);
      const oldF = ((price - oldMin) / (oldMax - oldMin)) * (HEAT_BINS - 1);
      if (oldF < 0 || oldF > HEAT_BINS - 1) continue;
      const b0 = Math.floor(oldF);
      const b1 = Math.min(HEAT_BINS - 1, b0 + 1);
      const f = oldF - b0;
      out[i * HEAT_BINS + b] = heat[i * HEAT_BINS + b0] * (1 - f) + heat[i * HEAT_BINS + b1] * f;
    }
  }
  return out;
}

function jitterBook(meta: SymbolMeta, lastC: number, rand: () => number, dirUp: boolean): BookLevel[] {
  let total = 0;
  const levels: BookLevel[] = [];
  for (let i = 0; i < 15; i++) {
    const size =
      meta.bookBase * (0.6 + rand() * 2.4) * (1 + i * 0.12) +
      (rand() < 0.06 ? meta.bookBase * (4 + rand() * 6) : 0);
    total += size;
    levels.push({
      price: dirUp ? lastC + (i + 1) * lastC * 0.00045 : lastC - (i + 1) * lastC * 0.00045,
      size,
      total,
      exchange: EXCHANGES[i % 3],
      isWall: false,
    });
  }
  const med = [...levels].sort((a, b) => a.size - b.size)[7].size;
  for (const l of levels) l.isWall = l.size > med * 2.8;
  return levels;
}

function generateCandles(meta: SymbolMeta, tfMinutes: number, seed: number): Candle[] {
  const rand = mulberry32(seed);
  const tfScale = Math.sqrt(tfMinutes / 5);
  const vol = meta.vol * tfScale;
  const out: Candle[] = [];
  let price = meta.basePrice * (0.92 + rand() * 0.16);
  const now = Date.now();
  const stepMs = tfMinutes * 60_000;
  let trend = 0;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    if (rand() < 0.12) trend = (rand() - 0.5) * vol * 1.4;
    const o = price;
    const shock = rand() < 0.05 ? (rand() - 0.5) * vol * 6 : 0;
    const drift = Math.max(-0.16, Math.min(0.16, trend + (rand() - 0.5) * vol * 2.1 + shock));
    const c = o * (1 + drift);
    const wickF = Math.min(vol * 0.9, 0.06);
    const h = Math.max(o, c) * (1 + rand() * wickF);
    const l = Math.min(o, c) * (1 - rand() * wickF);
    const v = meta.bookBase * (6 + rand() * 30) * (1 + Math.abs(drift) / vol);
    const delta = (c >= o ? 1 : -1) * v * (0.15 + rand() * 0.5);
    out.push({ t: now - (CANDLE_COUNT - 1 - i) * stepMs, o, h, l, c, v, delta });
    price = c;
  }
  return out;
}

export function deriveState(meta: SymbolMeta, tfMinutes: number, candles: Candle[], seed: number): MarketState {
  const rand = mulberry32(seed + 99);
  let lo = Infinity, hi = -Infinity;
  for (const k of candles) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  const pad = (hi - lo) * 0.045 || 1;
  const pMin = lo - pad, pMax = hi + pad;

  const heat = seedHeat(candles, pMin, pMax, rand);
  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) heatMax = Math.max(heatMax, heat[i]);
  if (heatMax <= 0) heatMax = 1;

  const clusters = deriveClusters(meta, candles, heat, heatMax, pMin, pMax);

  let acc = 0;
  const cvd = candles.map((k) => (acc += k.delta));

  const lastC = candles[candles.length - 1].c;
  const bids = jitterBook(meta, lastC, rand, false);
  const asks = jitterBook(meta, lastC, rand, true);
  const bidSum = bids[bids.length - 1].total;
  const askSum = asks[asks.length - 1].total;

  const now = Date.now();
  const events: LiquidationEvent[] = [];
  for (let i = 0; i < 14; i++) {
    const side: "long" | "short" = rand() > 0.5 ? "long" : "short";
    const qtyUsd = meta.liqScale * 1e3 * (8 + rand() * rand() * 1400);
    events.push({
      id: `seed-${seed}-${i}`,
      time: now - Math.floor(rand() * 9 * 60_000),
      symbol: meta.symbol,
      side,
      price: lastC * (1 + (rand() - 0.5) * 0.004),
      qtyUsd,
      exchange: EXCHANGES[Math.floor(rand() * 3)],
      isReal: false,
    });
  }
  events.sort((a, b) => b.time - a.time);

  return {
    meta,
    tfMinutes,
    candles,
    heat,
    heatMax,
    cvd,
    pMin,
    pMax,
    clusters,
    bids,
    asks,
    imbalance: (bidSum - askSum) / (bidSum + askSum),
    spoofing: 12 + rand() * 60,
    funding: (rand() - 0.42) * 0.05,
    fundingNextMs: rand() * 8 * 3600_000,
    oi: meta.basePrice * meta.bookBase * (900 + rand() * 500) * 1000,
    oiDelta1h: (rand() - 0.45) * 3,
    longShortRatio: 0.8 + rand() * 0.6,
    events,
    totalLiq24hLong: meta.liqScale * 1e6 * (1.2 + rand() * 2.4),
    totalLiq24hShort: meta.liqScale * 1e6 * (1.2 + rand() * 2.4),
    latency: Array.from({ length: 30 }, () => 12 + rand() * 40),
    msgsPerSec: 180 + rand() * 420,
    uptimePct: 99.55 + rand() * 0.43,
    now,
  };
}

export function generateMarket(meta: SymbolMeta, tfMinutes: number, seed: number): MarketState {
  return deriveState(meta, tfMinutes, generateCandles(meta, tfMinutes, seed), seed);
}

export function marketFromKlines(meta: SymbolMeta, tfMinutes: number, klines: Candle[], seed: number): MarketState {
  if (!klines.length) throw new Error("sin velas");
  const candles = klines.slice(-CANDLE_COUNT);
  const st = deriveState(meta, tfMinutes, candles, seed);
  return { ...st, warm: klines };
}

export function applyLiveTick(s: MarketState, price: number, tfMinutes: number): MarketState {
  if (!Number.isFinite(price) || price <= 0) return s;
  const now = Date.now();
  const stepMs = tfMinutes * 60_000;
  const candles = s.candles.slice();
  const last = { ...candles[candles.length - 1] };
  let rolled = false;
  if (now - last.t >= stepMs) {
    rolled = true;
    candles.shift();
    candles.push({ t: Math.floor(now / stepMs) * stepMs, o: price, h: price, l: price, c: price, v: 0, delta: 0 });
  } else {
    last.c = price;
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    candles[candles.length - 1] = last;
  }

  let warm = s.warm;
  if (warm && warm.length) {
    const w = warm.slice();
    if (rolled) {
      w.push({ t: Math.floor(now / stepMs) * stepMs, o: price, h: price, l: price, c: price, v: 0, delta: 0 });
      if (w.length > 700) w.shift();
    } else {
      const wl = { ...w[w.length - 1] };
      wl.c = price;
      wl.h = Math.max(wl.h, price);
      wl.l = Math.min(wl.l, price);
      w[w.length - 1] = wl;
    }
    warm = w;
  }

  let pMin = s.pMin, pMax = s.pMax;
  const span = pMax - pMin || 1;
  if (price < pMin) pMin = price - span * 0.05;
  if (price > pMax) pMax = price + span * 0.05;

  let heat = s.heat;
  if (pMin !== s.pMin || pMax !== s.pMax) {
    heat = rebinHeat(s.heat, s.pMin, s.pMax, pMin, pMax);
  }

  let cvd = s.cvd;
  if (rolled) {
    cvd = s.cvd.slice();
    cvd.shift();
    cvd.push(cvd[cvd.length - 1]);
  }

  return { ...s, candles, warm, heat, cvd, pMin, pMax, now };
}

export function mergeLiveKlines(s: MarketState, klines: Candle[]): MarketState {
  if (!klines.length) return s;
  const byT = new Map(klines.map((k) => [k.t, k]));
  const lastT = s.candles[s.candles.length - 1].t;
  const added = klines.filter((k) => k.t > lastT).slice(-CANDLE_COUNT);
  let candles = s.candles.map((k) => byT.get(k.t) ?? k);
  let heat = s.heat;
  const cvd = s.cvd.slice();
  if (added.length) {
    candles = [...candles.slice(added.length), ...added];
    heat = new Float32Array(s.heat);
    heat.copyWithin(0, added.length * HEAT_BINS);
    for (let c = CANDLE_COUNT - added.length; c < CANDLE_COUNT; c++)
      for (let b = 0; b < HEAT_BINS; b++) heat[c * HEAT_BINS + b] = 0;
    for (let i = 0; i < added.length; i++) {
      cvd.shift();
      cvd.push(cvd[cvd.length - 1]);
    }
  }
  cvd[cvd.length - 1] = cvd[cvd.length - 2] + candles[candles.length - 1].delta;

  let lo = Infinity, hi = -Infinity;
  for (const k of candles) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  const pad = (hi - lo) * 0.045 || 1;
  const pMin = lo - pad, pMax = hi + pad;
  heat = rebinHeat(heat, s.pMin, s.pMax, pMin, pMax);
  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) heatMax = Math.max(heatMax, heat[i]);
  if (heatMax <= 0) heatMax = 1;
  const clusters = deriveClusters(s.meta, candles, heat, heatMax, pMin, pMax);

  return { ...s, candles, heat, heatMax, cvd, pMin, pMax, clusters, now: Date.now() };
}

export function tickMarket(s: MarketState, opts?: { drift?: boolean; latencyMs?: number }): MarketState {
  const withDrift = opts?.drift !== false;
  const rand = mulberry32(hashStr(s.meta.symbol) + s.now);
  const now = Date.now();
  const meta = s.meta;
  const candles = s.candles;
  const last = candles[candles.length - 1];
  const lastC = last.c;

  let pMin = s.pMin, pMax = s.pMax;
  let heat = s.heat;
  let clusters = s.clusters;
  let events = s.events;
  let totalLiq24hLong = s.totalLiq24hLong;
  let totalLiq24hShort = s.totalLiq24hShort;

  if (withDrift) {
    const span = pMax - pMin || 1;
    const fb = ((lastC - pMin) / span) * (HEAT_BINS - 1);
    const ci = candles.length - 1;
    heat = new Float32Array(s.heat);
    for (let i = 0; i < heat.length; i++) heat[i] *= 0.9988;
    for (let db = -3; db <= 3; db++) {
      const bb = Math.round(fb) + db;
      if (bb >= 0 && bb < HEAT_BINS) {
        heat[ci * HEAT_BINS + bb] += meta.bookBase * (0.5 + rand()) * Math.exp(-(db * db) / 2);
      }
    }
    let heatMax = 0;
    for (let i = 0; i < heat.length; i++) heatMax = Math.max(heatMax, heat[i]);
    if (heatMax <= 0) heatMax = s.heatMax || 1;

    const stepMs = s.tfMinutes * 60_000;
    if (now - last.t >= stepMs) {
      const vol = meta.vol * Math.sqrt(s.tfMinutes / 5);
      const c = lastC * (1 + (rand() - 0.5) * vol * 2);
      const nc: Candle = {
        t: Math.floor(now / stepMs) * stepMs,
        o: lastC,
        h: Math.max(lastC, c),
        l: Math.min(lastC, c),
        c,
        v: meta.bookBase * (6 + rand() * 20),
        delta: (c >= lastC ? 1 : -1) * meta.bookBase * (2 + rand() * 8),
      };
      const shifted = candles.slice(1);
      shifted.push(nc);
      heat = new Float32Array(heat);
      heat.copyWithin(0, HEAT_BINS);
      for (let b = 0; b < HEAT_BINS; b++) heat[(CANDLE_COUNT - 1) * HEAT_BINS + b] = 0;
      let hm = 0;
      for (let i = 0; i < heat.length; i++) hm = Math.max(hm, heat[i]);
      const newCvd = s.cvd.slice(1);
      newCvd.push(newCvd[newCvd.length - 1] + nc.delta);
      clusters = deriveClusters(meta, shifted, heat, hm || 1, pMin, pMax);
      return {
        ...s,
        candles: shifted,
        heat,
        heatMax: hm || s.heatMax,
        cvd: newCvd,
        clusters,
        events: maybeLiqEvent(s, rand, now),
        totalLiq24hLong,
        totalLiq24hShort,
        latency: pushLatency(s, opts?.latencyMs, rand),
        msgsPerSec: Math.max(40, s.msgsPerSec + (rand() - 0.5) * 22),
        fundingNextMs: s.fundingNextMs <= 700 ? 8 * 3600_000 : s.fundingNextMs - 700,
        now,
      };
    }
    clusters = deriveClusters(meta, candles, heat, heatMax, pMin, pMax);
    events = maybeLiqEvent(s, rand, now);
  }

  let bids = s.bids, asks = s.asks, imbalance = s.imbalance, spoofing = s.spoofing;
  let funding = s.funding, oi = s.oi, oiDelta1h = s.oiDelta1h, longShortRatio = s.longShortRatio;
  if (withDrift) {
    bids = jitterBook(meta, lastC, rand, false);
    asks = jitterBook(meta, lastC, rand, true);
    const bidSum = bids[bids.length - 1].total;
    const askSum = asks[asks.length - 1].total;
    imbalance = (bidSum - askSum) / (bidSum + askSum);
    spoofing = Math.min(97, Math.max(8, s.spoofing + (rand() - 0.5) * 5));
    funding = Math.max(-0.09, Math.min(0.09, s.funding + (rand() - 0.5) * 0.0016));
    oi = s.oi * (1 + (rand() - 0.47) * 0.0035);
    oiDelta1h = s.oiDelta1h + (rand() - 0.5) * 0.12;
    longShortRatio = Math.min(1.9, Math.max(0.55, s.longShortRatio + (rand() - 0.5) * 0.02));
  }

  return {
    ...s,
    candles,
    heat,
    pMin,
    pMax,
    clusters,
    bids,
    asks,
    imbalance,
    spoofing,
    funding,
    fundingNextMs: s.fundingNextMs <= 700 ? 8 * 3600_000 : s.fundingNextMs - 700,
    oi,
    oiDelta1h,
    longShortRatio,
    events,
    totalLiq24hLong,
    totalLiq24hShort,
    latency: pushLatency(s, opts?.latencyMs, rand),
    msgsPerSec: Math.max(40, s.msgsPerSec + (rand() - 0.5) * 22),
    now,
  };
}

function pushLatency(s: MarketState, real: number | undefined, rand: () => number): number[] {
  const lat = s.latency.slice();
  lat.push(real != null && Number.isFinite(real) && real >= 0 && real < 3000 ? real : 12 + rand() * 40);
  if (lat.length > 40) lat.shift();
  return lat;
}

function maybeLiqEvent(s: MarketState, rand: () => number, now: number): LiquidationEvent[] {
  if (rand() >= 0.42) return s.events;
  const side: "long" | "short" = rand() > 0.5 ? "long" : "short";
  const lastC = s.candles[s.candles.length - 1].c;
  const qtyUsd = s.meta.liqScale * 1e3 * (8 + rand() * rand() * 1600);
  const ev: LiquidationEvent = {
    id: `sim-${now}-${Math.floor(rand() * 1e6)}`,
    time: now,
    symbol: s.meta.symbol,
    side,
    price: lastC * (1 + (rand() - 0.5) * 0.003),
    qtyUsd,
    exchange: EXCHANGES[Math.floor(rand() * 3)],
    isReal: false,
  };
  return [ev, ...s.events].slice(0, 60);
}

export function applyTradeFlow(s: MarketState, delta: number): MarketState {
  if (!Number.isFinite(delta) || delta === 0) return s;
  const candles = s.candles.slice();
  const last = { ...candles[candles.length - 1] };
  last.delta += delta;
  last.v += Math.abs(delta) / Math.max(1e-9, last.c);
  candles[candles.length - 1] = last;
  const cvd = s.cvd.slice();
  cvd[cvd.length - 1] += delta;
  return { ...s, candles, cvd };
}

export function injectLiqEvents(s: MarketState, evts: Omit<LiquidationEvent, "isReal">[]): MarketState {
  if (!evts.length) return s;
  const fresh: LiquidationEvent[] = evts.map((e) => ({ ...e, isReal: true }));
  const events = [...fresh, ...s.events].slice(0, 60);
  let tl = s.totalLiq24hLong, ts = s.totalLiq24hShort;
  for (const e of fresh) {
    if (e.side === "long") tl += e.qtyUsd;
    else ts += e.qtyUsd;
  }
  return { ...s, events, totalLiq24hLong: tl, totalLiq24hShort: ts };
}
