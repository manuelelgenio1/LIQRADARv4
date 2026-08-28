// ============================================================
// LIQRADAR v2 — motor de datos de mercado (feed simulado realista)
// Genera velas, heatmap de liquidaciones, clústeres, libro de
// órdenes agregado, CVD, funding, open interest y eventos en vivo.
// ============================================================

export const HEAT_BINS = 92;
export const CANDLE_COUNT = 128;

export interface SymbolMeta {
  symbol: string;
  base: string;
  name: string;
  basePrice: number;
  decimals: number;
  vol: number;        // volatilidad base por vela
  liqScale: number;   // escala de $ para clústeres de liquidación
  bookBase: number;   // tamaño base por nivel del libro
  hue: string;        // color del activo
}

export const SYMBOLS: SymbolMeta[] = [
  { symbol: "BTCUSDT",  base: "BTC",  name: "Bitcoin",   basePrice: 97420,  decimals: 1, vol: 0.0042, liqScale: 46, bookBase: 14,  hue: "#ffb224" },
  { symbol: "ETHUSDT",  base: "ETH",  name: "Ethereum",  basePrice: 3542,   decimals: 2, vol: 0.0052, liqScale: 18, bookBase: 220, hue: "#8fa3c4" },
  { symbol: "SOLUSDT",  base: "SOL",  name: "Solana",    basePrice: 216.4,  decimals: 2, vol: 0.0068, liqScale: 7,  bookBase: 3400, hue: "#2de0c0" },
  { symbol: "BNBUSDT",  base: "BNB",  name: "BNB Chain", basePrice: 642.8,  decimals: 2, vol: 0.0048, liqScale: 5,  bookBase: 900, hue: "#ffd37a" },
  { symbol: "XRPUSDT",  base: "XRP",  name: "XRP",       basePrice: 2.314,  decimals: 4, vol: 0.0072, liqScale: 4,  bookBase: 1.4e5, hue: "#7df0da" },
  { symbol: "DOGEUSDT", base: "DOGE", name: "Dogecoin",  basePrice: 0.3186, decimals: 5, vol: 0.0085, liqScale: 3,  bookBase: 4.2e5, hue: "#ff93a9" },
];

export const TIMEFRAMES: { key: string; minutes: number }[] = [
  { key: "1m", minutes: 1 },
  { key: "5m", minutes: 5 },
  { key: "15m", minutes: 15 },
  { key: "1H", minutes: 60 },
  { key: "4H", minutes: 240 },
];

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; delta: number; }

export interface LiqCluster {
  id: string;
  price: number;
  side: "long" | "short";   // longs liquidan debajo, shorts encima
  sizeUsd: number;
  leverage: string;
  strength: number;          // 0..1
  exchange: string;
}

export interface BookLevel { price: number; size: number; total: number; exchange: string; isWall: boolean; }

export interface LiquidationEvent {
  id: string;
  time: number;
  symbol: string;
  side: "long" | "short";
  price: number;
  qtyUsd: number;
  exchange: string;
}

export interface MarketState {
  meta: SymbolMeta;
  tfMinutes: number;
  candles: Candle[];
  heat: Float32Array;
  heatMax: number;
  pMin: number;
  pMax: number;
  clusters: LiqCluster[];
  bids: BookLevel[];
  asks: BookLevel[];
  imbalance: number;         // -1..1 (positivo = presión compradora)
  spoofing: number;          // 0..100
  cvd: number[];
  funding: number;           // %
  fundingNextMs: number;
  oi: number;                // USD
  oiDelta1h: number;         // %
  longShortRatio: number;
  latency: number[];         // historial ms
  msgsPerSec: number;
  uptimePct: number;
  events: LiquidationEvent[];
  totalLiq24hLong: number;
  totalLiq24hShort: number;
  change24h: number;         // %
}

// ---------- RNG determinista ----------
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXCHANGES = ["Binance", "Bybit", "OKX"];
const LEVERAGES = ["10x", "25x", "25x", "50x", "50x", "100x"];

