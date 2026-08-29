// ============================================================
// LIQRADAR v2 — motor de datos de mercado
// Genera/deriva velas, heatmap de liquidaciones, clústeres, libro
// de órdenes, CVD, funding, open interest y eventos en vivo.
// Funciona con velas simuladas (fallback) o velas reales de Binance.
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
  { key: "1D", minutes: 1440 },
  { key: "1W", minutes: 10080 },
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
  // serie extendida (hasta 500 velas reales) usada SOLO como semilla de los
  // indicadores; el gráfico dibuja `candles` (últimas CANDLE_COUNT).
  warm?: Candle[];
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
  oi: number;                // USD (o unidades en live)
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

// ---------- generación simulada (fallback sin red) ----------
export function generateMarket(meta: SymbolMeta, tfMinutes: number, seed: number): MarketState {
  const rand = mulberry32(seed);
  const tfScale = Math.sqrt(tfMinutes / 5);
  const vol = meta.vol * tfScale;
  const stepMs = tfMinutes * 60_000;
  const now = Date.now();
  const start = now - stepMs * (CANDLE_COUNT - 1);

  const candles: Candle[] = [];
  let price = meta.basePrice * (1 - 0.02 + rand() * 0.04);
  let trend = 0;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    if (i % 22 === 0) trend = (rand() - 0.5) * vol * 3.4;
    const o = price;
    const shock = rand() < 0.05 ? (rand() - 0.5) * vol * 6 : 0;
    // deriva limitada a ±16% por vela (evita velas absurdas en 1D/1W)
    const drift = Math.max(-0.16, Math.min(0.16, trend + (rand() - 0.5) * vol * 2.1 + shock));
    const c = o * (1 + drift);
    const wickF = Math.min(vol * 0.9, 0.06);
    const h = Math.max(o, c) * (1 + rand() * wickF);
    const l = Math.min(o, c) * (1 - rand() * wickF);
    const v = meta.bookBase * 9 * (0.45 + rand() * 1.6) * (1 + Math.abs(drift) / vol);
    const delta = v * (c >= o ? 0.22 + rand() * 0.55 : -(0.22 + rand() * 0.55));
    candles.push({ t: start + i * stepMs, o, h, l, c, v, delta });
    price = c;
  }

  return deriveState(meta, tfMinutes, candles, seed);
}

// ---------- clústeres de liquidación a partir del perfil de calor ----------
function deriveClusters(
  meta: SymbolMeta,
  candles: Candle[],
  heat: Float32Array,
  heatMax: number,
  pMin: number,
  pMax: number,
  rand: () => number
): LiqCluster[] {
  const curPrice = candles[CANDLE_COUNT - 1].c;
  const binOf = (p: number) =>
    Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((p - pMin) / (pMax - pMin)) * (HEAT_BINS - 1))));
  const priceOf = (b: number) => pMin + (b / (HEAT_BINS - 1)) * (pMax - pMin);
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

  const mkCluster = (bin: number, v: number): LiqCluster => {
    const side: "long" | "short" = bin < curBin ? "long" : "short";
    const strength = Math.max(0.28, Math.min(1, v / Math.max(heatMax, 1e-9)));
    return {
      id: `${meta.symbol}-${bin}`,
      price: priceOf(bin),
      side,
      sizeUsd: meta.liqScale * 1e6 * strength * (0.55 + rand() * 0.9),
      leverage: LEVERAGES[Math.floor(rand() * LEVERAGES.length)],
      strength,
      exchange: EXCHANGES[Math.floor(rand() * 3)],
    };
  };

  const clusters: LiqCluster[] = [];
  const usedBins: number[] = [];
  for (const p of peaks) {
    if (clusters.length >= 8) break;
    if (Math.abs(p.bin - curBin) < 3) continue;
    if (usedBins.some((u) => Math.abs(u - p.bin) < 4)) continue;
    usedBins.push(p.bin);
    clusters.push(mkCluster(p.bin, p.v));
  }
  // garantía: si el filtrado deja pocas zonas, se sintetizan piscinas plausibles
  const longsN = clusters.filter((c) => c.side === "long").length;
  const shortsN = clusters.length - longsN;
  const wantLong = Math.max(0, 3 - longsN);
  const wantShort = Math.max(0, 3 - shortsN);
  for (let i = 0; i < wantLong; i++) {
    const bin = Math.max(2, curBin - 5 - Math.floor(rand() * 14) - i * 3);
    if (usedBins.some((u) => Math.abs(u - bin) < 4)) continue;
    usedBins.push(bin);
    clusters.push(mkCluster(bin, heatMax * (0.5 + rand() * 0.4)));
  }
  for (let i = 0; i < wantShort; i++) {
    const bin = Math.min(HEAT_BINS - 3, curBin + 5 + Math.floor(rand() * 14) + i * 3);
    if (usedBins.some((u) => Math.abs(u - bin) < 4)) continue;
    usedBins.push(bin);
    clusters.push(mkCluster(bin, heatMax * (0.5 + rand() * 0.4)));
  }
  clusters.sort((a, b) => b.sizeUsd - a.sizeUsd);
  return clusters;
}

