import type { MarketState } from "../lib/market";
import { fmtPct, fmtPrice, fmtUsd } from "../lib/format";

interface Props { state: MarketState; }

export default function ClusterList({ state }: Props) {
  const cur = state.candles[state.candles.length - 1].c;
  const maxSize = Math.max(...state.clusters.map((c) => c.sizeUsd), 1);
  const clusters = [...state.clusters].sort((a, b) => b.sizeUsd - a.sizeUsd);

  return (
    <section className="panel anim-reveal flex h-full flex-col" style={{ animationDelay: "0.24s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">Clústeres de liquidación</h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            {clusters.length} piscinas detectadas · est. nocional
          </p>
        </div>
        <svg className="ml-auto text-long-400" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2 L22 20 H2 Z" strokeLinejoin="round" />
          <line x1="12" y1="9" x2="12" y2="14" />
          <circle cx="12" cy="17" r="0.5" fill="currentColor" />
        </svg>
      </header>

      <div className="grid grid-cols-[52px_1fr_74px_56px_52px] items-center gap-2 border-b border-ink-700/40 px-4 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">
        <span>Lado</span><span>Precio / zona</span><span className="text-right">Dist.</span><span className="text-right">Nocional</span><span className="text-right">Lev.</span>
      </div>

      <div className="scroll-slim flex-1 overflow-y-auto">
        {clusters.map((cl, i) => {
          const dist = ((cl.price - cur) / cur) * 100;
          const isLong = cl.side === "long";
          const w = (cl.sizeUsd / maxSize) * 100;
          return (
            <div
              key={cl.id}
              className="group relative grid grid-cols-[52px_1fr_74px_56px_52px] items-center gap-2 border-b border-ink-700/25 px-4 py-[7px] transition-colors hover:bg-ink-750/50"
            >
              <div
                className="absolute inset-y-0 left-0 transition-all duration-500 group-hover:opacity-100"
                style={{
                  width: `${w * 0.35}%`,
                  opacity: 0.35,
                  background: isLong
                    ? "linear-gradient(90deg, rgba(45,224,192,0.28), transparent)"
                    : "linear-gradient(90deg, rgba(255,93,126,0.28), transparent)",
                }}
              />
              <span
                className={`relative inline-flex w-fit items-center gap-1 border px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider ${
                  isLong ? "border-long-500/40 bg-long-900/50 text-long-300" : "border-short-500/40 bg-short-900/50 text-short-300"
                }`}
              >
                {isLong ? "↓ L" : "↑ S"}
              </span>
              <div className="relative leading-tight">
                <div className="tick-num font-mono text-[11.5px] font-semibold text-mist-200">
                  {fmtPrice(cl.price, state.meta.decimals)}
                </div>
                <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">
                  {cl.exchange} · fuerza {(cl.strength * 100).toFixed(0)}%
                </div>
              </div>
              <span className={`tick-num relative text-right font-mono text-[10.5px] ${dist < 0 ? "text-short-300" : "text-long-300"}`}>
                {fmtPct(dist, 2)}
              </span>
              <span className="tick-num relative text-right font-mono text-[11px] font-bold text-flare-300">
                {fmtUsd(cl.sizeUsd)}
              </span>
              <span className="relative text-right font-mono text-[10px] text-mist-400">{cl.leverage}</span>
              {i === 0 && (
                <span className="absolute -left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 bg-flare-400 shadow-[0_0_10px_rgba(255,178,36,0.7)]" />
              )}
            </div>
          );
        })}
      </div>

      <footer className="border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5">
        <p className="font-mono text-[9px] leading-relaxed text-mist-600">
          <span className="text-flare-300">◈</span> El mayor clúster actúa como imán de liquidez: los market makers suelen
          barrer esas zonas antes de revertir la dirección.
        </p>
      </footer>
    </section>
  );
}
