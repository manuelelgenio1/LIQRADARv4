import type { MarketState } from "../lib/market";
import { fmtClock, fmtPrice, fmtUsd } from "../lib/format";

interface Props { state: MarketState; paused: boolean; liqSource?: "okx" | "sim"; }

export default function LiquidationFeed({ state, paused, liqSource = "sim" }: Props) {
  const { events, meta } = state;
  const sessionTotal = events.reduce((s, e) => s + e.qtyUsd, 0);
  // La distinción real/estimado usa el campo isReal del evento, NO el exchange:
  // el modelo puede nombrar "OKX" en un evento inventado.
  const realCount = events.filter((e) => e.isReal).length;
  const hasReal = realCount > 0;

  return (
    <section className="panel anim-reveal flex h-full flex-col" style={{ animationDelay: "0.48s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <span
          className={`h-2.5 w-2.5 rounded-full ${paused ? "bg-flare-400" : "bg-short-400"}`}
          style={{ animation: paused ? "none" : "liveBlink 1.3s ease-out infinite" }}
        />
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Liquidaciones {hasReal ? "reales" : "en vivo"}
            {hasReal && (
              <span className="flex items-center gap-1 border border-long-500/50 bg-long-900/40 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest text-long-300">
                <span className="h-1 w-1 animate-pulse rounded-full bg-long-400" />
                OKX en vivo
              </span>
            )}
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {events.length} eventos · {fmtUsd(sessionTotal)} ·{" "}
            {hasReal ? `${realCount} reales + modelo` : "estimadas por modelo"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 font-mono text-[9px] uppercase tracking-widest text-mist-600">
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-long-400" />long</span>
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 bg-short-400" />short</span>
        </div>
      </header>

      <div className="scroll-slim min-h-[320px] flex-1 overflow-y-auto lg:min-h-0">
        {events.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="text-ink-600">
              <circle cx="20" cy="20" r="16" stroke="currentColor" strokeWidth="1.5" />
              <path d="M20 20 L20 6 A14 14 0 0 1 32 13 Z" fill="currentColor" opacity="0.4" />
            </svg>
            <p className="font-mono text-[10px] uppercase tracking-widest text-mist-600">
              {paused ? "feed en pausa — reanuda para capturar eventos" : "escaneando el radar…"}
            </p>
          </div>
        )}
        {events.map((e, i) => {
          const isLong = e.side === "long";
          const big = e.qtyUsd > meta.liqScale * 1e6 * 0.12;
          return (
            <div
              key={e.id}
              className={`relative flex items-center gap-2 border-b border-ink-700/25 px-3 py-[7px] transition-colors hover:bg-ink-750/50 ${i === 0 ? "anim-feed-in" : ""}`}
            >
              <span className="tick-num shrink-0 font-mono text-[9px] text-mist-600">{fmtClock(e.time)}</span>
              <span
                className={`shrink-0 border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider ${
                  isLong ? "border-long-500/40 bg-long-900/50 text-long-300" : "border-short-500/40 bg-short-900/50 text-short-300"
                }`}
              >
                {isLong ? "L" : "S"}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="shrink-0 font-mono text-[10.5px] font-semibold text-mist-300">{e.symbol.replace("USDT", "")}</span>
                <span className="tick-num truncate font-mono text-[9.5px] text-mist-500">@ {fmtPrice(e.price, meta.decimals)}</span>
              </span>
              {e.isReal ? (
                <span
                  className="shrink-0 border border-long-500/50 bg-long-900/50 px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider text-long-300"
                  title="Liquidación REAL recibida por el websocket de OKX"
                >
                  REAL
                </span>
              ) : (
                <span
                  className="shrink-0 border border-ink-700 bg-ink-800 px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider text-mist-500"
                  title="Estimación del modelo (Binance no publica su stream de liquidaciones)"
                >
                  EST
                </span>
              )}
              <span className={`tick-num shrink-0 font-mono text-[11px] font-bold ${big ? "text-flare-300" : "text-mist-200"}`}>
                {fmtUsd(e.qtyUsd)}
              </span>
              {big && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 bg-flare-400 shadow-[0_0_8px_rgba(255,178,36,0.7)]" />
              )}
            </div>
          );
        })}
      </div>

      <footer className="flex items-center justify-between border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5 font-mono text-[9px] uppercase tracking-widest text-mist-600">
        <span>umbral ballena: {fmtUsd(meta.liqScale * 1e6 * 0.12)}</span>
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-flare-400" : "bg-long-400"}`} />
          {paused ? "buffer congelado" : liqSource === "okx" ? "okx ws + modelo" : "streaming ws"}
        </span>
      </footer>
    </section>
  );
}
