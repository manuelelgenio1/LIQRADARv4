// ============================================================
// Motor de mercado: simulación realista + funciones puras para
// incorporar datos reales (velas, trades, liquidaciones OKX).
// ============================================================

export const HEAT_BINS = 92;
export const CANDLE_COUNT = 128;

export interface SymbolMeta {
  symbol: string;   // BTCUSDT
  base: string;     // BTC
  name: string;
  basePrice: number;
  decimals: number;
  vol: number;        // volatilidad por vela (fracción)
  bookBase: number;   // tamaño base de órdenes
  liqScale: number;   // escala de liquidaciones (millones)
}

export const SYMBOLS: SymbolMeta[] = [
  { symbol: "BTCUSDT",  base: "BTC",  name: "Bitcoin",   basePrice: 67400, decimals: 1, vol: 0.0038, bookBase: 18,  liqScale: 3.4 },
  { symbol: "ETHUSDT",  base: "ETH",  name: "Ethereum",  basePrice: 3520,  decimals: 2, vol: 0.0046, bookBase: 120, liqScale: 2.1 },
  { symbol: "SOLUSDT",  base: "SOL",  name: "Solana",    basePrice: 172.4, decimals: 2, vol: 0.0062, bookBase: 900, liqScale: 1.2 },
  { symbol: "BNBUSDT",  base: "BNB",  name: "BNB",       basePrice: 598.2, decimals: 2, vol: 0.0042, bookBase: 60,  liqScale: 0.7 },
  { symbol: "XRPUSDT",  base: "XRP",  name: "XRP",       basePrice: 0.523, decimals: 4, vol: 0.0058, bookBase: 9000, liqScale: 0.8 },
  { symbol: "DOGEUSDT", base: "DOGE", name: "Dogecoin",  basePrice: 0.158, decimals: 5, vol: 0.0070, bookBase: 40000, liqScale: 0.5 },
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

export interface Candle {
  t: number; o: number; h: number; l: number; c: number;
  v: number;       // volumen
  delta: number;   // volumen comprador − vendedor
}

export interface BookLevel {
  price: number;
  size: number;
  total: number;
  exchange: string;
  isWall: boolean;
}

export interface LiqEvent {
  id: string;
  time: number;
  symbol: string;
  side: "long" | "short";
  price: number;
  qtyUsd: number;
  exchange: string;
}

export interface LiquidationEvent {
  id: string;
  time: number;
  symbol: string;
  side: "long" | "short";
  price: number;
  qtyUsd: number;
  exchange: string;
  // true SOLO si el evento llegó por el websocket real de liquidaciones (OKX).
  // Los eventos del modelo son estimaciones y siempre llevan false, aunque el
  // exchange mostrado sea "OKX". La UI filtra por este campo, no por exchange.
  isReal: boolean;
}

export interface LiqCluster {
  id: string;
  price: number;
  side: "long" | "short";
  sizeUsd: number;
  strength: number;
  leverage: string;
  exchange: string;
}

export interface MarketState {
  meta: SymbolMeta;
  tfMinutes: number;
  candles: Candle[];
  // serie extendida (hasta 500 velas reales) usada SOLO como semilla de los
  // indicadores; el gráfico dibuja `candles` (últimas CANDLE_COUNT).
  warm?: Candle[];
  heat: Float32Array;
  heatMax: number;
  pMin: number;
  pMax: number;
  cvd: number[];
  bids: BookLevel[];
  asks: BookLevel[];
  imbalance: number;
  spoofing: number;
  funding: number;
  fundingNextMs: number;
  oi: number;
  oiDelta1h: number;
  longShortRatio: number;
  clusters: LiqCluster[];
  events: LiquidationEvent[];
  latency: number[];
  msgsPerSec: number;
  uptimePct: number;
  totalLiq24hLong: number;
  totalLiq24hShort: number;
  change24h: number;
  now: number;
}

// ---------- utils ----------

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXCHANGES = ["Binance", "Bybit", "OKX"];
const LEVERAGES = ["x5", "x10", "x20", "x25", "x50", "x100"];

// ---------- generación de velas ----------

function generateCandles(meta: SymbolMeta, tfMinutes: number, seed: number): Candle[] {
  const rand = mulberry32(seed);
  const now = Date.now();
  const stepMs = tfMinutes * 60_000;
  const candles: Candle[] = [];
  let price = meta.basePrice * (0.92 + rand() * 0.16);
  let trend = (rand() - 0.5) * meta.vol * 0.5;
  const vol = meta.vol * Math.sqrt(tfMinutes / 5);

  for (let i = 0; i < CANDLE_COUNT; i++) {
    if (rand() < 0.06) trend = (rand() - 0.5) * meta.vol * 0.8;
    const o = price;
    const shock = rand() < 0.05 ? (rand() - 0.5) * vol * 6 : 0;
    // deriva limitada a ±16% por vela (evita velas absurdas en 1D/1W)
    const drift = Math.max(-0.16, Math.min(0.16, trend + (rand() - 0.5) * vol * 2.1 + shock));
    const c = o * (1 + drift);
    const wickF = Math.min(vol * 0.9, 0.06);
    const h = Math.max(o, c) * (1 + rand() * wickF);
    const l = Math.min(o, c) * (1 - rand() * wickF);
    const v = meta.bookBase * (30 + rand() * 90) * (1 + Math.abs(drift) * 120);
    const delta = v * (drift >= 0 ? 0.2 + rand() * 0.5 : -(0.2 + rand() * 0.5));
    candles.push({ t: now - (CANDLE_COUNT - 1 - i) * stepMs, o, h, l, c, v, delta });
    price = c;
  }
  return candles;
}

// ---------- calor de liquidaciones ----------

function seedHeat(candles: Candle[], pMin: number, pMax: number, rand: () => number, liqScale: number): Float32Array {
  const heat = new Float32Array(CANDLE_COUNT * HEAT_BINS);
  const span = pMax - pMin;
  // clusters sintéticos de liquidez
  const nClusters = 10 + Math.floor(rand() * 6);
  const clusters: { bin: number; w: number; power: number }[] = [];
  for (let i = 0; i < nClusters; i++) {
    clusters.push({
      bin: 3 + Math.floor(rand() * (HEAT_BINS - 6)),
      w: 0.6 + rand() * 1.6,
      power: (0.35 + rand() * 0.65) * liqScale,
    });
  }
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const k = candles[i];
    for (const cl of clusters) {
      const center = pMin + ((cl.bin + 0.5) / HEAT_BINS) * span;
      const distBins = Math.abs(center - (k.h + k.l) / 2) / (span / HEAT_BINS);
      if (distBins > 26) continue;
      const decay = Math.exp(-distBins / 9);
      const base = cl.power * decay * (0.55 + rand() * 0.9);
      for (let db = -3; db <= 3; db++) {
        const b = cl.bin + db;
        if (b < 0 || b >= HEAT_BINS) continue;
        heat[i * HEAT_BINS + b] += base * Math.exp(-(db * db) / (2 * cl.w * cl.w));
      }
    }
    // calor alrededor de mechas (stops cazados)
    const wickBins = Math.max(1, Math.round(((k.h - k.l) / span) * HEAT_BINS * 1.4));
    const midBin = Math.round((((k.h + k.l) / 2 - pMin) / span) * (HEAT_BINS - 1));
    for (let db = -wickBins; db <= wickBins; db++) {
      const b = midBin + db;
      if (b < 0 || b >= HEAT_BINS) continue;
      heat[i * HEAT_BINS + b] += 0.05 * liqScale * Math.exp(-(db * db) / (wickBins + 1));
    }
  }
  return heat;
}