// ---------- generación ----------
export function generateMarket(meta: SymbolMeta, tfMinutes: number, seed: number): MarketState {
  const rand = mulberry32(seed);
  const tfScale = Math.sqrt(tfMinutes / 5);
  const vol = meta.vol * tfScale;
  const stepMs = tfMinutes * 60_000;
  const now = Date.now();
  const start = now - stepMs * (CANDLE_COUNT - 1);

  // velas
  const candles: Candle[] = [];
  let price = meta.basePrice * (1 - 0.02 + rand() * 0.04);
  let trend = 0;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    if (i % 22 === 0) trend = (rand() - 0.5) * vol * 3.4;
    const o = price;
    const shock = rand() < 0.05 ? (rand() - 0.5) * vol * 6 : 0;
    const drift = trend + (rand() - 0.5) * vol * 2.1 + shock;
    const c = o * (1 + drift);
    const h = Math.max(o, c) * (1 + rand() * vol * 0.9);
    const l = Math.min(o, c) * (1 - rand() * vol * 0.9);
    const v = meta.bookBase * 9 * (0.45 + rand() * 1.6) * (1 + Math.abs(drift) / vol);
    const delta = v * (c >= o ? 0.22 + rand() * 0.55 : -(0.22 + rand() * 0.55));
    candles.push({ t: start + i * stepMs, o, h, l, c, v, delta });
    price = c;
  }

  return deriveState(meta, tfMinutes, candles, seed);
}

