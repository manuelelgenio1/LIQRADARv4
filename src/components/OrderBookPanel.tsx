import { useEffect, useState } from "react";
import type { BookLevel, MarketState } from "../lib/market";
import type { MarketKind } from "../lib/live";
import { fmtPrice } from "../lib/format";

interface Props { state: MarketState; live: boolean; market?: MarketKind; }

function fmtQty(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(1);
}

function Row({ lv, max, side, decimals, source }: { lv: BookLevel; max: number; side: "bid" | "ask"; decimals: number; source: string }) {
  const w = max > 0 ? Math.min(100, (lv.total / max) * 100) : 0;
  const col = side === "bid" ? "rgba(45,224,192,0.16)" : "rgba(255,93,126,0.16)";
  const border = side === "bid" ? "rgba(45,224,192,0.75)" : "rgba(255,93,126,0.75)";
  return (
    <div className="group relative flex items-center gap-2 px-3 py-[3px] font-mono text-[10.5px] transition-colors hover:bg-ink-750/60">
      <div className="absolute inset-y-0 right-0 transition-[width] duration-500 ease-out" style={{ width: `${w}%`, background: col }} />
      {lv.isWall && (
        <span className="absolute inset-y-[3px] left-0 w-[3px]" style={{ background: border, boxShadow: `0 0 8px ${border}` }}
          title="Muro: orden ≥2.8× el tamaño mediano del nivel" />
      )}
      <span className={`tick-num relative w-[86px] shrink-0 ${side === "bid" ? "text-long-300" : "text-short-300"}`}>{fmtPrice(lv.price, decimals)}</span>
      <span className="tick-num relative flex-1 text-right text-mist-300">{fmtQty(lv.size)}</span>
      <span className="tick-num relative w-[64px] shrink-0 text-right text-mist-500">{fmtQty(lv.total)}</span>
      <span className={`relative w-[52px] shrink-0 text-right text-[8.5px] uppercase tracking-wider ${lv.isWall ? "font-bold text-flare-300" : "text-mist-600"}`}>
        {lv.isWall ? "▮ muro" : source}
      </span>
    </div>
  );
}

export default function OrderBookPanel({ state, live, market = "perp" }: Props) {
  const { bids, asks, meta, imbalance, spoofing } = state;
  const snapId = bids.length && asks.length ? `${bids[0].price}:${bids[0].size}:${asks[0].size}` : "";
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!live || !snapId) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 550);
    return () => window.clearTimeout(t);
  }, [snapId, live]);

  if (!bids.length || !asks.length) {
    return (
      <section className="panel anim-reveal flex h-full flex-col" style={{ animationDelay: "0.28s" }}>
        <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">Libro {live ? "en vivo" : "agregado"}</h2>
        </header>
        <div className="flex flex-1 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-mist-600">recibiendo profundidad…</div>
      </section>
    );
  }

  const maxTotal = Math.max(bids[bids.length - 1].total, asks[asks.length - 1].total);
  const mid = (bids[0].price + asks[0].price) / 2;
  const spread = mid > 0 ? ((asks[0].price - bids[0].price) / mid) * 100 : 0;
  const bidPct = Math.max(0, Math.min(100, 50 + imbalance * 50));
  const rowSource = live ? (market === "perp" ? "futuros" : "spot") : "";
  const spoofLabel = spoofing < 35 ? { t: "BAJO", c: "text-long-300 border-long-500/40 bg-long-900/40" }
    : spoofing < 65 ? { t: "MEDIO", c: "text-flare-300 border-flare-400/40 bg-flare-400/10" }
    : { t: "ALTO", c: "text-short-300 border-short-500/40 bg-short-900/50" };

  return (
    <section className="panel anim-reveal flex h-full flex-col" style={{ animationDelay: "0.28s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Libro {live ? "en vivo" : "agregado"}
            {live && (
              <span className={`h-1.5 w-1.5 rounded-full bg-long-400 transition-opacity duration-300 ${flash ? "opacity-100" : "opacity-30"}`}
                style={{ boxShadow: flash ? "0 0 8px rgba(45,224,192,0.8)" : "none" }} title="Parpadea con cada snapshot nuevo del depth" />
            )}
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {live ? `depth real · binance ${market === "perp" ? "futuros" : "spot"} · 1.5 s` : "binance · bybit · okx"}
          </p>
        </div>
        <span className={`ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${spoofLabel.c}`}
          title="Riesgo estimado de spoofing: muros grandes vs. profundidad y desequilibrio">
          spoofing {spoofLabel.t}
        </span>
      </header>

      <div className="grid grid-cols-[86px_1fr_64px_52px] gap-2 border-b border-ink-700/40 px-3 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
        <span>Precio</span><span className="text-right">Tamaño</span><span className="text-right">Σ Total</span><span className="text-right">Fuente</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
        {asks.slice(0, 8).reverse().map((lv, i) => (
          <Row key={`a${i}`} lv={lv} max={maxTotal} side="ask" decimals={meta.decimals} source={rowSource || lv.exchange} />
        ))}
        <div className={`flex items-center gap-3 border-y border-ink-700/60 bg-ink-900/80 px-3 py-2 transition-shadow duration-500 ${flash ? "shadow-[inset_0_0_18px_rgba(45,224,192,0.12)]" : ""}`}>
          <span className={`tick-num font-display text-lg font-bold ${imbalance >= 0 ? "text-long-300" : "text-short-300"}`}>{fmtPrice(mid, meta.decimals)}</span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">spread {spread.toFixed(3)}%</span>
          <span className="hidden font-mono text-[9px] text-mist-500 sm:inline">
            <span className="text-long-300">b {fmtQty(bids[0].size)}</span>
            <span className="mx-1 text-ink-600">·</span>
            <span className="text-short-300">a {fmtQty(asks[0].size)}</span>
          </span>
          <span className={`ml-auto font-mono text-[9px] font-semibold uppercase tracking-widest ${imbalance >= 0 ? "text-long-300" : "text-short-300"}`}>
            {imbalance >= 0 ? "presión bid" : "presión ask"}
          </span>
        </div>
        {bids.slice(0, 8).map((lv, i) => (
          <Row key={`b${i}`} lv={lv} max={maxTotal} side="bid" decimals={meta.decimals} source={rowSource || lv.exchange} />
        ))}
      </div>

      <footer className="border-t border-ink-700/50 px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">
          <span>Desequilibrio del libro</span>
          <span className={`tick-num font-bold ${imbalance >= 0 ? "text-long-300" : "text-short-300"}`}>
            {imbalance >= 0 ? "+" : ""}{(imbalance * 100).toFixed(1)}%
          </span>
        </div>
        <div className="relative h-2 overflow-hidden bg-ink-800">
          <div className="absolute inset-y-0 left-0 transition-all duration-700" style={{ width: `${bidPct}%`, background: "linear-gradient(90deg, rgba(45,224,192,0.25), #2de0c0)" }} />
          <div className="absolute inset-y-0 left-1/2 w-px bg-mist-200/70" />
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
          <span className="text-short-400">asks</span>
          <span>bids</span>
        </div>
      </footer>
    </section>
  );
}