// ---------- clústeres ----------

export function deriveClusters(
  meta: SymbolMeta,
  candles: Candle[],
  heat: Float32Array,
  pMin: number,
  pMax: number,
  heatMax: number
): LiqCluster[] {
  const lastC = candles[candles.length - 1].c;
  const span = pMax - pMin || 1;
  // perfil vertical reciente (últimas 14 velas)
  const W = 14;
  const profile = new Float64Array(HEAT_BINS);
  for (let i = CANDLE_COUNT - W; i < CANDLE_COUNT; i++)
    for (let b = 0; b < HEAT_BINS; b++) profile[b] += heat[i * HEAT_BINS + b];
  for (let b = 0; b < HEAT_BINS; b++) profile[b] /= W;

  const peaks: { bin: number; v: number }[] = [];
  for (let b = 2; b < HEAT_BINS - 2; b++) {
    const v = profile[b];
    // máximo local genuino (no mesetas) → menos falsos clústeres
    if (v > heatMax * 0.42 && v >= profile[b - 1] && v >= profile[b + 1] && v > profile[b - 2] && v > profile[b + 2]) {
      peaks.push({ bin: b, v });
    }
  }
  peaks.sort((a, z) => z.v - a.v);

  const clusters: LiqCluster[] = [];
  const used: number[] = [];
  for (const p of peaks) {
    if (used.some((u) => Math.abs(u - p.bin) < 4)) continue;
    used.push(p.bin);
    const price = pMin + ((p.bin + 0.5) / HEAT_BINS) * span;
    if (Math.abs(price - lastC) / lastC < 0.0018) continue;
    const side: "long" | "short" = price < lastC ? "long" : "short";
    const distPct = Math.abs(price - lastC) / lastC;
    const lev =
      distPct < 0.012 ? "x100" : distPct < 0.025 ? "x50" : distPct < 0.055 ? "x20" : distPct < 0.11 ? "x10" : "x5";
    clusters.push({
      id: `cl-${meta.symbol}-${p.bin}`,
      price,
      side,
      sizeUsd: p.v * meta.liqScale * 1e6 * (1.6 + distPct * 10),
      strength: Math.min(1, p.v / heatMax),
      leverage: lev,
      exchange: EXCHANGES[p.bin % 3],
    });
    if (clusters.length >= 9) break;
  }

  // garantía: al menos 3 piscinas a cada lado del precio
  const ensure = (side: "long" | "short", count: number) => {
    const have = clusters.filter((c) => c.side === side).length;
    for (let i = 0; i < count - have; i++) {
      const distPct = 0.006 + ((i + 1) * 0.011 + (hashStr(meta.symbol + side + i) % 100) / 100 * 0.006);
      const price = side === "long" ? lastC * (1 - distPct) : lastC * (1 + distPct);
      const lev = distPct < 0.012 ? "x100" : distPct < 0.025 ? "x50" : distPct < 0.055 ? "x20" : "x10";
      clusters.push({
        id: `sy-${meta.symbol}-${side}-${i}`,
        price,
        side,
        sizeUsd: meta.liqScale * 1e6 * (0.5 + ((hashStr(meta.symbol + side + i) % 100) / 100) * 1.3),
        strength: 0.4 + ((hashStr(side + i + meta.symbol) % 100) / 100) * 0.45,
        leverage: lev,
        exchange: EXCHANGES[(i + 1) % 3],
      });
    }
  };
  ensure("long", 3);
  ensure("short", 3);

  return clusters.sort((a, z) => Math.abs(a.price - lastC) - Math.abs(z.price - lastC));
}

