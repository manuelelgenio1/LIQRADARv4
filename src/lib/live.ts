// ============================================================
// LIQRADAR v2 — cliente de datos en vivo (Binance market data)
// REST: data-api.binance.vision  ·  WS: data-stream.binance.vision
// Futuros (funding/OI): fapi.binance.com — con fallback simulado
// ============================================================

import type { BookLevel, Candle } from "./market";

export interface TickerInfo {
  symbol: string;
  price: number;
  change24h: number;
}

export interface RawDepth {
  bids: [string, string][];
  asks: [string, string][];
}

export interface FundingOI {
  funding: number;   // %
  nextMs: number;    // ms hasta el próximo funding
  oi: number;        // USD (NaN si no disponible)
}

const REST = "https://data-api.binance.vision/api/v3";
const FAPI = "https://fapi.binance.com/fapi/v1";
const WS_BASE = "wss://data-stream.binance.vision/stream?streams=";

async function getJSON(url: string, timeoutMs = 6000): Promise<any> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    window.clearTimeout(t);
  }
}

export function toBinanceInterval(tfKey: string): string {
  return tfKey === "1H" ? "1h" : tfKey === "4H" ? "4h" : tfKey;
}

/** Velas reales (klines). delta estimado con el volumen comprador (taker buy). */
export async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const raw: any[][] = await getJSON(`${REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, 7000);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("klines vacías");
  return raw.map((k) => {
    const v = parseFloat(k[5]);
    const buy = parseFloat(k[9]);
    const up = parseFloat(k[4]) >= parseFloat(k[1]);
    return {
      t: k[0] as number,
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
      v,
      delta: Number.isFinite(buy) ? buy * 2 - v : v * (up ? 0.42 : -0.42),
    };
  });
}

/** Libro de órdenes real (depth snapshot). */
export async function fetchDepth(symbol: string): Promise<RawDepth> {
  const d = await getJSON(`${REST}/depth?symbol=${symbol}&limit=20`, 5000);
  if (!Array.isArray(d.bids) || !Array.isArray(d.asks)) throw new Error("depth inválido");
  return { bids: d.bids.slice(0, 15), asks: d.asks.slice(0, 15) };
}

/** Funding rate + próximo funding + open interest (mercado de futuros). */
export async function fetchFundingOi(symbol: string): Promise<FundingOI | null> {
  const [prem, oi] = await Promise.allSettled([
    getJSON(`${FAPI}/premiumIndex?symbol=${symbol}`, 5000),
    getJSON(`${FAPI}/openInterest?symbol=${symbol}`, 5000),
  ]);
  if (prem.status !== "fulfilled") return null;
  const p = prem.value;
  const funding = parseFloat(p.lastFundingRate) * 100;
  const nextMs = (Number(p.nextFundingTime) || 0) - Date.now();
  let oiUsd = NaN;
  if (oi.status === "fulfilled") {
    const qty = parseFloat(oi.value.openInterest);
    const mark = parseFloat(p.markPrice);
    if (Number.isFinite(qty) && Number.isFinite(mark)) oiUsd = qty * mark;
  }
  if (!Number.isFinite(funding)) return null;
  return { funding, nextMs, oi: oiUsd };
}

/** Convierte un depth real al formato del libro agregado (con muros y spoofing). */
export function depthToState(d: RawDepth): {
  bids: BookLevel[];
  asks: BookLevel[];
  imbalance: number;
  spoofing: number;
} {
  const mk = (rows: [string, string][]): BookLevel[] => {
    let total = 0;
    return rows.map(([p, q]) => {
      const size = parseFloat(q);
      total += size;
      return { price: parseFloat(p), size, total, exchange: "Binance", isWall: false };
    });
  };
  const bids = mk(d.bids);
  const asks = mk(d.asks);
  const median = (arr: BookLevel[]) => {
    const sorted = arr.map((l) => l.size).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 1;
  };
  const tagWalls = (arr: BookLevel[]) => {
    const m = median(arr);
    for (const l of arr) l.isWall = l.size > m * 3;
  };
  tagWalls(bids);
  tagWalls(asks);
  const bidSum = bids[bids.length - 1]?.total ?? 1;
  const askSum = asks[asks.length - 1]?.total ?? 1;
  const imbalance = (bidSum - askSum) / (bidSum + askSum);
  const all = [...bids, ...asks];
  const biggest = all.reduce((m, l) => (l.size > m.size ? l : m), all[0]);
  const base = median(all);
  const spoofing = Math.min(95, Math.max(8, Math.round(18 + (biggest.size / base) * 8 + Math.abs(imbalance) * 55)));
  return { bids, asks, imbalance, spoofing };
}

/** WebSocket combinado: miniTicker de todos los símbolos, con reconexión. */
export function connectTickers(symbols: string[], onMsg: (t: TickerInfo) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/");

  const open = () => {
    if (closed) return;
    try {
      ws = new WebSocket(`${WS_BASE}${streams}`);
    } catch {
      retry = window.setTimeout(open, 3000);
      return;
    }
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string);
        const d = m.data ?? m;
        if (d && d.s && d.c && d.o) {
          const price = parseFloat(d.c);
          const openP = parseFloat(d.o);
          onMsg({
            symbol: d.s as string,
            price,
            change24h: ((price - openP) / openP) * 100,
          });
        }
      } catch {
        /* mensaje no numérico: ignorar */
      }
    };
    ws.onclose = () => {
      if (!closed) retry = window.setTimeout(open, 2500);
    };
    ws.onerror = () => {
      ws?.close();
    };
  };

  open();
  return () => {
    closed = true;
    window.clearTimeout(retry);
    ws?.close();
  };
}
