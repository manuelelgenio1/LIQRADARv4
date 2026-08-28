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
            {/* línea de precio actual */}
            <line x1="8" y1="105" x2="82" y2="105" stroke="#dbe6f7" strokeWidth="1.4" />
            <text x="10" y="99" fill="#8fa3c4" fontSize="8" fontFamily="IBM Plex Mono, monospace">SPOT</text>
            <text x="10" y="117" fill="#dbe6f7" fontSize="8.5" fontWeight="600" fontFamily="IBM Plex Mono, monospace">
              {fmtPrice(cur, state.meta.decimals)}
            </text>

            {/* objetivo */}
            <line x1="8" y1={up ? 22 : 188} x2="82" y2={up ? 22 : 188} stroke={col} strokeWidth="2" />
            <text x="10" y={up ? 16 : 204} fill={col} fontSize="8" fontFamily="IBM Plex Mono, monospace">
              {fmtUsd(target.sizeUsd)}
            </text>

            {/* ruta animada */}
            <line
              x1="45" y1="105" x2="45" y2={up ? 26 : 184}
              stroke={col} strokeWidth="1.6" strokeDasharray="5 7"
              style={{ animation: "dashFlow 1.1s linear infinite" }}
            />
            <path
              d={up ? "M45 26 l-5 8 h10 Z" : "M45 184 l-5 -8 h10 Z"}
              fill={col}
            />
            {/* niveles intermedios */}
            {state.clusters.slice(1, 5).map((c, i) => {
              const cUp = c.price > cur;
              const y = cUp ? 105 - (20 + i * 18) : 105 + (20 + i * 18);
              return (
                <g key={c.id} opacity="0.55">
                  <line x1="20" y1={y} x2="70" y2={y} stroke={cUp ? "#ff5d7e" : "#2de0c0"} strokeWidth="1" strokeDasharray="2 3" />
                </g>
              );
            })}
          </svg>
        </div>

        {/* narrativa + fases */}
        <div className="flex flex-col">
          <p className="font-body text-[12.5px] leading-relaxed text-mist-300">
            El radar detecta <span className="font-semibold" style={{ color: col }}>{fmtUsd(target.sizeUsd)}</span> en
            liquidaciones {target.side === "long" ? "long" : "short"} a{" "}
            <span className="tick-num font-mono text-mist-100">{fmtPrice(target.price, state.meta.decimals)}</span>{" "}
            (<span className={`tick-num font-mono ${dist >= 0 ? "text-short-300" : "text-long-300"}`}>{fmtPct(dist)}</span>).
            Es el imán de liquidez más probable para la próxima expansión.
          </p>

          <div className="mt-3 space-y-2">
            {PHASES.map((p, i) => {
              const active = i === phase;
              const done = i < phase;
              return (
                <div
                  key={p.n}
                  className={`flex gap-3 border px-3 py-2 transition-all duration-500 ${
                    active
                      ? "border-long-500/50 bg-long-900/25 shadow-[0_0_18px_rgba(45,224,192,0.08)]"
                      : done
                        ? "border-ink-700/40 bg-ink-850/40 opacity-60"
                        : "border-ink-700/40 bg-ink-850/40"
                  }`}
                >
                  <span className={`font-display text-xs font-bold ${active ? "text-long-300" : "text-mist-600"}`}>{p.n}</span>
                  <div>
                    <div className={`font-display text-[11.5px] font-semibold uppercase tracking-wider ${active ? "text-mist-100" : "text-mist-400"}`}>
                      {p.t} {active && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-long-400 align-middle" style={{ animation: "liveBlink 1.4s ease-out infinite" }} />}
                    </div>
                    {active && <div className="mt-0.5 font-body text-[10.5px] leading-snug text-mist-500">{p.d}</div>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-auto pt-3">
            <div className="mb-1 flex justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-mist-600">
              <span>Confianza del modelo</span>
              <span className="tick-num font-bold text-flare-300">{confidence}%</span>
            </div>
            <div className="h-1.5 overflow-hidden bg-ink-800">
              <div
                className="h-full transition-all duration-700"
                style={{ width: `${confidence}%`, background: "linear-gradient(90deg, #2de0c0, #ffb224)" }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