// ---------- derivación del estado ----------

function genBook(meta: SymbolMeta, lastC: number, rand: () => number): { bids: BookLevel[]; asks: BookLevel[]; imbalance: number; spoofing: number } {
  const mk = (dirUp: boolean): BookLevel[] => {
    let total = 0;
    return Array.from({ length: 15 }, (_, i) => {
      const price = dirUp ? lastC * (1 + (i + 1) * 0.00045) : lastC * (1 - (i + 1) * 0.00045);
      let size = meta.bookBase * (0.4 + rand() * 1.4);
      if (rand() < 0.12) size *= 3.2 + rand() * 2.4; // muro
      total += size;
      return { price, size, total, exchange: EXCHANGES[i % 3], isWall: false };
    });
  };
  const bids = mk(false);
  const asks = mk(true);
  const med = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] || 1;
  };
  const flagWalls = (levels: BookLevel[]) => {
    const m = med(levels.map((l) => l.size));
    for (const l of levels) l.isWall = l.size > m * 2.8;
  };
  flagWalls(bids);
  flagWalls(asks);
  const imbalance = (bids[14].total - asks[14].total) / (bids[14].total + asks[14].total);
  const spoofing = Math.round(Math.min(95, Math.max(8, Math.abs(imbalance) * 60 + rand() * 30)));
  return { bids, asks, imbalance, spoofing };
}

