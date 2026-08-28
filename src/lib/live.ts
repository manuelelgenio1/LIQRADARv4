// ============================================================
// Cliente de datos en vivo de Binance (mercado público, sin clave)
// REST para velas/libro/funding · WebSocket para precio en vivo
// ============================================================
import type { BookLevel, Candle } from "./market";

const REST = "https://data-api.binance.vision/api/v3";
const WS = "wss://data-stream.binance.vision/stream?streams=";

const withTimeout = (ms: number) => {
  const c = new AbortController();
  window.setTimeout(() => c.abort(), ms);
  return c.signal;
};

export interface TickerInfo {
  symbol: string;
  price: number;
  change24h: number;
}

export interface BookData {
  bids: BookLevel[];
  asks: BookLevel[];
  imbalance: number;
  spoofing: number;
}

export interface FundingOi {
  funding: number;
  nextMs: number;
  oi: number;
}

const INTERVAL_MAP: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w",
};

export function toBinanceInterval(tfKey: string): string {
  return INTERVAL_MAP[tfKey] ?? "5m";
}

// ---------- velas reales ----------
export async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const r = await fetch(`${REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {
    signal: withTimeout(9000),
  });
  if (!r.ok) throw new Error(`klines ${r.status}`);
  const raw = (await r.json()) as unknown[];
  return raw.map((k) => {
    const a = k as (string | number)[];
    const v = Number(a[5]) || 0;
    const tb = Number(a[9]) || 0;
    return {
      t: Number(a[0]),
      o: Number(a[1]),
      h: Number(a[2]),
      l: Number(a[3]),
      c: Number(a[4]),
      v,
      delta: v > 0 ? tb * 2 - v : 0,
    };
  });
}

// ---------- libro de órdenes real (spot, 15 niveles) ----------
export async function fetchDepth(symbol: string): Promise<BookData> {
  const r = await fetch(`${REST}/depth?symbol=${symbol}&limit=20`, { signal: withTimeout(9000) });
  if (!r.ok) throw new Error(`depth ${r.status}`);
  const j = (await r.json()) as { bids: [string, string][]; asks: [string, string][] };

  const mk = (rows: [string, string][]): BookLevel[] => {
    let total = 0;
    return rows.slice(0, 15).map(([p, q]) => {
      const size = Number(q);
      total += size;
      return { price: Number(p), size, total, exchange: "Binance", isWall: false };
    });
  };
  const bids = mk(j.bids);
  const asks = mk(j.asks);

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

  const bidSum = bids[bids.length - 1]?.total ?? 0;
  const askSum = asks[asks.length - 1]?.total ?? 0;
  const imbalance = bidSum + askSum > 0 ? (bidSum - askSum) / (bidSum + askSum) : 0;

  const maxWall = [...bids, ...asks].reduce((m, l) => (l.size > m.size ? l : m), bids[0]);
  const wallMed = med([...bids, ...asks].map((l) => l.size));
  const raw = (maxWall.size / Math.max(wallMed, 1e-9)) * 9 + Math.abs(imbalance) * 34 + 14;
  const spoofing = Math.min(96, Math.max(6, Math.round(raw)));

  return { bids, asks, imbalance, spoofing };
}

// ---------- funding + open interest (futuros USDⓈ-M) ----------
export async function fetchFundingOi(symbol: string): Promise<FundingOi | null> {
  const [pf, po] = await Promise.allSettled([
    fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: withTimeout(9000) }),
    fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, { signal: withTimeout(9000) }),
  ]);

  let funding = NaN;
  let nextMs = NaN;
  if (pf.status === "fulfilled" && pf.value.ok) {
    const j = (await pf.value.json()) as { lastFundingRate?: string; nextFundingTime?: number };
    funding = Number(j.lastFundingRate) * 100;
    nextMs = Number(j.nextFundingTime) - Date.now();
  }
  let oi = NaN;
  if (po.status === "fulfilled" && po.value.ok) {
    const j = (await po.value.json()) as { openInterest?: string };
    oi = Number(j.openInterest);
  }
  if (!Number.isFinite(funding) && !Number.isFinite(oi)) return null;
  return {
    funding: Number.isFinite(funding) ? funding : 0,
    nextMs: Number.isFinite(nextMs) ? nextMs : 0,
    oi,
  };
}

export function depthToState(d: BookData) {
  return { bids: d.bids, asks: d.asks, imbalance: d.imbalance, spoofing: d.spoofing };
}

// ---------- websocket de precios (miniTicker, todos los símbolos) ----------
export function connectTickers(
  symbols: string[],
  onTick: (t: TickerInfo) => void
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const open = () => {
    if (closed) return;
    const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/");
    ws = new WebSocket(WS + streams);
    ws.onopen = () => {
      retry = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const j = JSON.parse(ev.data as string) as {
          data?: { s: string; c: string; P: string };
        };
        const d = j.data;
        if (d?.s && d.c) {
          onTick({ symbol: d.s, price: Number(d.c), change24h: Number(d.P) });
        }
      } catch {
        /* mensaje malformado: se ignora */
      }
    };
    ws.onclose = () => {
      if (!closed) {
        retry += 1;
        window.setTimeout(open, Math.min(15000, 1200 * retry));
      }
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ya cerrado */
      }
    };
  };
  open();

  return () => {
    closed = true;
    try {
      ws?.close();
    } catch {
      /* ya cerrado */
    }
  };
}
