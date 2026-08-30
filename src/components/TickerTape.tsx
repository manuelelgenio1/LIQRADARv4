import { useEffect, useRef, useState } from "react";
import { SYMBOLS } from "../lib/market";
import type { TickerInfo } from "../lib/live";
import { fmtPct, fmtPrice } from "../lib/format";

interface TapeItem {
  base: string;
  price: number;
  change: number;
  decimals: number;
  vol: number;
}

export default function TickerTape({ livePrices, paused }: { livePrices: Record<string, TickerInfo>; paused: boolean }) {
  const [items, setItems] = useState<TapeItem[]>(() =>
    SYMBOLS.map((s) => ({
      base: s.base,
      price: s.basePrice * (1 + (Math.random() - 0.5) * 0.01),
      change: (Math.random() - 0.45) * 7,
      decimals: s.decimals,
      vol: s.vol,
    }))
  );

  // refs para que el intervalo sea estable (no se recrea con cada tick del ws)
  const liveRef = useRef(livePrices);
  liveRef.current = livePrices;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // respaldo simulado mientras el websocket no entrega datos
  useEffect(() => {
    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      setItems((prev) =>
        prev.map((it, i) => {
          const live = liveRef.current[SYMBOLS[i].symbol];
          if (live) return { ...it, price: live.price, change: live.change24h };
          const drift = (Math.random() - 0.5) * it.vol * 2.2;
          return {
            ...it,
            price: it.price * (1 + drift),
            change: Math.max(-14, Math.min(14, it.change + drift * 100 * 0.35)),
          };
        })
      );
    }, 1600);
    return () => window.clearInterval(id);
  }, []);

  const row = (keyPrefix: string) =>
    items.map((it) => {
      const up = it.change >= 0;
      return (
        <div key={`${keyPrefix}-${it.base}`} className="flex shrink-0 items-center gap-2 px-5">
          <span className="font-mono text-[10px] font-semibold tracking-widest text-mist-400">{it.base}</span>
          <span className="tick-num font-mono text-[11px] text-mist-200">{fmtPrice(it.price, it.decimals)}</span>
          <span className={`tick-num font-mono text-[10px] font-semibold ${up ? "text-long-400" : "text-short-400"}`}>
            {up ? "▲" : "▼"} {fmtPct(it.change)}
          </span>
          <svg width="4" height="4" viewBox="0 0 4 4" className="ml-3 text-ink-600">
            <circle cx="2" cy="2" r="1.6" fill="currentColor" />
          </svg>
        </div>
      );
    });

  return (
    <div className="relative overflow-hidden border-b border-ink-700/50 bg-ink-900/70">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-ink-950 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-ink-950 to-transparent" />
      <div className="ticker-track flex w-max items-center py-2" style={paused ? { animationPlayState: "paused" } : undefined}>
        {row("a")}
        {row("b")}
      </div>
    </div>
  );
}