function seedEvents(meta: SymbolMeta, candles: Candle[], rand: () => number): LiquidationEvent[] {
  const now = Date.now();
  const events: LiquidationEvent[] = [];
  for (let i = 0; i < 9; i++) {
    const k = candles[CANDLE_COUNT - 1 - Math.floor(rand() * 20)];
    const side: "long" | "short" = rand() > 0.5 ? "long" : "short";
    const liqPrice = side === "long" ? k.l * (1 - rand() * 0.004) : k.h * (1 + rand() * 0.004);
    const qtyUsd = meta.liqScale * 1e6 * (0.02 + Math.pow(rand(), 2.4) * 0.5);
    events.push({
      id: `seed-${now}-${i}`,
      time: now - Math.floor(rand() * 8 * 60_000),
      symbol: meta.symbol,
      side,
      price: liqPrice,
      qtyUsd,
      exchange: EXCHANGES[Math.floor(rand() * 3)],
      isReal: false,
    });
  }
  return events.sort((a, b) => b.time - a.time);
}

export function deriveState(meta: SymbolMeta, tfMinutes: number, candles: Candle[], seed: number): MarketState {
  const rand = mulberry32(seed + 99);
  let lo = Infinity, hi = -Infinity;
  for (const k of candles) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  const pad = (hi - lo) * 0.045;
  const pMin = lo - pad, pMax = hi + pad;

  const heat = seedHeat(candles, pMin, pMax, rand, meta.liqScale);
  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) heatMax = Math.max(heatMax, heat[i]);
  if (heatMax <= 0) heatMax = 1;

  const clusters = deriveClusters(meta, candles, heat, pMin, pMax, heatMax);
  const events = seedEvents(meta, candles, rand);
  const now = Date.now();

  const cvd: number[] = [0];
  for (let i = 0; i < CANDLE_COUNT; i++) cvd.push(cvd[i] + candles[i].delta);
  cvd.shift();

  const book = genBook(meta, candles[CANDLE_COUNT - 1].c, rand);
  const latency = Array.from({ length: 40 }, () => 14 + rand() * 42);

  const totalLiq24hLong = events.filter((e) => e.side === "long").reduce((s, e) => s + e.qtyUsd, 0) * 7;
  const totalLiq24hShort = events.filter((e) => e.side === "short").reduce((s, e) => s + e.qtyUsd, 0) * 7;

  return {
    meta,
    tfMinutes,
    candles,
    heat,
    heatMax,
    pMin,
    pMax,
    cvd,
    ...book,
    funding: (rand() - 0.42) * 0.05,
    fundingNextMs: rand() * 8 * 3600_000,
    oi: meta.basePrice * meta.bookBase * (900 + rand() * 500) * 1000,
    oiDelta1h: (rand() - 0.45) * 3,
    longShortRatio: 0.8 + rand() * 0.6,
    clusters,
    events,
    latency,
    msgsPerSec: 180 + rand() * 260,
    uptimePct: 99.55 + rand() * 0.43,
    totalLiq24hLong,
    totalLiq24hShort,
    change24h: ((candles[CANDLE_COUNT - 1].c - candles[0].o) / candles[0].o) * 100,
    now,
  };
}

export function generateMarket(meta: SymbolMeta, tfMinutes: number, seed: number): MarketState {
  const candles = generateCandles(meta, tfMinutes, seed);
  return deriveState(meta, tfMinutes, candles, seed);
}

// ---------- datos reales ----------

// Construye el estado completo a partir de velas reales (klines de Binance)
export function marketFromKlines(meta: SymbolMeta, tfMinutes: number, klines: Candle[], seed: number): MarketState {
  if (!klines.length) throw new Error("sin velas");
  let candles = klines.slice(-CANDLE_COUNT);
  if (candles.length < CANDLE_COUNT) {
    const first = candles[0];
    const stepMs = tfMinutes * 60_000;
    const padding: Candle[] = [];
    for (let i = candles.length; i < CANDLE_COUNT; i++) {
      padding.unshift({
        t: first.t - stepMs * (i - candles.length + 1),
        o: first.o, h: first.h, l: first.l, c: first.c,
        v: first.v * 0.6, delta: 0,
      });
    }
    candles = [...padding, ...candles];
  }
  // la serie completa (hasta 500 velas) queda como semilla de los indicadores;
  // el gráfico dibuja solo las últimas CANDLE_COUNT.
  return { ...deriveState(meta, tfMinutes, candles, seed), warm: klines };
}

