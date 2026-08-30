import type { MarketState } from "../lib/market";
import { fmtPct, fmtPrice, fmtUsd } from "../lib/format";

interface Props { state: MarketState; }

const PHASES = [
  { n: "01", t: "Acumulación", d: "El precio comprime en rango mientras se absorben órdenes minoristas." },
  { n: "02", t: "Barrido de liquidez", d: "Stop-hunt hacia el clúster objetivo para llenar órdenes institucionales." },
  { n: "03", t: "Reversión", d: "Con la liquidez capturada, el precio revierte con volumen direccional." },
];

export default function MarketMakerPanel({ state }: Props) {
  const cur = state.candles[state.candles.length - 1].c;
  const target = state.clusters[0];

  if (!target) return null;

  const dist = ((target.price - cur) / cur) * 100;
  const up = target.price > cur;
  const confidence = Math.round(38 + target.strength * 52);
  const phase = Math.abs(dist) < 0.55 ? 2 : Math.abs(dist) < 1.4 ? 1 : 0;
  const col = up ? "#ff5d7e" : "#2de0c0";

  return (
    <section className="panel panel-corner anim-reveal flex h-full flex-col" style={{ animationDelay: "0.42s" }}>
      <header className="flex items-center gap-3 border-b border-ink-700/50 px-4 py-3">
        <div className="leading-none">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.16em] text-mist-100">Market maker path</h2>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-500">ruta estimada de liquidez</p>
        </div>
        <span
          className="ml-auto border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest"
          style={{ color: col, borderColor: `${col}66`, background: `${col}14` }}
        >
          {up ? "↑ barrido alto" : "↓ barrido bajo"}
        </span>
      </header>

      <div className="grid flex-1 grid-cols-[110px_1fr] gap-4 px-4 py-4">
        {/* escalera de liquidez */}
        <div className="relative">
          <svg viewBox="0 0 90 210" className="h-full w-full" preserveAspectRatio="none">
            <line x1="8" y1="105" x2="82" y2="105" stroke="#dbe6f7" strokeWidth="1.4" />
            <text x="10" y="99" fill="#8fa3c4" fontSize="8" fontFamily="IBM Plex Mono, monospace">SPOT</text>
            <text x="10" y="117" fill="#dbe6f7" fontSize="8.5" fontWeight="600" fontFamily="IBM Plex Mono, monospace">
              {fmtPrice(cur, state.meta.decimals)}
            </text>

            <line x1="8" y1={up ? 22 : 188} x2="82" y2={up ? 22 : 188} stroke={col} strokeWidth="2" />
            <text x="10" y={up ? 16 : 204} fill={col} fontSize="8" fontFamily="IBM Plex Mono, monospace">
              {fmtUsd(target.sizeUsd)}
            </text>

            <line
              x1="45" y1="105" x2="45" y2={up ? 26 : 184}
              stroke={col} strokeWidth="1.6" strokeDasharray="5 7"
              style={{ animation: "dashFlow 1.1s linear infinite" }}
            />
            <circle cx="45" cy={up ? 26 : 184} r="4" fill={col}>
              <animate attributeName="r" values="3;5;3" dur="1.6s" repeatCount="indefinite" />
            </circle>
          </svg>
        </div>

        {/* fases */}
        <div className="flex flex-col justify-center gap-2.5">
          {PHASES.map((p, i) => {
            const active = i === phase;
            return (
              <div
                key={p.n}
                className={`border px-3 py-2 transition-all duration-500 ${
                  active ? "border-ink-600 bg-ink-800/80" : "border-ink-700/40 opacity-55"
                }`}
                style={active ? { boxShadow: `inset 3px 0 0 ${col}` } : undefined}
              >
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[9px] font-bold ${active ? "text-flare-300" : "text-mist-600"}`}>{p.n}</span>
                  <span className={`font-display text-[11px] font-bold uppercase tracking-wider ${active ? "text-mist-100" : "text-mist-500"}`}>
                    {p.t}
                  </span>
                  {active && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full" style={{ background: col, animation: "liveBlink 1.4s ease-out infinite" }} />
                  )}
                </div>
                {active && <p className="mt-1 font-mono text-[9px] leading-relaxed text-mist-500">{p.d}</p>}
              </div>
            );
          })}
        </div>
      </div>

      <footer className="grid grid-cols-3 divide-x divide-ink-700/50 border-t border-ink-700/50 bg-ink-900/50">
        <div className="px-3 py-2.5 text-center">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Objetivo</div>
          <div className="tick-num mt-0.5 font-mono text-[11px] font-bold text-mist-200">{fmtPrice(target.price, state.meta.decimals)}</div>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Distancia</div>
          <div className={`tick-num mt-0.5 font-mono text-[11px] font-bold ${up ? "text-short-300" : "text-long-300"}`}>{fmtPct(dist)}</div>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-mist-600">Confianza</div>
          <div className="tick-num mt-0.5 font-mono text-[11px] font-bold text-flare-300">{confidence}%</div>
        </div>
      </footer>
    </section>
  );
}