// Deriva el estado completo (calor, clústeres, libro, métricas) a partir de velas
function deriveState(meta: SymbolMeta, tfMinutes: number, candles: Candle[], seed: number): MarketState {
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const now = Date.now();

  // rango de precios
  let lo = Infinity, hi = -Infinity;
  for (const k of candles) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  const pad = (hi - lo) * 0.045;
  const pMin = lo - pad, pMax = hi + pad;
  const binOf = (p: number) => Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((p - pMin) / (pMax - pMin)) * (HEAT_BINS - 1))));
  const priceOf = (b: number) => pMin + (b / (HEAT_BINS - 1)) * (pMax - pMin);

  // heatmap de liquidaciones
  const heat = new Float32Array(CANDLE_COUNT * HEAT_BINS);
  const addGauss = (ci: number, bin: number, amp: number, sigC: number, sigB: number) => {
    const futureBias = 0.3 + 0.7 * (ci / CANDLE_COUNT);
    const rc = Math.ceil(sigC * 2.4), rb = Math.ceil(sigB * 2.6);
    for (let di = -rc; di <= rc; di++) {
      const ii = ci + di;
      if (ii < 0 || ii >= CANDLE_COUNT) continue;
      const wc = Math.exp(-(di * di) / (2 * sigC * sigC));
      for (let db = -rb; db <= rb; db++) {
        const bb = bin + db;
        if (bb < 0 || bb >= HEAT_BINS) continue;
        const wb = Math.exp(-(db * db) / (2 * sigB * sigB));
        heat[ii * HEAT_BINS + bb] += amp * wc * wb * futureBias;
      }
    }
  };

  for (let i = 0; i < CANDLE_COUNT; i++) {
    const k = candles[i];
    addGauss(i, binOf(k.h), 1.0, 4.5, 1.7);
    addGauss(i, binOf(k.l), 1.0, 4.5, 1.7);
    addGauss(i, binOf(k.o), 0.5, 3.5, 1.3);
    addGauss(i, binOf(k.c), 0.5, 3.5, 1.3);
  }
  // swings (piscinas de liquidez fuertes)
  for (let i = 3; i < CANDLE_COUNT - 3; i++) {
    let isHi = true, isLo = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (candles[j].h > candles[i].h) isHi = false;
      if (candles[j].l < candles[i].l) isLo = false;
    }
    if (isHi) addGauss(i, binOf(candles[i].h), 1.9, 6, 2.4);
    if (isLo) addGauss(i, binOf(candles[i].l), 1.9, 6, 2.4);
  }
  // números redondos (liquidez persistente)
  const mag = Math.pow(10, Math.floor(Math.log10(meta.basePrice))) / 2;
  for (let rp = Math.ceil(pMin / mag) * mag; rp <= pMax; rp += mag) {
    const b = binOf(rp);
    const amp = 0.42 + rand() * 0.3;
    for (let i = 0; i < CANDLE_COUNT; i++) heat[i * HEAT_BINS + b] += amp * (0.75 + 0.25 * Math.sin(i / 9));
    for (let db = -1; db <= 1; db++) {
      const bb = b + db;
      if (bb < 0 || bb >= HEAT_BINS) continue;
      for (let i = 0; i < CANDLE_COUNT; i++) heat[i * HEAT_BINS + bb] += amp * 0.35;
    }
  }
  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) heatMax = Math.max(heatMax, heat[i]);

  // clústeres de liquidación (perfil de las últimas columnas)
  const curPrice = candles[CANDLE_COUNT - 1].c;
  const curBin = binOf(curPrice);
  const profile = new Float32Array(HEAT_BINS);
  const cols = 14;
  for (let b = 0; b < HEAT_BINS; b++) {
    let s = 0;
    for (let i = CANDLE_COUNT - cols; i < CANDLE_COUNT; i++) s += heat[i * HEAT_BINS + b];
    profile[b] = s / cols;
  }
  const peaks: { bin: number; v: number }[] = [];
  for (let b = 2; b < HEAT_BINS - 2; b++) {
    if (profile[b] > profile[b - 1] && profile[b] >= profile[b + 1] && profile[b] > heatMax * 0.42) {
      peaks.push({ bin: b, v: profile[b] });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const clusters: LiqCluster[] = [];
  const usedBins: number[] = [];
  for (const p of peaks) {
    if (clusters.length >= 8) break;
    if (Math.abs(p.bin - curBin) < 3) continue;
    if (usedBins.some((u) => Math.abs(u - p.bin) < 4)) continue;
    usedBins.push(p.bin);
    const side: "long" | "short" = p.bin < curBin ? "long" : "short";
    const strength = Math.min(1, p.v / heatMax);
    clusters.push({
      id: `${meta.symbol}-${p.bin}`,
      price: priceOf(p.bin),
      side,
      sizeUsd: meta.liqScale * 1e6 * strength * (0.55 + rand() * 0.9),
      leverage: LEVERAGES[Math.floor(rand() * LEVERAGES.length)],
      strength,
      exchange: EXCHANGES[Math.floor(rand() * 3)],
    });
  }
  // garantía: el radar nunca queda vacío — sintetiza piscinas si faltan
  let guard = 0;
  while (clusters.length < 6 && guard < 40) {
    guard++;
    const dir = guard % 2 === 0 ? 1 : -1;
    const bin = Math.min(HEAT_BINS - 2, Math.max(1, curBin + dir * (4 + Math.floor(rand() * 34))));
    if (usedBins.some((u) => Math.abs(u - bin) < 4)) continue;
    usedBins.push(bin);
    const side: "long" | "short" = bin < curBin ? "long" : "short";
    const strength = 0.34 + rand() * 0.5;
    clusters.push({
      id: `${meta.symbol}-syn-${bin}`,
      price: priceOf(bin),
      side,
      sizeUsd: meta.liqScale * 1e6 * strength * (0.45 + rand() * 0.75),
      leverage: LEVERAGES[Math.floor(rand() * LEVERAGES.length)],
      strength,
      exchange: EXCHANGES[Math.floor(rand() * 3)],
    });
  }
  clusters.sort((a, b) => b.sizeUsd - a.sizeUsd);

  // libro de órdenes agregado
  const bookStep = curPrice * 0.00045;
  const mkLevels = (dirUp: boolean): BookLevel[] => {
    const out: BookLevel[] = [];
    let total = 0;
    for (let k = 1; k <= 15; k++) {
      const p = dirUp ? curPrice + bookStep * k : curPrice - bookStep * k;
      let size = meta.bookBase * (0.35 + rand() * 1.15);
      const isWall = rand() < 0.13;
      if (isWall) size *= 3.6 + rand() * 3.4;
      total += size;
      out.push({ price: p, size, total, exchange: EXCHANGES[Math.floor(rand() * 3)], isWall });
    }
    return out;
  };
  const bids = mkLevels(false);
  const asks = mkLevels(true);
  const bidSum = bids[bids.length - 1].total;
  const askSum = asks[asks.length - 1].total;
  const imbalance = (bidSum - askSum) / (bidSum + askSum);
  const biggestWall = [...bids, ...asks].reduce((m, l) => (l.size > m.size ? l : m), bids[0]);
  const wallSide = bids.includes(biggestWall) ? 1 : -1;
  const spoofing = Math.min(97, Math.round(38 + (biggestWall.size / meta.bookBase) * 6 + wallSide * imbalance * 40 + rand() * 12));

  // CVD acumulado
  const cvd: number[] = [];
  let acc = 0;
  for (const k of candles) { acc += k.delta; cvd.push(acc); }

  // métricas derivadas
  const latency: number[] = [];
  for (let i = 0; i < 36; i++) latency.push(9 + rand() * 26);
  const first = candles[0].o;
  const change24h = ((curPrice - first) / first) * 100;

  // eventos recientes para que el feed no arranque vacío
  const events: LiquidationEvent[] = [];
  for (let i = 0; i < 9; i++) {
    events.push({
      id: `${meta.symbol}-seed-${i}`,
      time: now - (i + 1) * (3800 + rand() * 8200),
      symbol: meta.symbol,
      side: rand() < 0.5 ? "long" : "short",
      price: curPrice * (1 + (rand() - 0.5) * 0.0022),
      qtyUsd: Math.pow(rand(), 2.2) * meta.liqScale * 1e6 * 0.26 + 1400,
      exchange: EXCHANGES[Math.floor(rand() * 3)],
    });
  }

  return {
    meta,
    tfMinutes,
    candles,
    heat,
    heatMax,
    pMin,
    pMax,
    clusters,
    bids,
    asks,
    imbalance,
    spoofing,
    cvd,
    funding: (rand() - 0.42) * 0.055,
    fundingNextMs: Math.floor(rand() * 8 * 3600_000),
    oi: meta.liqScale * 1e8 * (2.1 + rand() * 1.4),
    oiDelta1h: (rand() - 0.45) * 3.4,
    longShortRatio: 0.72 + rand() * 0.75,
    latency,
    msgsPerSec: 42 + rand() * 90,
    uptimePct: 99.55 + rand() * 0.43,
    events,
    totalLiq24hLong: meta.liqScale * 1e6 * (3.2 + rand() * 5),
    totalLiq24hShort: meta.liqScale * 1e6 * (3.0 + rand() * 5),
    change24h,
  };
}

// ---------- tick en vivo ----------
let evtSeq = 0;

export function tickMarket(s: MarketState, opts: { drift?: boolean } = {}): MarketState {
  const rand = Math.random;
  const meta = s.meta;
  const withDrift = opts.drift !== false;
  const candles = s.candles.slice();
  const last = { ...candles[candles.length - 1] };
  const vol = meta.vol * Math.sqrt(s.tfMinutes / 5);
  const drift = withDrift ? (rand() - 0.485) * vol * 0.55 : 0;
  if (withDrift) {
    const prevC = last.c;
    last.c = last.c * (1 + drift);
    last.h = Math.max(last.h, last.c);
    last.l = Math.min(last.l, last.c);
    const dV = meta.bookBase * (0.4 + rand() * 1.4);
    last.v += dV;
    last.delta += dV * (last.c >= prevC ? 0.35 + rand() * 0.5 : -(0.35 + rand() * 0.5));
    candles[candles.length - 1] = last;
  }

  // ocasionalmente nace una vela nueva
  let rolled = false;
  if (withDrift && rand() < 0.045) {
    rolled = true;
    candles.shift();
    candles.push({
      t: last.t + s.tfMinutes * 60_000,
      o: last.c, h: last.c, l: last.c, c: last.c,
      v: 0, delta: 0,
    });
  }

  // heat: depositar energía cerca del precio actual
  const heat = new Float32Array(s.heat);
  if (rolled) {
    heat.copyWithin(0, HEAT_BINS);
    for (let b = 0; b < HEAT_BINS; b++) heat[(CANDLE_COUNT - 1) * HEAT_BINS + b] = 0;
  }
  // el rango de precios se expande si el mercado se acerca al borde
  let pMin = s.pMin;
  let pMax = s.pMax;
  const span0 = pMax - pMin;
  if (last.c < pMin + span0 * 0.05) pMin = last.c - span0 * 0.05;
  if (last.c > pMax - span0 * 0.05) pMax = last.c + span0 * 0.05;

  const curBin = Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((last.c - pMin) / (pMax - pMin)) * (HEAT_BINS - 1))));
  const ci = CANDLE_COUNT - 1;
  for (let db = -3; db <= 3; db++) {
    const bb = curBin + db;
    if (bb < 0 || bb >= HEAT_BINS) continue;
    heat[ci * HEAT_BINS + bb] += (0.16 + rand() * 0.2) * Math.exp(-(db * db) / 3.2);
  }
  // decaimiento global para que el mapa no se "apague" ni sature con el tiempo
  for (let i = 0; i < heat.length; i++) heat[i] *= 0.9988;
  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) if (heat[i] > heatMax) heatMax = heat[i];
  if (heatMax <= 0) heatMax = s.heatMax || 1;

  // CVD
  const cvd = s.cvd.slice();
  if (rolled) { cvd.shift(); cvd.push(cvd[cvd.length - 1]); }
  cvd[cvd.length - 1] = cvd[cvd.length - 2] + last.delta;

  // libro: jitter de tamaños
  const jitterBook = (levels: BookLevel[], dirUp: boolean): BookLevel[] => {
    let total = 0;
    return levels.map((lv, i) => {
      const size = lv.size * (0.965 + rand() * 0.075) + (rand() < 0.02 ? meta.bookBase * (2 + rand() * 4) : 0);
      total += size;
      return { ...lv, size, total, price: dirUp ? last.c + (i + 1) * last.c * 0.00045 : last.c - (i + 1) * last.c * 0.00045 };
    });
  };
  const bids = jitterBook(s.bids, false);
  const asks = jitterBook(s.asks, true);
  const bidSum = bids[bids.length - 1].total;
  const askSum = asks[asks.length - 1].total;
  const imbalance = (bidSum - askSum) / (bidSum + askSum);

  // eventos de liquidación
  const events = s.events.slice();
  let totalLiq24hLong = s.totalLiq24hLong;
  let totalLiq24hShort = s.totalLiq24hShort;
  if (rand() < 0.42) {
    const side: "long" | "short" = drift < 0 ? "long" : rand() < 0.5 ? "long" : "short";
    const qty = Math.pow(rand(), 2.4) * meta.liqScale * 1e6 * 0.55 + 1800;
    const px = last.c * (1 + (rand() - 0.5) * 0.0016);
    events.unshift({
      id: `${meta.symbol}-${++evtSeq}`,
      time: Date.now(),
      symbol: meta.symbol,
      side,
      price: px,
      qtyUsd: qty,
      exchange: EXCHANGES[Math.floor(rand() * 3)],
    });
    if (events.length > 44) events.pop();
    if (side === "long") totalLiq24hLong += qty;
    else totalLiq24hShort += qty;
  }

  const latency = s.latency.slice();
  latency.push(7 + rand() * 30 + (rand() < 0.06 ? 40 + rand() * 60 : 0));
  if (latency.length > 44) latency.shift();

  return {
    ...s,
    candles,
    heat,
    heatMax,
    pMin,
    pMax,
    cvd,
    bids,
    asks,
    imbalance,
    spoofing: Math.min(97, Math.max(8, s.spoofing + (rand() - 0.5) * 5)),
    funding: Math.max(-0.09, Math.min(0.09, s.funding + (rand() - 0.5) * 0.0016)),
    fundingNextMs: s.fundingNextMs <= 700 ? 8 * 3600_000 : s.fundingNextMs - 700,
    oi: s.oi * (1 + (rand() - 0.47) * 0.0035),
    oiDelta1h: s.oiDelta1h + (rand() - 0.5) * 0.12,
    longShortRatio: Math.min(1.9, Math.max(0.55, s.longShortRatio + (rand() - 0.5) * 0.02)),
    latency,
    msgsPerSec: Math.max(18, s.msgsPerSec + (rand() - 0.5) * 14),
    events,
    totalLiq24hLong,
    totalLiq24hShort,
    change24h: ((last.c - s.candles[0].o) / s.candles[0].o) * 100,
  };
}