// Re-muestrea el calor cuando cambia el rango de precios, para que las zonas
// de liquidez queden ancladas a su nivel de precio real (no al bin).
function rebinHeat(heat: Float32Array, oldMin: number, oldMax: number, newMin: number, newMax: number): Float32Array {
  if (Math.abs(oldMin - newMin) < 1e-9 && Math.abs(oldMax - newMax) < 1e-9) return heat;
  const out = new Float32Array(heat.length);
  const oldSpan = oldMax - oldMin || 1;
  const newSpan = newMax - newMin || 1;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    for (let b = 0; b < HEAT_BINS; b++) {
      const price = newMin + ((b + 0.5) / HEAT_BINS) * newSpan;
      const fb = ((price - oldMin) / oldSpan) * (HEAT_BINS - 1);
      if (fb < 0 || fb > HEAT_BINS - 1) continue;
      const b0 = Math.floor(fb), b1 = Math.min(HEAT_BINS - 1, b0 + 1);
      const fr = fb - b0;
      out[i * HEAT_BINS + b] = heat[i * HEAT_BINS + b0] * (1 - fr) + heat[i * HEAT_BINS + b1] * fr;
    }
  }
  return out;
}

// Aplica un tick real del websocket: rollover de vela cuando cruza el
// intervalo del timeframe y ajuste del rango visible. El delta/volumen del
// CVD proviene del stream aggTrade (applyTradeFlow), no se estima aquí.
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
    candles.push({
      t: Math.floor(now / stepMs) * stepMs,
      o: price, h: price, l: price, c: price, v: 0, delta: 0,
    });
  } else {
    last.c = price;
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    candles[candles.length - 1] = last;
  }

  let heat = s.heat;
  let cvd = s.cvd;
  if (rolled) {
    heat = new Float32Array(s.heat);
    heat.copyWithin(0, HEAT_BINS);
    for (let b = 0; b < HEAT_BINS; b++) heat[(CANDLE_COUNT - 1) * HEAT_BINS + b] = 0;
    cvd = s.cvd.slice();
    cvd.shift();
    cvd.push(cvd[cvd.length - 1]);
  }
  cvd[cvd.length - 1] = cvd[cvd.length - 2] + candles[candles.length - 1].delta;

  // El rango anclado (pMin/pMax) SOLO se expande cuando la vela actual supera
  // realmente los límites — nunca por "proximidad al borde". En timeframes bajos
  // el span es diminuto y la expansión por proximidad se disparaba en casi cada
  // tick, re-mapeando el calor constantemente hasta desvanecerlo.
  let pMin = s.pMin, pMax = s.pMax;
  const span = pMax - pMin || 1;
  const lastK = candles[candles.length - 1];
  if (lastK.l < pMin) pMin = lastK.l - span * 0.05;
  if (lastK.h > pMax) pMax = lastK.h + span * 0.05;
  heat = rebinHeat(heat, s.pMin, s.pMax, pMin, pMax);

  return {
    ...s,
    candles,
    heat,
    cvd,
    pMin,
    pMax,
    change24h: ((price - candles[0].o) / candles[0].o) * 100,
  };
}

