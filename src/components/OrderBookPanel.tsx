import type { BookLevel, MarketState } from "../lib/market";
import { fmtPrice } from "../lib/format";

interface Props { state: MarketState; live: boolean; }

function Row({ lv, max, side, decimals }: { lv: BookLevel; max: number; side: "bid" | "ask"; decimals: number }) {
  const w = Math.min(100, (lv.total / max) * 100);
  const col = side === "bid" ? "rgba(45,224,192,0.16)" : "rgba(255,93,126,0.16)";
  const border = side === "bid" ? "rgba(45,224,192,0.75)" : "rgba(255,93,126,0.75)";
  return (
    <div className="group relative flex items-center gap-2 px-3 py-[3px] font-mono text-[10.5px] transition-colors hover:bg-ink-750/60">
      <div className="absolute inset-y-0 right-0" style={{ width: `${w}%`, background: col }} />
      {lv.isWall && (
        <span className="absolute inset-y-[3px] left-0 w-[3px]" style={{ background: border, boxShadow: `0 0 8px ${border}` }} />
      )}
      <span className={`tick-num relative w-[86px] shrink-0 ${side === "bid" ? "text-long-300" : "text-short-300"}`}>
        {fmtPrice(lv.price, decimals)}
      </span>
      <span className="tick-num relative flex-1 text-right text-mist-300">
        {lv.size >= 1e6 ? (lv.size / 1e6).toFixed(2) + "M" : lv.size >= 1000 ? (lv.size / 1000).toFixed(1) + "K" : lv.size.toFixed(1)}
      </span>
      <span className="tick-num relative w-[64px] shrink-0 text-right text-mist-500">
        {lv.total >= 1e6 ? (lv.total / 1e6).toFixed(1) + "M" : lv.total >= 1000 ? (lv.total / 1000).toFixed(0) + "K" : lv.total.toFixed(0)}
      </span>
      <span className={`relative w-[52px] shrink-0 text-right text-[8.5px] uppercase tracking-wider ${lv.isWall ? "font-bold text-flare-300" : "text-mist-600"}`}>
        {lv.isWall ? "▮ muro" : lv.exchange.slice(0, 5)}
      </span>
    </div>
  );
}

export default function OrderBookPanel({ state, live }: Props) {
  const { bids, asks, meta, imbalance, spoofing } = state;
  const maxTotal = Math.max(bids[bids.length - 1].total, asks[asks.length - 1].total);
  const mid = (bids[0].price + asks[0].price) / 2;
  const spread = ((asks[0].price - bids[0].price) / mid) * 100;
  const bidPct = 50 + imbalance * 50;

  const spoofLabel = spoofing < 35 ? { t: "BAJO", c: "text-long-300 border-long-500/40 bg-long-900/40" }
    : spoofing < 65 ? { t: "MEDIO", c: "text-flare-300 border-flare-400/40 bg-flare-400/10" }
    : { t: "ALTO", c: "text-short-300 border-short-500/40 bg-short-900/50" };

  return (
    <section className="panel anim-reveal flex h-full flex-col" style={{ animationDelay: "0.18s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Libro {live ? "en vivo" : "agregado"}
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {live ? "depth real · binance spot" : "binance · bybit · okx"}
          </p>
        </div>
        <span className={`ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest ${spoofLabel.c}`}>
          spoofing {spoofLabel.t}
        </span>
      </header>

      <div className="grid grid-cols-[86px_1fr_64px_52px] gap-2 border-b border-ink-700/40 px-3 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.18em] text-mist-600">
        <span>Precio</span><span className="text-right">Tamaño</span><span className="text-right">Σ Total</span><span className="text-right">Fuente</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
        {asks.slice(0, 8).reverse().map((lv, i) => (
          <Row key={`a${i}`} lv={lv} max={maxTotal} side="ask" decimals={meta.decimals} />
        ))}

        <div className="flex items-center gap-3 border-y border-ink-700/60 bg-ink-900/80 px-3 py-2">
          <span className={`tick-num font-display text-lg font-bold ${imbalance >= 0 ? "text-long-300" : "text-short-300"}`}>
            {fmtPrice(mid, meta.decimals)}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-mist-600">spread {spread.toFixed(3)}%</span>
          <span className={`ml-auto font-mono text-[9px] font-semibold uppercase tracking-widest ${imbalance >= 0 ? "text-long-300" : "text-short-300"}`}>
            {imbalance >= 0 ? "presión bid" : "presión ask"}
          </span>
        </div>

        {bids.slice(0, 8).map((lv, i) => (
          <Row key={`b${i}`} lv={lv} max={maxTotal} side="bid" decimals={meta.decimals} />
        ))}
      </div>

      {/* desequilibrio */}
      <footer className="border-t border-ink-700/50 px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">
          <span>Desequilibrio del libro</span>
          <span className={`tick-num font-bold ${imbalance >= 0 ? "text-long-300" : "text-short-300"}`}>
            {imbalance >= 0 ? "+" : ""}{(imbalance * 100).toFixed(1)}%
          </span>
        </div>
        <div className="relative h-2 overflow-hidden bg-ink-800">
          <div
            className="absolute inset-y-0 left-0 transition-all duration-700"
            style={{
              width: `${bidPct}%`,
              background: "linear-gradient(90deg, rgba(45,224,192,0.25), #2de0c0)",
            }}
          />
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