// Construye el estado completo a partir de velas reales (klines de Binance)
export function marketFromKlines(meta: SymbolMeta, tfMinutes: number, klines: Candle[], seed: number): MarketState {
  if (!klines.length) throw new Error("sin velas");
  let candles = klines.slice(-CANDLE_COUNT);
  if (candles.length < CANDLE_COUNT) {
    const first = candles[0];
    const stepMs = tfMinutes * 60_000;
    const pad: Candle[] = [];
    for (let i = candles.length; i < CANDLE_COUNT; i++) {
      pad.unshift({
        t: first.t - stepMs * (i - candles.length + 1),
        o: first.o, h: first.h, l: first.l, c: first.c,
        v: first.v * 0.6, delta: 0,
      });
    }
    candles = [...pad, ...candles];
  }
  return deriveState(meta, tfMinutes, candles, seed);
}

// Aplica un tick real del websocket: rollover de vela cuando cruza el
// intervalo del timeframe, delta del CVD según la dirección real del
// precio y ajuste del rango visible.
export function applyLiveTick(s: MarketState, price: number, tfMinutes: number): MarketState {
  if (!Number.isFinite(price) || price <= 0) return s;
  const now = Date.now();
  const stepMs = tfMinutes * 60_000;
  const candles = s.candles.slice();
  const last = { ...candles[candles.length - 1] };
  const prevC = last.c;
  let rolled = false;
  if (now - last.t >= stepMs) {
    // nueva vela real alineada al intervalo
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
    const dc = price - prevC;
    const mag = (Math.abs(dc) / price) * s.meta.bookBase * 240 + s.meta.bookBase * 0.02;
    last.delta += dc >= 0 ? mag : -mag;
    last.v += mag * 2.2;
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

  let pMin = s.pMin, pMax = s.pMax;
  const span = pMax - pMin || 1;
  if (price < pMin + span * 0.05) pMin = price - span * 0.06;
  if (price > pMax - span * 0.05) pMax = price + span * 0.06;

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
  return { ...s, candles, heat, cvd, pMin: lo - pad, pMax: hi + pad };
}