// Fusiona klines recién descargados sin reiniciar el estado:
// actualiza velas existentes y añade las nuevas (desplazando heat/cvd).
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
    for (let c = CANDLE_COUNT - added.length; c < CANDLE_COUNT; c++) {
      for (let b = 0; b < HEAT_BINS; b++) heat[c * HEAT_BINS + b] = 0;
    }
    for (let i = 0; i < added.length; i++) {
      cvd.shift();
      cvd.push(cvd[cvd.length - 1]);
    }
  }
  cvd[cvd.length - 1] = cvd[cvd.length - 2] + candles[candles.length - 1].delta;

  let lo = Infinity, hi = -Infinity;
  for (const k of candles) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  const pad = (hi - lo) * 0.045;
  const pMin = lo - pad, pMax = hi + pad;
  heat = rebinHeat(heat, s.pMin, s.pMax, pMin, pMax);

  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) heatMax = Math.max(heatMax, heat[i]);
  if (heatMax <= 0) heatMax = s.heatMax || 1;

  const next: MarketState = { ...s, candles, heat, cvd, pMin, pMax, heatMax };
  next.clusters = deriveClusters(s.meta, candles, heat, pMin, pMax, heatMax);
  return next;
}

// ---------- tick del motor (paneles vivos) ----------

export function tickMarket(
  s: MarketState,
  opts?: { drift?: boolean; latencyMs?: number }
): MarketState {
  const withDrift = opts?.drift !== false;
  const rand = Math.random;
  const now = Date.now();
  const last = s.candles[s.candles.length - 1];

  let candles = s.candles;
  let heat = s.heat;
  let cvd = s.cvd;
  let pMin = s.pMin, pMax = s.pMax;
  let clusters = s.clusters;

  // depósito de calor + delta solo en modo simulado (en live lo hace aggTrade)
  if (withDrift) {
    candles = s.candles.slice();
    const k = { ...candles[candles.length - 1] };
    const vol = s.meta.vol * Math.sqrt(s.tfMinutes / 5) * 0.16;
    const dc = k.c * (rand() - 0.5) * vol;
    k.c = k.c + dc;
    k.h = Math.max(k.h, k.c);
    k.l = Math.min(k.l, k.c);
    const mag = Math.abs(dc) / k.c * s.meta.bookBase * 40 + s.meta.bookBase * 0.4;
    k.delta += dc >= 0 ? mag : -mag;
    k.v += mag * 2;
    candles[candles.length - 1] = k;

    heat = new Float32Array(s.heat);
    for (let i = 0; i < heat.length; i++) heat[i] *= 0.9988;
    const span = pMax - pMin || 1;
    const curBin = Math.round(((k.c - pMin) / span) * (HEAT_BINS - 1));
    const ci = CANDLE_COUNT - 1;
    for (let db = -3; db <= 3; db++) {
      const bb = curBin + db;
      if (bb >= 0 && bb < HEAT_BINS) {
        heat[ci * HEAT_BINS + bb] += s.meta.liqScale * 0.02 * Math.exp(-(db * db) / 3) * (0.4 + rand());
      }
    }

    cvd = s.cvd.slice();
    cvd[cvd.length - 1] = cvd[cvd.length - 2] + k.delta;

    const span2 = pMax - pMin;
    if (k.c < pMin + span2 * 0.05) pMin = k.c - span2 * 0.06;
    if (k.c > pMax - span2 * 0.05) pMax = k.c + span2 * 0.06;
    heat = rebinHeat(heat, s.pMin, s.pMax, pMin, pMax);

    // en sim los clústeres se re-derivan cuando nace una vela nueva
    if (rand() < 0.02) {
      let hm = 0;
      for (let i = 0; i < heat.length; i++) hm = Math.max(hm, heat[i]);
      clusters = deriveClusters(s.meta, candles, heat, pMin, pMax, hm || 1);
    }
  }

  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) if (heat[i] > heatMax) heatMax = heat[i];
  if (heatMax <= 0) heatMax = s.heatMax || 1;

  // libro / spoofing / funding / OI: solo se "mueven" en modo simulado.
  // En live se conservan intactos los datos reales entre refrescos de la API.
  let bids = s.bids, asks = s.asks, imbalance = s.imbalance, spoofing = s.spoofing;
  let funding = s.funding, oi = s.oi, oiDelta1h = s.oiDelta1h, longShortRatio = s.longShortRatio;
  if (withDrift) {
    const jitterBook = (levels: BookLevel[], dirUp: boolean): BookLevel[] => {
      let total = 0;
      return levels.map((lv, i) => {
        const size = lv.size * (0.965 + rand() * 0.075) + (rand() < 0.02 ? s.meta.bookBase * (2 + rand() * 4) : 0);
        total += size;
        return { ...lv, size, total, price: dirUp ? last.c + (i + 1) * last.c * 0.00045 : last.c - (i + 1) * last.c * 0.00045 };
      });
    };
    bids = jitterBook(s.bids, false);
    asks = jitterBook(s.asks, true);
    const bidSum = bids[bids.length - 1].total;
    const askSum = asks[asks.length - 1].total;
    imbalance = (bidSum - askSum) / (bidSum + askSum);
    spoofing = Math.min(97, Math.max(8, s.spoofing + (rand() - 0.5) * 5));
    funding = Math.max(-0.09, Math.min(0.09, s.funding + (rand() - 0.5) * 0.0016));
    oi = s.oi * (1 + (rand() - 0.47) * 0.0035);
    oiDelta1h = s.oiDelta1h + (rand() - 0.5) * 0.12;
    longShortRatio = Math.min(1.9, Math.max(0.55, s.longShortRatio + (rand() - 0.5) * 0.02));
  }

  // eventos de liquidación: estimados por el modelo → isReal SIEMPRE false
  let events = s.events;
  let totalLiq24hLong = s.totalLiq24hLong;
  let totalLiq24hShort = s.totalLiq24hShort;
  if (rand() < 0.42) {
    const ri = Math.floor(rand() * 1e6);
    const side: "long" | "short" = rand() > 0.5 ? "long" : "short";
    const liqPrice = side === "long" ? last.c * (1 - rand() * 0.006) : last.c * (1 + rand() * 0.006);
    const qtyUsd = s.meta.liqScale * 1e6 * (0.015 + Math.pow(rand(), 2.6) * 0.55);
    const ev: LiquidationEvent = {
      id: `${now}-${ri}`,
      time: now,
      symbol: s.meta.symbol,
      side,
      price: liqPrice,
      qtyUsd,
      exchange: EXCHANGES[ri % EXCHANGES.length],
      isReal: false,
    };
    events = [ev, ...s.events].slice(0, 42);
    if (side === "long") totalLiq24hLong += qtyUsd;
    else totalLiq24hShort += qtyUsd;
  }

  // latencia: medida real si viene del websocket; simulada si no
  const lat = s.latency.slice();
  const realLat = opts?.latencyMs;
  lat.push(
    realLat != null && Number.isFinite(realLat) && realLat >= 0 && realLat < 3000
      ? realLat
      : 12 + rand() * 40
  );
  if (lat.length > 40) lat.shift();

  return {
    ...s,
    candles,
    heat,
    heatMax,
    cvd,
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
    latency: lat,
    msgsPerSec: Math.max(40, s.msgsPerSec + (rand() - 0.5) * 22),
    now,
  };
}