// ---------- derivación completa del estado a partir de velas ----------
function deriveState(meta: SymbolMeta, tfMinutes: number, candles: Candle[], seed: number): MarketState {
  const rand = mulberry32(seed ^ 0x9e3779b9);
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

  // clústeres de liquidación (derivados del perfil de calor reciente)
  const curPrice = candles[CANDLE_COUNT - 1].c;
  const clusters = deriveClusters(meta, candles, heat, heatMax, pMin, pMax, rand);

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
  const change24h = ((curPrice - candles[0].o) / candles[0].o) * 100;

  // liquidaciones recientes sembradas (buffer inicial del feed)
  const events: LiquidationEvent[] = [];
  for (let i = 0; i < 9; i++) {
    const side: "long" | "short" = rand() < 0.5 ? "long" : "short";
    events.push({
      id: `${meta.symbol}-seed-${i}`,
      time: now - (i + 1) * (3800 + rand() * 8200),
      symbol: meta.symbol,
      side,
      price: curPrice * (1 + (rand() - 0.5) * 0.003),
      qtyUsd: Math.pow(rand(), 2.2) * meta.liqScale * 1e6 * 0.22 + 1500,
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

// Re-ancla el heatmap a una nueva rejilla de precios.
// El calor se guarda por bin; si pMin/pMax cambian (expansión de rango o
// nueva ventana), cada bin pasaría a significar otro precio y la nube de
// liquidaciones se desplazaría respecto a los niveles reales. Esta función
// re-muestrea el calor interpolando en el espacio de precios para que las
// zonas sigan ancladas a su precio correcto.
function rebinHeat(
  heat: Float32Array,
  oldMin: number, oldMax: number,
  newMin: number, newMax: number
): Float32Array {
  if (oldMin === newMin && oldMax === newMax) return heat;
  const oldSpan = oldMax - oldMin || 1;
  const newSpan = newMax - newMin || 1;
  const out = new Float32Array(heat.length);
  for (let c = 0; c < CANDLE_COUNT; c++) {
    for (let nb = 0; nb < HEAT_BINS; nb++) {
      const price = newMin + (nb / (HEAT_BINS - 1)) * newSpan;
      const oldFb = ((price - oldMin) / oldSpan) * (HEAT_BINS - 1);
      const ob0 = Math.max(0, Math.min(HEAT_BINS - 1, Math.floor(oldFb)));
      const ob1 = Math.max(0, Math.min(HEAT_BINS - 1, Math.ceil(oldFb)));
      const frac = Math.max(0, Math.min(1, oldFb - ob0));
      out[c * HEAT_BINS + nb] =
        heat[c * HEAT_BINS + ob0] * (1 - frac) + heat[c * HEAT_BINS + ob1] * frac;
    }
  }
  return out;
}

// ---------- tick en vivo ----------
let evtSeq = 0;

export function tickMarket(s: MarketState, opts: { drift?: boolean; latencyMs?: number } = {}): MarketState {
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

  // expansión del rango si el precio se acerca al borde
  let pMin = s.pMin, pMax = s.pMax;
  const span = pMax - pMin || 1;
  if (last.c < pMin + span * 0.05) pMin = last.c - span * 0.06;
  if (last.c > pMax - span * 0.05) pMax = last.c + span * 0.06;

  // heat: depositar energía cerca del precio actual
  let heat: Float32Array = new Float32Array(s.heat);
  if (rolled) {
    heat.copyWithin(0, HEAT_BINS);
    for (let b = 0; b < HEAT_BINS; b++) heat[(CANDLE_COUNT - 1) * HEAT_BINS + b] = 0;
  }
  // si el rango cambió, re-ancla el calor a la nueva rejilla de precios
  heat = rebinHeat(heat, s.pMin, s.pMax, pMin, pMax);
  const curBin = Math.min(HEAT_BINS - 1, Math.max(0, Math.round(((last.c - pMin) / (pMax - pMin)) * (HEAT_BINS - 1))));
  const ci = CANDLE_COUNT - 1;
  for (let db = -3; db <= 3; db++) {
    const bb = curBin + db;
    if (bb < 0 || bb >= HEAT_BINS) continue;
    heat[ci * HEAT_BINS + bb] += (0.16 + rand() * 0.2) * Math.exp(-(db * db) / 3.2);
  }
  // decaimiento global para que el mapa no se sature ni se apague
  for (let i = 0; i < heat.length; i++) heat[i] *= 0.9988;
  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) if (heat[i] > heatMax) heatMax = heat[i];
  if (heatMax <= 0) heatMax = s.heatMax || 1;

  // cuando nace una vela nueva, re-deriva los clústeres para que las zonas de
  // liquidación sigan al calor y al precio actuales (en live lo hace el merge)
  const clusters = rolled
    ? deriveClusters(meta, candles, heat, heatMax, pMin, pMax, rand)
    : s.clusters;

  // CVD
  const cvd = s.cvd.slice();
  if (rolled) { cvd.shift(); cvd.push(cvd[cvd.length - 1]); }
  cvd[cvd.length - 1] = cvd[cvd.length - 2] + last.delta;

  // libro / spoofing / funding / OI: solo se "mueven" en modo simulado.
  // En live se conservan intactos los datos reales entre refrescos de la API.
  let bids = s.bids, asks = s.asks, imbalance = s.imbalance, spoofing = s.spoofing;
  let funding = s.funding, oi = s.oi, oiDelta1h = s.oiDelta1h, longShortRatio = s.longShortRatio;
  if (withDrift) {
    const jitterBook = (levels: BookLevel[], dirUp: boolean): BookLevel[] => {
      let total = 0;
      return levels.map((lv, i) => {
        const size = lv.size * (0.965 + rand() * 0.075) + (rand() < 0.02 ? meta.bookBase * (2 + rand() * 4) : 0);
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
  latency.push(
    opts.latencyMs != null
      ? Math.max(2, Math.min(240, opts.latencyMs + (rand() - 0.5) * 4))
      : 7 + rand() * 30 + (rand() < 0.06 ? 40 + rand() * 60 : 0)
  );
  if (latency.length > 44) latency.shift();

  return {
    ...s,
    candles,
    clusters,
    heat,
    heatMax,
    pMin,
    pMax,
    cvd,
    bids,
    asks,
    imbalance,
    spoofing,
    funding,
    fundingNextMs: s.fundingNextMs <= 700 ? 8 * 3600_000 : s.fundingNextMs - 700,
    oi,
    oiDelta1h,
    longShortRatio,
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

// Aplica un tick real del websocket: rollover de vela cuando cruza el
// intervalo del timeframe y ajuste del rango visible. El delta/volumen del
// CVD ya no se estima aquí: proviene del stream aggTrade (applyTradeFlow),
// así que en vivo el CVD es 100% dato real y no se suma dos veces.
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
  if (rolled) {
    heat = new Float32Array(s.heat);
    heat.copyWithin(0, HEAT_BINS);
    for (let b = 0; b < HEAT_BINS; b++) heat[(CANDLE_COUNT - 1) * HEAT_BINS + b] = 0;
  }
  const cvd = s.cvd.slice();
  if (rolled) {
    cvd.shift();
    cvd.push(cvd[cvd.length - 1]);
  }
  cvd[cvd.length - 1] = cvd[cvd.length - 2] + candles[candles.length - 1].delta;

  let pMin = s.pMin, pMax = s.pMax;
  const span = pMax - pMin || 1;
  if (price < pMin + span * 0.05) pMin = price - span * 0.06;
  if (price > pMax - span * 0.05) pMax = price + span * 0.06;
  // re-ancla el calor si el rango de precios se expandió
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
  // re-ancla el calor a la nueva rejilla de precios antes de derivar clústeres,
  // para que las zonas y el radar coincidan con los niveles reales
  heat = rebinHeat(heat, s.pMin, s.pMax, lo - pad, hi + pad);
  let heatMax = 0;
  for (let i = 0; i < heat.length; i++) if (heat[i] > heatMax) heatMax = heat[i];
  if (heatMax <= 0) heatMax = s.heatMax || 1;
  // re-deriva los clústeres sobre la ventana actualizada para que el radar,
  // la lista de zonas y el market-maker path no queden obsoletos
  const clusters = deriveClusters(
    s.meta, candles, heat, heatMax, lo - pad, hi + pad,
    mulberry32((Date.now() ^ 0x5f356495) >>> 0)
  );
  return { ...s, candles, heat, heatMax, cvd, clusters, pMin: lo - pad, pMax: hi + pad };
}

// Incorpora flujo REAL de trades (delta comprador/vendedor en USD) a la vela actual
export function applyTradeFlow(s: MarketState, deltaUsd: number): MarketState {
  if (!Number.isFinite(deltaUsd) || deltaUsd === 0) return s;
  const candles = s.candles.slice();
  const last = { ...candles[candles.length - 1] };
  last.delta += deltaUsd;
  last.v += Math.abs(deltaUsd);
  candles[candles.length - 1] = last;
  const cvd = s.cvd.slice();
  cvd[cvd.length - 1] = cvd[cvd.length - 2] + last.delta;
  return { ...s, candles, cvd };
}

// Inyecta liquidaciones REALES (OKX) al inicio del feed y acumula los totales 24h
export function injectLiqEvents(s: MarketState, evts: LiquidationEvent[]): MarketState {
  if (!evts.length) return s;
  const events = [...evts, ...s.events].slice(0, 44);
  let totalLiq24hLong = s.totalLiq24hLong;
  let totalLiq24hShort = s.totalLiq24hShort;
  for (const e of evts) {
    if (e.side === "long") totalLiq24hLong += e.qtyUsd;
    else totalLiq24hShort += e.qtyUsd;
  }
  return { ...s, events, totalLiq24hLong, totalLiq24hShort };
}
