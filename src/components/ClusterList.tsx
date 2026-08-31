import type { MarketState } from "../lib/market";
import { fmtPct, fmtPrice, fmtUsd } from "../lib/format";

interface Props { state: MarketState; market?: "perp" | "spot"; }

// El heatmap dibuja clusters.slice(0, 6) y el radar slice(0, 12) sobre el
// orden nativo (distancia al precio). La lista usa ESE mismo orden para que
// cada fila corresponda 1:1 con su línea del gráfico y su blip del radar.
const IN_CHART = 6;

export default function ClusterList({ state, market = "perp" }: Props) {
  const cur = state.candles[state.candles.length - 1].c;
  const clusters = state.clusters;
  const maxSize = Math.max(...clusters.map((c) => c.sizeUsd), 1);
  const magnetId = clusters.reduce((m, c) => (c.sizeUsd > m.sizeUsd ? c : m), clusters[0])?.id;
  const totalInRange = clusters.reduce((s, c) => s + c.sizeUsd, 0);
  const longs = clusters.filter((c) => c.side === "long").length;
  const shorts = clusters.length - longs;

  return (
    <section className="panel anim-reveal flex h-full flex-col" style={{ animationDelay: "0.24s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">
            Clústeres de liquidación
            <span className="tick-num border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-[9px] font-bold text-mist-300">
              {clusters.length}
            </span>
            <span
              className={`border px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-widest ${
                market === "perp"
                  ? "border-long-500/40 bg-long-900/40 text-long-300"
                  : "border-mist-500/40 bg-ink-800 text-mist-400"
              }`}
              title={
                market === "perp"
                  ? "Pools derivados del calor del PERPETUO de Binance Futuros"
                  : "Pools derivados del calor del mercado SPOT"
              }
            >
              {market}
            </span>
          </h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">
            <span className="text-long-300">{longs}↓</span> · <span className="text-short-300">{shorts}↑</span> ·{" "}
            <span className="text-flare-300">{fmtUsd(totalInRange)}</span> en rango · orden = distancia
          </p>
        </div>
        <svg className="ml-auto text-long-400" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2 L22 20 H2 Z" strokeLinejoin="round" />
          <line x1="12" y1="9" x2="12" y2="14" />
          <circle cx="12" cy="17" r="0.5" fill="currentColor" />
        </svg>
      </header>

      <div className="grid grid-cols-[44px_1fr_62px_70px_42px] items-center gap-2 border-b border-ink-700/40 px-4 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.16em] text-mist-600">
        <span>Lado</span><span>Precio / zona</span><span className="text-right">Dist.</span><span className="text-right">Nocional*</span><span className="text-right">Lev.</span>
      </div>

      <div className="scroll-slim max-h-[430px] min-h-0 flex-1 overflow-y-auto lg:max-h-none">
        {clusters.length === 0 && (
          <div className="flex h-32 items-center justify-center font-mono text-[10px] uppercase tracking-widest text-mist-600">
            detectando clústeres de liquidez…
          </div>
        )}
        {clusters.map((cl, i) => {
          const dist = ((cl.price - cur) / cur) * 100;
          const isLong = cl.side === "long";
          const isTarget = i === 0;
          const isMagnet = cl.id === magnetId;
          const inChart = i < IN_CHART;
          const w = (cl.sizeUsd / maxSize) * 100;
          return (
            <div
              key={cl.id}
              className={`group relative grid grid-cols-[44px_1fr_62px_70px_42px] items-center gap-2 border-b border-ink-700/25 px-4 py-[7px] transition-all duration-200 hover:bg-ink-750/60 ${
                isTarget ? "bg-ink-800/50" : ""
              }`}
              style={{ animation: `feedIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) ${Math.min(i * 30, 300)}ms both` }}
            >
              <div
                className="absolute inset-y-0 left-0 transition-all duration-700 group-hover:opacity-100"
                style={{
                  width: `${w * 0.35}%`,
                  opacity: 0.3,
                  background: isLong
                    ? "linear-gradient(90deg, rgba(45,224,192,0.28), transparent)"
                    : "linear-gradient(90deg, rgba(255,93,126,0.28), transparent)",
                }}
              />
              {isTarget && (
                <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 bg-flare-400 shadow-[0_0_10px_rgba(255,178,36,0.7)]" />
              )}

              <span
                className={`relative inline-flex w-fit items-center border px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider ${
                  isLong ? "border-long-500/40 bg-long-900/50 text-long-300" : "border-short-500/40 bg-short-900/50 text-short-300"
                }`}
              >
                {isLong ? "↓ L" : "↑ S"}
              </span>

              <div className="relative min-w-0 leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="tick-num font-mono text-[11.5px] font-semibold text-mist-200">
                    {fmtPrice(cl.price, state.meta.decimals)}
                  </span>
                  {isTarget && (
                    <span
                      className="flex items-center gap-1 border border-flare-400/50 bg-flare-400/10 px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider text-flare-300"
                      title="Objetivo del Market Maker Path (el clúster más cercano al precio)"
                    >
                      <span className="h-1 w-1 rounded-full bg-flare-400" style={{ animation: "liveBlink 1.4s ease-out infinite" }} />
                      objetivo
                    </span>
                  )}
                  {isMagnet && !isTarget && (
                    <span
                      className="border border-flare-400/40 px-1 py-px font-mono text-[7.5px] font-bold uppercase tracking-wider text-flare-300/90"
                      title="Imán de liquidez: el clúster con mayor nocional estimado del rango"
                    >
                      imán
                    </span>
                  )}
                  {inChart && (
                    <span
                      className="hidden border border-ink-600 px-1 py-px font-mono text-[7.5px] uppercase tracking-wider text-mist-500 sm:inline"
                      title="Este clúster tiene línea dibujada en el heatmap"
                    >
                      gráfico
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">{cl.exchange}</span>
                  <span className="h-1 w-14 overflow-hidden bg-ink-700/80">
                    <span
                      className={`block h-full transition-all duration-700 ${isLong ? "bg-long-400/80" : "bg-short-400/80"}`}
                      style={{ width: `${Math.round(cl.strength * 100)}%` }}
                    />
                  </span>
                  <span className="tick-num font-mono text-[8px] text-mist-600">{Math.round(cl.strength * 100)}%</span>
                </div>
              </div>

              <span className={`tick-num relative text-right font-mono text-[10.5px] ${isLong ? "text-long-300" : "text-short-300"}`}>
                {fmtPct(dist, 2)}
              </span>
              <span className="tick-num relative text-right font-mono text-[11px] font-bold text-flare-300">
                {fmtUsd(cl.sizeUsd)}
              </span>
              <span className="relative text-right font-mono text-[10px] font-semibold text-mist-300">{cl.leverage}</span>
            </div>
          );
        })}
      </div>

      <footer className="border-t border-ink-700/50 bg-ink-900/50 px-4 py-2.5">
        <p className="font-mono text-[9px] leading-relaxed text-mist-600">
          <span className="text-flare-300">◈</span> Misma fuente y orden que el heatmap (líneas), el radar (blips) y el
          Market Maker Path: <b className="text-mist-400">distancia al precio</b>. El <b className="text-flare-300">objetivo</b> es
          el pool más cercano; el <b className="text-flare-300">imán</b>, el de mayor nocional. *Tamaño estimado — los
          niveles son reales sobre velas del {market === "perp" ? "perpetuo" : "spot"}, el volumen no.
        </p>
      </footer>
    </section>
  );
}