// ---------- inyección de datos 100% reales ----------

// Delta real de trades (aggTrade de Binance) → CVD real
export function applyTradeFlow(s: MarketState, delta: number): MarketState {
  if (!Number.isFinite(delta) || delta === 0) return s;
  const candles = s.candles.slice();
  const last = { ...candles[candles.length - 1] };
  last.delta += delta;
  last.v += Math.abs(delta) * 2;
  candles[candles.length - 1] = last;
  const cvd = s.cvd.slice();
  cvd[cvd.length - 1] += delta;
  return { ...s, candles, cvd };
}

// Liquidaciones REALES del websocket de OKX → feed (isReal: true)
export function injectLiqEvents(s: MarketState, evts: Omit<LiquidationEvent, "isReal">[]): MarketState {
  if (!evts.length) return s;
  const fresh: LiquidationEvent[] = evts
    .filter((e) => Number.isFinite(e.price) && Number.isFinite(e.qtyUsd) && e.qtyUsd > 0)
    .map((e) => ({ ...e, isReal: true }));
  if (!fresh.length) return s;
  const events = [...fresh, ...s.events].slice(0, 60);
  let tl = s.totalLiq24hLong, ts = s.totalLiq24hShort;
  for (const e of fresh) {
    if (e.side === "long") tl += e.qtyUsd;
    else ts += e.qtyUsd;
  }
  return { ...s, events, totalLiq24hLong: tl, totalLiq24hShort: ts };
}
